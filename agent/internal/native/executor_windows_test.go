//go:build windows

package native

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

const testConfigSecurityDescriptor = "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)"

func withNativeSetNamedSecurityInfo(t *testing.T, fn func(string, windows.SE_OBJECT_TYPE, windows.SECURITY_INFORMATION, *windows.SID, *windows.SID, *windows.ACL, *windows.ACL) error) {
	t.Helper()
	old := setNamedSecurityInfoFunc
	setNamedSecurityInfoFunc = fn
	t.Cleanup(func() { setNamedSecurityInfoFunc = old })
}

func TestNativeRestoreFileSecurityDescriptorOwnerFallbackDACLFailureFails(t *testing.T) {
	withNativeSetNamedSecurityInfo(t, func(_ string, _ windows.SE_OBJECT_TYPE, info windows.SECURITY_INFORMATION, _ *windows.SID, _ *windows.SID, _ *windows.ACL, _ *windows.ACL) error {
		if info&(windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION) != 0 {
			return windows.ERROR_INVALID_OWNER
		}
		return windows.ERROR_ACCESS_DENIED
	})

	if _, err := restoreFileSecurityDescriptor(`C:\x.toml`, testConfigSecurityDescriptor); err != windows.ERROR_ACCESS_DENIED {
		t.Fatalf("err = %v", err)
	}
}

func TestPreservedSecurityMatchesRequiresDACLUnderOwnerFallback(t *testing.T) {
	want := "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)"
	sameDACL := "O:SYG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)"
	differentDACL := "O:SYG:BAD:P(A;;FA;;;SY)"

	if !preservedSecurityMatches(want, sameDACL, true, false) {
		t.Fatal("owner fallback should allow owner drift when DACL and group match")
	}
	if preservedSecurityMatches(want, differentDACL, true, false) {
		t.Fatal("owner fallback must not allow DACL drift")
	}
}

func TestPreservedSecurityMatchesRequiresGroupUnlessGroupFallback(t *testing.T) {
	want := "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)"
	differentGroup := "O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)"

	if preservedSecurityMatches(want, differentGroup, true, false) {
		t.Fatal("owner fallback alone must not allow group drift")
	}
	if !preservedSecurityMatches(want, differentGroup, true, true) {
		t.Fatal("group fallback should allow group drift when DACL matches")
	}
}

func TestNativeRestorePreservedConfigOwnerFallbackLeavesAgentConfigUntouched(t *testing.T) {
	dir := t.TempDir()
	rsPath := filepath.Join(dir, "TECHI Remote Support2.toml")
	rsBackup := filepath.Join(dir, "backup.toml")
	agentPath := filepath.Join(dir, "agent.config.json")
	rsData := []byte("id = '123456789'\n[options]\nkey = 'k'\n")
	agentData := []byte(`{"device_id":11}`)
	if err := os.WriteFile(rsPath, rsData, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rsBackup, rsData, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(agentPath, agentData, 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(rsPath)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := HashFileSHA256(rsPath)
	if err != nil {
		t.Fatal(err)
	}

	withNativeSetNamedSecurityInfo(t, func(_ string, _ windows.SE_OBJECT_TYPE, info windows.SECURITY_INFORMATION, _ *windows.SID, _ *windows.SID, _ *windows.ACL, _ *windows.ACL) error {
		if info&windows.OWNER_SECURITY_INFORMATION != 0 {
			return windows.ERROR_INVALID_OWNER
		}
		return nil
	})

	exec := &windowsExecutor{preserved: []configBackup{{
		path: rsPath, backup: rsBackup, sha256: hash, mode: info.Mode().Perm(), mtime: info.ModTime(), sddl: testConfigSecurityDescriptor,
	}}}
	if _, err := exec.RestoreConfig(ExecuteParams{}); err != nil {
		t.Fatal(err)
	}
	if !exec.preserved[0].ownerFallback || exec.preserved[0].groupFallback {
		t.Fatalf("fallback = owner:%t group:%t", exec.preserved[0].ownerFallback, exec.preserved[0].groupFallback)
	}
	gotAgent, err := os.ReadFile(agentPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotAgent) != string(agentData) {
		t.Fatalf("agent config changed: %q", gotAgent)
	}
}
