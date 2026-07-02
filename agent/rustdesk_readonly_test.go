package main

import (
	"os"
	"path/filepath"
	"testing"
)

// canEnforceReadOnly sanity-checks that the OS (or user running tests)
// actually honours read-only on regular files. Root and some CI runners
// bypass permission bits -- skip the enforcement tests in those envs.
func canEnforceReadOnly(t *testing.T) bool {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "rdonly-probe-*")
	if err != nil {
		t.Fatal(err)
	}
	path := f.Name()
	f.Close()
	if err := os.Chmod(path, 0444); err != nil {
		return false
	}
	err = os.WriteFile(path, []byte("probe"), 0644)
	_ = os.Chmod(path, 0644)
	return err != nil // read-only IS enforced when write fails
}

// TestSetTomlReadOnlyPreventsRustDeskOverwrite is the core unit test:
// after the agent patches a TOML file and sets it read-only, a subsequent
// write attempt (simulating RustDesk restarting and trying to overwrite
// its config) must fail.
func TestSetTomlReadOnlyPreventsRustDeskOverwrite(t *testing.T) {
	if !canEnforceReadOnly(t) {
		t.Skip("OS or user does not enforce read-only on regular files (root?)")
	}

	path := filepath.Join(t.TempDir(), "TECHI Remote Support.toml")
	want := "[options]\ncustom-rendezvous-server = '139.162.158.208'\nkey = 'abc'\n"

	if err := os.WriteFile(path, []byte(want), 0644); err != nil {
		t.Fatal(err)
	}

	// Agent sets read-only after repair.
	setTomlReadOnly(path)

	// RustDesk service restarts and tries to overwrite -- must be blocked.
	err := os.WriteFile(path, []byte("[options]\n"), 0644)
	if err == nil {
		t.Fatal("WriteFile to read-only TOML succeeded; expected EPERM/EACCES")
	}

	// Content must be unchanged.
	got, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("ReadFile: %v", readErr)
	}
	if string(got) != want {
		t.Errorf("content changed despite read-only\ngot:  %q\nwant: %q", string(got), want)
	}
}

// TestRemoveTomlReadOnlyAllowsAgentWrite verifies that removeTomlReadOnly
// restores write access so the agent can perform the next repair.
func TestRemoveTomlReadOnlyAllowsAgentWrite(t *testing.T) {
	if !canEnforceReadOnly(t) {
		t.Skip("OS or user does not enforce read-only on regular files (root?)")
	}

	path := filepath.Join(t.TempDir(), "TECHI Remote Support.toml")
	if err := os.WriteFile(path, []byte("initial\n"), 0444); err != nil {
		t.Fatal(err)
	}

	removeTomlReadOnly(path)

	want := "[options]\ncustom-rendezvous-server = '139.162.158.208'\n"
	if err := os.WriteFile(path, []byte(want), 0644); err != nil {
		t.Fatalf("WriteFile after removeTomlReadOnly failed: %v", err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != want {
		t.Errorf("content mismatch: got %q, want %q", string(got), want)
	}
}

// TestRepairCycleTwoRounds verifies the removeReadOnly→patch→setReadOnly
// sequence works correctly across two consecutive repair cycles, which is
// the steady-state on servers with high repair counts.
func TestRepairCycleTwoRounds(t *testing.T) {
	if !canEnforceReadOnly(t) {
		t.Skip("OS or user does not enforce read-only on regular files (root?)")
	}

	path := filepath.Join(t.TempDir(), "TECHI Remote Support.toml")
	round1 := "[options]\ncustom-rendezvous-server = '139.162.158.208'\n"

	if err := os.WriteFile(path, []byte(round1), 0644); err != nil {
		t.Fatal(err)
	}

	// Round 1: patch + set read-only.
	setTomlReadOnly(path)

	got1, _ := os.ReadFile(path)
	if string(got1) != round1 {
		t.Errorf("round 1: content mismatch: got %q", string(got1))
	}

	// Round 2: remove read-only, apply another patch, set read-only again.
	removeTomlReadOnly(path)
	round2 := "[options]\ncustom-rendezvous-server = '139.162.158.208'\nkey = 'newkey'\n"
	if err := os.WriteFile(path, []byte(round2), 0644); err != nil {
		t.Fatalf("round 2 write failed: %v", err)
	}
	setTomlReadOnly(path)

	got2, _ := os.ReadFile(path)
	if string(got2) != round2 {
		t.Errorf("round 2: content mismatch: got %q, want %q", string(got2), round2)
	}

	// File must be read-only again after round 2.
	if err := os.WriteFile(path, []byte("wiped\n"), 0644); err == nil {
		t.Fatal("expected read-only to be restored after round 2, but write succeeded")
	}
}

// TestSetTomlReadOnlyNoopOnMissingFile verifies that calling setTomlReadOnly
// on a non-existent path only logs (does not panic or propagate).
func TestSetTomlReadOnlyNoopOnMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nonexistent.toml")
	setTomlReadOnly(path)    // must not panic
	removeTomlReadOnly(path) // must not panic
}
