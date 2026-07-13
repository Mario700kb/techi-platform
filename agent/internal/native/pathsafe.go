package native

import (
	"fmt"
	"path/filepath"
	"strings"
)

// StagingRootWindows is the only permitted staging root on endpoints. Newly
// downloaded/copied payloads are executed and promoted from here — never from
// %TEMP%. ACLs on this tree are restricted to SYSTEM + Administrators by the
// Windows wiring layer.
const StagingRootWindows = `C:\ProgramData\TechiAgent\staging`

// SafeJoinUnder joins rel under root and guarantees the result stays inside
// root after cleaning. It defends the staging/promotion paths against `..`
// escapes, absolute overrides, and (on Windows) drive-relative tricks. The
// caller passes an already-trusted root; rel is the untrusted component.
func SafeJoinUnder(root, rel string) (string, error) {
	root = strings.TrimSpace(root)
	rel = strings.TrimSpace(rel)
	if root == "" {
		return "", fmt.Errorf("empty root")
	}
	if rel == "" {
		return "", fmt.Errorf("empty relative path")
	}
	// Reject anything that is not a pure relative component up front. filepath
	// on the host OS won't catch a Windows-style absolute path when tests run
	// on Linux, so screen both separators explicitly.
	if filepath.IsAbs(rel) || strings.HasPrefix(rel, `\`) || strings.HasPrefix(rel, "/") {
		return "", fmt.Errorf("relative path %q must not be absolute", rel)
	}
	if hasDriveLetter(rel) || strings.HasPrefix(rel, `\\`) {
		return "", fmt.Errorf("relative path %q must not be a drive or UNC path", rel)
	}
	// The host filepath separator differs across OSes (tests run on Linux,
	// targets are Windows), so screen for a ".." segment against BOTH separators
	// rather than relying on filepath.Clean to collapse it.
	for _, seg := range strings.FieldsFunc(rel, func(r rune) bool { return r == '/' || r == '\\' }) {
		if seg == ".." {
			return "", fmt.Errorf("relative path %q must not contain a .. segment", rel)
		}
	}

	cleanRoot := filepath.Clean(root)
	joined := filepath.Clean(filepath.Join(cleanRoot, rel))

	// Compare with a trailing separator so /a/root-evil is not accepted as
	// being under /a/root.
	rootWithSep := cleanRoot
	if !strings.HasSuffix(rootWithSep, string(filepath.Separator)) {
		rootWithSep += string(filepath.Separator)
	}
	if !strings.EqualFold(joined, cleanRoot) && !strings.HasPrefix(strings.ToLower(joined), strings.ToLower(rootWithSep)) {
		return "", fmt.Errorf("path %q escapes root %q", joined, cleanRoot)
	}
	return joined, nil
}

// hasDriveLetter reports whether s begins with a Windows drive letter such as
// "C:". Needed because filepath.IsAbs on Linux does not recognise it.
func hasDriveLetter(s string) bool {
	if len(s) < 2 {
		return false
	}
	c := s[0]
	return s[1] == ':' && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))
}

// StagingPath returns the canonical staging directory for a component/version:
//
//	C:\ProgramData\TechiAgent\staging\<component>\<version>\
//
// component and version are validated as bare tokens so they cannot introduce
// separators. root is injectable so tests use a temp dir instead of C:\.
func StagingPath(root, component, version string) (string, error) {
	if err := validateToken(component); err != nil {
		return "", fmt.Errorf("component: %w", err)
	}
	if err := validateToken(version); err != nil {
		return "", fmt.Errorf("version: %w", err)
	}
	dir, err := SafeJoinUnder(root, component)
	if err != nil {
		return "", err
	}
	return SafeJoinUnder(dir, version)
}

// validateToken permits only characters that are safe as a single path
// segment: letters, digits, dot, dash, underscore.
func validateToken(tok string) error {
	tok = strings.TrimSpace(tok)
	if tok == "" {
		return fmt.Errorf("empty token")
	}
	for _, r := range tok {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.' || r == '-' || r == '_':
		default:
			return fmt.Errorf("token %q contains illegal character %q", tok, r)
		}
	}
	if strings.Contains(tok, "..") {
		return fmt.Errorf("token %q must not contain ..", tok)
	}
	return nil
}

// IsRefusedInstallTarget rejects promotion/termination targets that must never
// be treated as a component install directory: filesystem roots, Windows and
// System32, and empty/relative paths. It is the last-line guard before any
// destructive file operation.
func IsRefusedInstallTarget(path string) bool {
	p := strings.TrimSpace(path)
	if p == "" {
		return true
	}
	if !filepath.IsAbs(p) && !hasDriveLetter(p) && !strings.HasPrefix(p, `\\`) {
		return true // must be absolute
	}
	lower := strings.ToLower(strings.ReplaceAll(p, "/", `\`))
	lower = strings.TrimRight(lower, `\`)
	switch lower {
	case "", "c:", `c:\windows`, `c:\windows\system32`, `c:\program files`, `c:\program files (x86)`, `c:\programdata`:
		return true
	}
	// A bare drive root like "d:" (after trimming) is refused above; also refuse
	// a path with fewer than two segments below the drive.
	return false
}
