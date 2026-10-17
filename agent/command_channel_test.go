package main

import (
	"os"
	"strings"
	"testing"
)

// The command channel runs on Linux and Windows (Windows since 2026-10-16, for
// instant single-device actions and the live device view). These tests pin
// that boundary at the source level so it cannot widen or narrow by accident.
//
// They read source rather than calling code so they run on every platform,
// including the macOS workstation the agent is cross-compiled from. The
// behavioural tests live in command_channel_ws_test.go and live_test.go.

func readAgentFile(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(data)
}

func TestCommandChannelRunsOnLinuxAndWindowsOnly(t *testing.T) {
	real := readAgentFile(t, "command_channel.go")
	if !strings.HasPrefix(real, "//go:build linux || windows") {
		t.Fatal("the real implementation must be gated to linux and windows")
	}
	other := readAgentFile(t, "command_channel_other.go")
	if !strings.HasPrefix(other, "//go:build !linux && !windows") {
		t.Fatal("every other platform must get the no-op")
	}
}

func TestReconnectsAfterAHealthyConnectionAreSpreadOverAMinute(t *testing.T) {
	real := readAgentFile(t, "command_channel.go")
	if !strings.Contains(real, "wait = reconnectAfterHealthy()") {
		t.Fatal("a dropped healthy connection must reconnect after a spread wait, not all at once")
	}
}

func TestOtherPlatformsOpenNothing(t *testing.T) {
	// Checks imports and the function body, not the whole file: prose in a
	// comment naturally mentions "websocket" and must not trip this.
	other := readAgentFile(t, "command_channel_other.go")

	var code []string
	for _, line := range strings.Split(other, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "//") {
			continue
		}
		code = append(code, trimmed)
	}
	body := strings.Join(code, "\n")

	for _, forbidden := range []string{"websocket", "Dial", "http.", "net/"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("the no-op stub must not reference %q — it must open no connection: %s", forbidden, body)
		}
	}
	if !strings.Contains(body, `import "context"`) {
		t.Fatalf("stub should import nothing beyond context, got:\n%s", body)
	}
	if !strings.Contains(body, "func runCommandChannel(_ context.Context, _ string) {}") {
		t.Fatalf("stub must be an empty no-op, got:\n%s", body)
	}
}

func TestWindowsOpensOnlyPowerShellInAPseudoConsole(t *testing.T) {
	// Until 2.1.29 Windows refused open_terminal. Since the owner asked for an
	// administrator PowerShell (2026-10-17) it opens exactly that — never a
	// shell the caller names — and refuses where there is no pseudo console.
	// The two-factor check that guards it is on the platform.
	win := readAgentFile(t, "terminal_windows.go")
	for _, want := range []string{"conPTYAvailable()", "powershell.exe", "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE", "powershellSessionMax"} {
		if !strings.Contains(win, want) {
			t.Fatalf("terminal_windows.go must contain %q", want)
		}
	}
	if strings.Contains(win, `params["engine"]`) {
		t.Fatal("the Windows console must not take its program from the action")
	}
}

func TestChannelStartIsGuardedInTheAgentLoop(t *testing.T) {
	agent := readAgentFile(t, "agent.go")
	idx := strings.Index(agent, "go runCommandChannel(ctx, configPath)")
	if idx < 0 {
		t.Fatal("the agent loop must start the channel")
	}
	// One-shot runs (bootstrap-config, watchdog-check and friends) must not
	// open a long-lived connection they will never use.
	start := idx - 200
	if start < 0 {
		start = 0
	}
	if !strings.Contains(agent[start:idx], "if !once") {
		t.Fatal("the channel must not start in one-shot mode")
	}
}
