//go:build windows

package native

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

// The safe zip extraction lives in bundle.go (ExtractZipFileSafe) so the
// packager and executor share one hardened extractor. This file keeps only the
// Windows-specific ACL restriction and hidden-exec helpers.

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
	_, err := runHiddenOut(name, args...)
	return err
}

// runHiddenOut is globally bounded so a stuck system utility cannot hold the
// recovery lock or leave a transaction half-complete indefinitely.
func runHiddenOut(name string, args ...string) (string, error) {
	if !filepath.IsAbs(name) {
		return "", fmt.Errorf("refusing to run non-absolute program: %s", name)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &windows.SysProcAttr{HideWindow: true}
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return string(out), fmt.Errorf("%s timed out after 30s", filepath.Base(name))
	}
	if err != nil {
		return string(out), fmt.Errorf("%s failed: %v: %s", filepath.Base(name), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}
