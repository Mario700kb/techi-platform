//go:build windows

package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc/mgr"
)

func TestProtectedTargetsAreRefusedBeforeAnythingRuns(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name   string
		result actionResult
	}{
		{"lsass", handleKillProcess(ctx, &Config{}, map[string]interface{}{"pid": float64(700), "name": "lsass.exe"})},
		{"agent itself", handleKillProcess(ctx, &Config{}, map[string]interface{}{"pid": float64(os.Getpid()), "name": "anything.exe"})},
		{"stop agent", handleServiceControl(ctx, &Config{}, map[string]interface{}{"name": "TechiAgent", "operation": "stop"})},
		{"restart rpc", handleServiceControl(ctx, &Config{}, map[string]interface{}{"name": "RpcSs", "operation": "restart"})},
		{"bad op", handleServiceControl(ctx, &Config{}, map[string]interface{}{"name": "Spooler", "operation": "delete"})},
		{"uninstall agent", handleUninstallSoftware(ctx, &Config{}, map[string]interface{}{"uninstall_key": `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{X}`, "name": "TECHI Agent"})},
		{"uninstall remote support", handleUninstallSoftware(ctx, &Config{}, map[string]interface{}{"uninstall_key": `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{X}`, "name": "TECHI Remote Support"})},
		{"missing pid", handleKillProcess(ctx, &Config{}, map[string]interface{}{"name": "notepad.exe"})},
	}
	for _, c := range cases {
		if c.result.err == nil {
			t.Errorf("%s: expected a refusal, got %q", c.name, c.result.message)
		}
	}
}

func TestOnlyAnUninstallEntryCanBeOpened(t *testing.T) {
	for _, key := range []string{
		`HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`,
		`HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\`,
		`HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\App\Sub`,
		`HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\TechiAgent`,
		`HKEY_USERS\S-1-5-18\Software\Microsoft\Windows\CurrentVersion\Uninstall\App`,
	} {
		if _, err := openUninstallKey(key); err == nil || !strings.Contains(err.Error(), "not an app's uninstall entry") {
			t.Errorf("%s: want refusal, got %v", key, err)
		}
	}
}

func TestCommandExecutable(t *testing.T) {
	for in, want := range map[string]string{
		`"C:\Program Files\Notepad++\uninstall.exe" /S`:            `C:\Program Files\Notepad++\uninstall.exe`,
		`C:\Program Files\App\unins000.exe /VERYSILENT`:            `C:\Program Files\App\unins000.exe`,
		`MsiExec.exe /X{23170F69-40C1-2702-2301-000001000000} /qn`: `MsiExec.exe`,
		`"unterminated`: "",
		``:              "",
	} {
		if got := commandExecutable(in); got != want {
			t.Errorf("commandExecutable(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestKillProcessEndsTheNamedProcessOnly(t *testing.T) {
	cmd := exec.Command("ping", "-n", "60", "127.0.0.1")
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start ping: %v", err)
	}
	defer cmd.Process.Kill()
	pid := float64(cmd.Process.Pid)

	// The PID does not belong to a process of that name: nothing is ended.
	if r := handleKillProcess(context.Background(), &Config{}, map[string]interface{}{"pid": pid, "name": "notepad.exe"}); r.err == nil {
		t.Fatalf("a mismatched name must be refused, got %q", r.message)
	}
	r := handleKillProcess(context.Background(), &Config{}, map[string]interface{}{"pid": pid, "name": "PING.EXE"})
	if r.err != nil {
		t.Fatalf("kill: %v", r.err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("ping still running after kill_process")
	}
}

func TestUninstallRunsTheQuietCommandOfTheNamedEntry(t *testing.T) {
	path := `Software\Microsoft\Windows\CurrentVersion\Uninstall\TechiAgentTestApp`
	k, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if err != nil {
		t.Skipf("cannot create a test uninstall entry: %v", err)
	}
	defer registry.DeleteKey(registry.CURRENT_USER, path)
	marker := t.TempDir() + `\uninstalled.txt`
	_ = k.SetStringValue("DisplayName", "TECHI Test App")
	_ = k.SetStringValue("QuietUninstallString", `cmd.exe /d /c echo done> "`+marker+`"`)
	k.Close()

	key := `HKEY_CURRENT_USER\` + path
	if r := handleUninstallSoftware(context.Background(), &Config{}, map[string]interface{}{"uninstall_key": key, "name": "Another App"}); r.err == nil {
		t.Fatalf("an entry naming another app must be refused, got %q", r.message)
	}
	r := handleUninstallSoftware(context.Background(), &Config{}, map[string]interface{}{"uninstall_key": key, "name": "TECHI Test App"})
	if r.err != nil {
		t.Fatalf("uninstall: %v", r.err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("the quiet uninstall command did not run: %v", err)
	}
}

func TestServiceControlStopsStartsAndRestartsARealService(t *testing.T) {
	// The Print Spooler exists on every Windows runner and nothing in CI needs it.
	m, err := mgr.Connect()
	if err != nil {
		t.Skipf("service manager: %v", err)
	}
	s, err := m.OpenService("Spooler")
	if err != nil {
		m.Disconnect()
		t.Skip("no Spooler service here")
	}
	s.Close()
	m.Disconnect()
	ctx := context.Background()
	defer handleServiceControl(ctx, &Config{}, map[string]interface{}{"name": "Spooler", "operation": "start"})

	for _, op := range []string{"stop", "start", "restart"} {
		r := handleServiceControl(ctx, &Config{}, map[string]interface{}{"name": "Spooler", "operation": op})
		if r.err != nil {
			if strings.Contains(r.err.Error(), "Access is denied") {
				t.Skip("not running as administrator")
			}
			t.Fatalf("%s: %v", op, r.err)
		}
		t.Logf("%s: %s", op, r.message)
	}
	if r := handleServiceControl(ctx, &Config{}, map[string]interface{}{"name": "NoSuchServiceTechi", "operation": "start"}); r.err == nil {
		t.Fatal("an unknown service must fail")
	}
}
