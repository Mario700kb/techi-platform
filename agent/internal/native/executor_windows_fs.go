//go:build windows

package native

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// extractZipSafe extracts src into dest with zip-slip protection (every entry
// must resolve under dest via SafeJoinUnder) and reparse-point rejection. It
// never sets executable-from-TEMP: dest is an already-safe staging dir.
func extractZipSafe(src, dest string) error {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		// Reject absolute/escape/UNC names outright.
		target, err := SafeJoinUnder(dest, f.Name)
		if err != nil {
			return fmt.Errorf("unsafe zip entry %q: %w", f.Name, err)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		if isReparsePoint(filepath.Dir(target)) {
			return fmt.Errorf("refusing to write through a reparse point: %s", target)
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			rc.Close()
			return err
		}
		// Bound decompression to a sane per-file cap to resist zip bombs.
		if _, err := io.Copy(out, io.LimitReader(rc, 512<<20)); err != nil {
			out.Close()
			rc.Close()
			return err
		}
		out.Close()
		rc.Close()
	}
	return nil
}

// copyTreeSafe copies a directory payload into dest, guarding every path with
// SafeJoinUnder and skipping reparse points.
func copyTreeSafe(src, dest string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		// Single-file payload: copy under dest by base name.
		target, err := SafeJoinUnder(dest, filepath.Base(src))
		if err != nil {
			return err
		}
		return copyFile(src, target)
	}
	return filepath.Walk(src, func(path string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if fi.Mode()&os.ModeSymlink != 0 || isReparsePoint(path) {
			return nil // never copy through reparse points
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target, err := SafeJoinUnder(dest, rel)
		if err != nil {
			return err
		}
		if fi.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		return copyFile(path, target)
	})
}

func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// restrictACL restricts dir to SYSTEM + Administrators using icacls (a standard
// Windows tool; no PowerShell -EncodedCommand). Inheritance is removed so the
// staging tree is not world-writable.
func restrictACL(dir string) error {
	icacls := filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe")
	if err := runHidden(icacls, dir, "/inheritance:r"); err != nil {
		return err
	}
	if err := runHidden(icacls, dir, "/grant:r", "*S-1-5-18:(OI)(CI)F"); err != nil { // SYSTEM
		return err
	}
	return runHidden(icacls, dir, "/grant:r", "*S-1-5-32-544:(OI)(CI)F") // Administrators
}

// runHidden runs an absolute-path Windows command with no visible window and no
// shell. It refuses a non-absolute program path so nothing is resolved via PATH.
func runHidden(name string, args ...string) error {
	if !filepath.IsAbs(name) {
		return fmt.Errorf("refusing to run non-absolute program: %s", name)
	}
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &windows.SysProcAttr{HideWindow: true}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s failed: %v: %s", filepath.Base(name), err, strings.TrimSpace(string(out)))
	}
	return nil
}
