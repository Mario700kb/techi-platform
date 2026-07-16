//go:build windows

package native

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

const testConfigSecurityDescriptor = "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)"

func withRemoteSupportUISessionTest(
	t *testing.T,
	session func() (interactiveSessionInfo, bool, error),
	probe func(uint32, string, bool) error,
) {
	t.Helper()
	oldSession := interactiveUserSession
	oldProbe := runUIProbeInSession
	interactiveUserSession = session
	runUIProbeInSession = probe
	t.Cleanup(func() {
		interactiveUserSession = oldSession
		runUIProbeInSession = oldProbe
	})
}

func TestNativeStartUIUsesActiveInteractiveSession(t *testing.T) {
	var gotSession uint32
	var gotLaunch bool
	withRemoteSupportUISessionTest(t,
		func() (interactiveSessionInfo, bool, error) {
			return interactiveSessionInfo{id: 7, username: `DOMAIN\User`, sid: "S-1-5-21-7"}, true, nil
		},
		func(session uint32, _ string, launch bool) error {
			gotSession, gotLaunch = session, launch
			return nil
		},
	)
	exec := &windowsExecutor{}
	if _, err := exec.StartUI(ExecuteParams{ExpectedExePath: `C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`}); err != nil {
		t.Fatal(err)
	}
	if gotSession != 7 || !gotLaunch || exec.uiStatus != remoteSupportUIHealthyStatus {
		t.Fatalf("session=%d launch=%t status=%q", gotSession, gotLaunch, exec.uiStatus)
	}
}

func TestNativeStartUISessionZeroBecomesPendingLogin(t *testing.T) {
	withRemoteSupportUISessionTest(t,
		func() (interactiveSessionInfo, bool, error) { return interactiveSessionInfo{}, true, nil },
		func(uint32, string, bool) error { return errors.New("Session 0 probe must not run") },
	)
	exec := &windowsExecutor{}
	if _, err := exec.StartUI(ExecuteParams{ExpectedExePath: `C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`}); err != nil {
		t.Fatal(err)
	}
	if exec.uiStatus != remoteSupportUIPendingLoginStatus {
		t.Fatalf("status=%q", exec.uiStatus)
	}
	if !strings.Contains(exec.uiDiagnostic, "no_interactive_session=true") {
		t.Fatalf("pending-login diagnostic missing no-session state: %s", exec.uiDiagnostic)
	}
}

func TestNativeStartUINoLoggedInUserBecomesPendingLogin(t *testing.T) {
	withRemoteSupportUISessionTest(t,
		func() (interactiveSessionInfo, bool, error) { return interactiveSessionInfo{}, false, nil },
		func(uint32, string, bool) error { return errors.New("UI probe must not run") },
	)
	exec := &windowsExecutor{}
	if _, err := exec.StartUI(ExecuteParams{ExpectedExePath: `C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`}); err != nil {
		t.Fatal(err)
	}
	if exec.uiStatus != remoteSupportUIPendingLoginStatus {
		t.Fatalf("status=%q", exec.uiStatus)
	}
	if !strings.Contains(exec.uiDiagnostic, "no_interactive_session=true") {
		t.Fatalf("pending-login diagnostic missing no-session state: %s", exec.uiDiagnostic)
	}
}

func TestNativeStartUIActiveSessionFailureIsNonfatal(t *testing.T) {
	withRemoteSupportUISessionTest(t,
		func() (interactiveSessionInfo, bool, error) {
			return interactiveSessionInfo{id: 9, username: `DOMAIN\User`, sid: "S-1-5-21-9"}, true, nil
		},
		func(uint32, string, bool) error { return errors.New("no usable main window") },
	)
	exec := &windowsExecutor{}
	if _, err := exec.StartUI(ExecuteParams{ExpectedExePath: `C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`}); err != nil {
		t.Fatal(err)
	}
	if exec.uiStatus != remoteSupportUILaunchFailedStatus {
		t.Fatalf("status=%q", exec.uiStatus)
	}
	for _, want := range []string{
		"agent_session_id=", "active_interactive_session_id=9", `interactive_username="DOMAIN\\User"`,
		`interactive_sid="S-1-5-21-9"`, "no_interactive_session=false", `executable_path="C:\\Program Files`,
		"arguments=[]", "timeout=10s", "no usable main window",
	} {
		if !strings.Contains(exec.uiDiagnostic, want) {
			t.Fatalf("diagnostic missing %q: %s", want, exec.uiDiagnostic)
		}
	}
}

func TestRemoteSupportUIProbeErrorIncludesProcessAndEveryWindow(t *testing.T) {
	err := remoteSupportUIProbeError(7, 7, `C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`, 41, 7, "5", 10*time.Second, []remoteSupportWindowDiagnostic{
		{handle: 0x101, pid: 41, title: "TECHI Remote Support", rect: windows.Rect{Left: 0, Top: 0, Right: 16, Bottom: 16}, visible: true, rejection: "width 16 < 200; height 16 < 120"},
		{handle: 0x202, pid: 42, title: "Helper", rect: windows.Rect{Left: 2, Top: 3, Right: 102, Bottom: 53}, visible: true, rejection: "width 100 < 200; height 50 < 120"},
	}, "no usable main window")
	for _, want := range []string{
		"created_process_pid=41", "created_process_session_id=7", "process_exit_code=5", "timeout=10s",
		"handle=0x101", `title="TECHI Remote Support"`, "width=16 height=16 visible=true", `result="width 16 < 200; height 16 < 120"`,
		"handle=0x202", `failure_reason="no usable main window"`,
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("diagnostic missing %q: %s", want, err)
		}
	}
}

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
