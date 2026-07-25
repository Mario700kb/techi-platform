package main

import (
	"bytes"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withRepairSeam swaps the config-recovery seam for the duration of a test and
// restores it afterwards, so the Windows-only ACL-repair flow can be exercised
// deterministically on any host.
func withRepairSeam(t *testing.T, repair func(string) error) {
	t.Helper()
	orig := repairConfigACL
	repairConfigACL = repair
	t.Cleanup(func() { repairConfigACL = orig })
}

// captureLogs redirects the standard logger to a buffer for the test.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	origOut, origFlags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(origOut)
		log.SetFlags(origFlags)
	})
	return &buf
}

func failRepair(t *testing.T) func(string) error {
	t.Helper()
	return func(string) error { t.Fatalf("repairConfigACL must not be called"); return nil }
}

func TestReadLegacyConfig_ReadableFileTakesFastPath(t *testing.T) {
	withRepairSeam(t, failRepair(t))
	path := filepath.Join(t.TempDir(), "agent.config.json")
	want := []byte(`{"enrollment_token":"tok"}`)
	if err := os.WriteFile(path, want, 0600); err != nil {
		t.Fatal(err)
	}

	got, err := readLegacyConfigForMigration(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestReadLegacyConfig_MissingFileNoRepair(t *testing.T) {
	withRepairSeam(t, failRepair(t))
	path := filepath.Join(t.TempDir(), "does-not-exist.json")

	_, err := readLegacyConfigForMigration(path)
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected not-exist error, got %v", err)
	}
}

func TestReadLegacyConfig_MalformedJSONNotAnACLProblem(t *testing.T) {
	// Malformed content is still readable at this layer: it must be returned as
	// bytes (loadConfig rejects it later), never treated as a permission fault.
	withRepairSeam(t, failRepair(t))
	path := filepath.Join(t.TempDir(), "agent.config.json")
	want := []byte(`{not valid json`)
	if err := os.WriteFile(path, want, 0600); err != nil {
		t.Fatal(err)
	}

	got, err := readLegacyConfigForMigration(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %q want %q", got, want)
	}
}

// makeUnreadable creates a file the current process cannot read and returns
// whether the denial actually took effect (root bypasses mode bits).
func makeUnreadable(t *testing.T, path string, content []byte) bool {
	t.Helper()
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0600) })
	_, err := os.ReadFile(path)
	return errors.Is(err, os.ErrPermission)
}

func TestReadLegacyConfig_PermissionTriggersExactlyOneRepairThenRetries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.config.json")
	secret := []byte(`{"enrollment_token":"SUPERSECRET-do-not-log"}`)
	if !makeUnreadable(t, path, secret) {
		t.Skip("host does not enforce mode bits for this user (running as root?)")
	}

	calls := 0
	withRepairSeam(t, func(p string) error {
		calls++
		if p != path {
			t.Fatalf("repair targeted %q, want %q", p, path)
		}
		// Simulate a successful scoped ACL repair.
		return os.Chmod(p, 0600)
	})
	buf := captureLogs(t)

	got, err := readLegacyConfigForMigration(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(got, secret) {
		t.Fatalf("got %q want %q", got, secret)
	}
	if calls != 1 {
		t.Fatalf("expected exactly one repair attempt, got %d", calls)
	}
	if strings.Contains(buf.String(), "SUPERSECRET") {
		t.Fatalf("config secret leaked into logs:\n%s", buf.String())
	}
}

func TestReadLegacyConfig_RepairFailsReturnsActionableError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.config.json")
	secret := []byte(`{"enrollment_token":"SUPERSECRET-do-not-log"}`)
	if !makeUnreadable(t, path, secret) {
		t.Skip("host does not enforce mode bits for this user (running as root?)")
	}

	withRepairSeam(t, func(string) error { return errors.New("repair denied") })
	buf := captureLogs(t)

	_, err := readLegacyConfigForMigration(path)
	if err == nil {
		t.Fatal("expected an error when repair fails")
	}
	if !errors.Is(err, os.ErrPermission) {
		t.Fatalf("wrapped error must preserve the permission cause, got %v", err)
	}
	for _, want := range []string{"access denied", path} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q missing %q", err.Error(), want)
		}
	}
	// The file must remain untouched (still unreadable) — repair failing must
	// not corrupt it further.
	if _, rerr := os.ReadFile(path); !errors.Is(rerr, os.ErrPermission) {
		t.Fatalf("file should remain unreadable after failed repair; read err=%v", rerr)
	}
	if strings.Contains(buf.String(), "SUPERSECRET") {
		t.Fatalf("config secret leaked into logs:\n%s", buf.String())
	}
}

func TestReadLegacyConfig_RepairSucceedsButFileStillUnreadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.config.json")
	if !makeUnreadable(t, path, []byte(`{"enrollment_token":"x"}`)) {
		t.Skip("host does not enforce mode bits for this user (running as root?)")
	}

	// Repair reports success but does not actually restore access (e.g. a
	// pathological ACL). The retry read must still fail with an actionable error.
	withRepairSeam(t, func(string) error { return nil })

	_, err := readLegacyConfigForMigration(path)
	if err == nil {
		t.Fatal("expected an error when the retry read still fails")
	}
	if !errors.Is(err, os.ErrPermission) {
		t.Fatalf("wrapped error must preserve the permission cause, got %v", err)
	}
	if !strings.Contains(err.Error(), "after scoped ACL repair") {
		t.Fatalf("error %q should mention the post-repair retry", err.Error())
	}
}

func TestReadLegacyConfig_RepeatedExecutionIsIdempotent(t *testing.T) {
	withRepairSeam(t, failRepair(t))
	path := filepath.Join(t.TempDir(), "agent.config.json")
	want := []byte(`{"enrollment_token":"tok"}`)
	if err := os.WriteFile(path, want, 0600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		got, err := readLegacyConfigForMigration(path)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("iteration %d: got %q err %v", i, got, err)
		}
	}
}
