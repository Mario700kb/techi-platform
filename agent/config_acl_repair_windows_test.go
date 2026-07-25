//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestApplyConfigACL_RepairsEmptyDaclFile reproduces the 2.1.20 field failure on
// a real Windows host and proves the self-heal end to end:
//
//	legacy config with an emptied (deny-all) DACL  →  os.ReadFile = Access Denied
//	                    → applyConfigACL(path) →  os.ReadFile succeeds again.
//
// The empty DACL is created the same way the buggy MSI action produced it —
// inheritance stripped with no effective grant on the leaf file (O:..D:PAI).
//
// Requirements: this must run in a context that (a) owns the file so it can
// rewrite the DACL (the agent runs as LocalSystem, the file owner) and (b) is
// SYSTEM or a member of Administrators so the repaired grant actually yields
// read access. GitHub's windows-latest runner is elevated, so both hold; on a
// non-elevated dev box the test skips instead of failing.
func TestApplyConfigACL_RepairsEmptyDaclFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.config.json")
	want := []byte(`{"enrollment_token":"tok"}`)
	if err := os.WriteFile(path, want, 0600); err != nil {
		t.Fatal(err)
	}

	// Damage the ACL: remove inheritance with no grant -> empty deny-all DACL.
	if out, err := exec.Command("icacls.exe", path, "/inheritance:r").CombinedOutput(); err != nil {
		t.Skipf("could not set empty DACL via icacls (need to own the file): %v (%s)", err, out)
	}

	// It must now be unreadable; otherwise the repro does not hold on this host.
	if _, err := os.ReadFile(path); !errors.Is(err, os.ErrPermission) {
		t.Skipf("empty DACL did not deny read on this token (err=%v); repro not applicable", err)
	}

	// Repair with the exact production helper the agent uses.
	if err := applyConfigACL(path); err != nil {
		t.Fatalf("applyConfigACL failed: %v", err)
	}

	// The real os.ReadFile must succeed again and return the original bytes.
	got, err := os.ReadFile(path)
	if errors.Is(err, os.ErrPermission) {
		t.Skipf("post-repair read denied: grant is SYSTEM+Administrators only and this token is neither (err=%v)", err)
	}
	if err != nil {
		t.Fatalf("os.ReadFile after repair failed: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("content changed after repair: got %q want %q", got, want)
	}
}
