//go:build windows

package main

import (
	"fmt"
	"log"
	"time"
)

// Wire the cross-platform config-recovery seam (paths.go) to the real Windows
// implementation. The scoped legacy-config ACL repair reuses applyConfigACL, so
// the repair and the normal per-file lockdown can never drift apart.
func init() {
	repairConfigACL = applyConfigACL
}

// applyConfigACL restricts a single config FILE to SYSTEM + Administrators only
// (by SID, locale-independent), since the config file contains plaintext secrets
// (enrollment_token, rustdesk_key, rustdesk_default_password) and Go's
// os.WriteFile permission bits are ignored entirely on Windows.
//
// It targets exactly one file: no /T recursion and NO (OI)(CI) inheritance flags
// — those are container-only and, applied to a leaf file, make icacls skip the
// grant while still stripping inheritance, leaving an empty deny-all DACL. This
// is the same class of bug the MSI LockdownTechiDataDir action hit before 2.1.20.
// The grant reuses this exact, file-safe form so the two never diverge again.
func applyConfigACL(path string) error {
	out, err := runWithTimeout(10*time.Second, "icacls.exe", path,
		"/inheritance:r",
		"/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F",
	)
	if err != nil {
		return fmt.Errorf("icacls lockdown for %s failed: %w (%s)", path, err, string(out))
	}
	return nil
}

// lockdownConfigACL is the best-effort wrapper used on every config rewrite: it
// applies the secure ACL and only logs on failure (the caller has already
// written the file).
func lockdownConfigACL(path string) {
	if err := applyConfigACL(path); err != nil {
		log.Printf("[config] %v", err)
	}
}
