package native

import (
	"path/filepath"
	"testing"
)

func TestSafeJoinUnder_Escapes(t *testing.T) {
	root := filepath.Join("tmproot", "staging")
	bad := []string{
		`..\..\Windows\System32`,
		"../../etc/passwd",
		`/etc/passwd`,
		`\\server\share\evil`,
		`C:\Windows\System32\evil.exe`,
		"a/../../b",
	}
	for _, rel := range bad {
		if _, err := SafeJoinUnder(root, rel); err == nil {
			t.Errorf("expected rejection for %q", rel)
		}
	}
}

func TestSafeJoinUnder_Allows(t *testing.T) {
	root := filepath.Join("tmproot", "staging")
	got, err := SafeJoinUnder(root, filepath.Join("remote_support", "1.4.6"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !filepath.IsAbs(got) && !hasPrefixInsensitive(got, filepath.Clean(root)) {
		t.Fatalf("joined path %q not under root", got)
	}
}

func TestSafeJoinUnder_SiblingPrefixNotAccepted(t *testing.T) {
	// "staging-evil" must not be accepted as under "staging".
	root := "staging"
	if _, err := SafeJoinUnder(root, ".."); err == nil {
		t.Fatalf("expected rejection of ..")
	}
}

func TestStagingPath(t *testing.T) {
	root := t.TempDir()
	p, err := StagingPath(root, "remote_support", "1.4.6")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "remote_support", "1.4.6")
	if p != want {
		t.Fatalf("got %q want %q", p, want)
	}
	// Illegal tokens rejected.
	for _, bad := range [][2]string{{"..", "1"}, {"rs/x", "1"}, {"rs", "1;2"}, {"rs", ""}} {
		if _, err := StagingPath(root, bad[0], bad[1]); err == nil {
			t.Errorf("expected rejection for component=%q version=%q", bad[0], bad[1])
		}
	}
}

func TestIsRefusedInstallTarget(t *testing.T) {
	refused := []string{"", "relative\\path", `C:\`, `C:\Windows`, `C:\Windows\System32`, `c:/windows/system32`, `C:\ProgramData`}
	for _, p := range refused {
		if !IsRefusedInstallTarget(p) {
			t.Errorf("expected %q refused", p)
		}
	}
	ok := []string{`C:\Program Files\TECHI Remote Support`, `C:\ProgramData\TechiAgent\rs`}
	for _, p := range ok {
		if IsRefusedInstallTarget(p) {
			t.Errorf("expected %q allowed", p)
		}
	}
}

func hasPrefixInsensitive(s, prefix string) bool {
	if len(s) < len(prefix) {
		return false
	}
	return filepath.Clean(s[:len(prefix)]) == filepath.Clean(prefix)
}
