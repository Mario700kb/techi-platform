package main

import (
	"os"
	"strings"
	"testing"
)

// The command channel is Linux-only by decision (owner instruction,
// 2026-08-04: Windows is healthy on the heartbeat path and must not be
// touched). These tests pin that boundary at the source level so it cannot be
// widened by accident — a build-tag mistake would otherwise ship a persistent
// connection to 799 Windows endpoints on a single-vCPU host.
//
// They read source rather than calling code so they run on every platform,
// including the macOS workstation the agent is cross-compiled from. The
// behavioural tests live in command_channel_linux_test.go.

func readAgentFile(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(data)
}

func TestCommandChannelIsLinuxOnly(t *testing.T) {
	linux := readAgentFile(t, "command_channel_linux.go")
	if !strings.HasPrefix(linux, "//go:build linux") {
		t.Fatal("the real implementation must be gated to linux")
	}
	other := readAgentFile(t, "command_channel_other.go")
	if !strings.HasPrefix(other, "//go:build !linux") {
		t.Fatal("every non-linux platform must get the no-op")
	}
}

func TestNonLinuxImplementationOpensNothing(t *testing.T) {
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
			t.Fatalf("the non-linux stub must not reference %q — it must open no connection: %s", forbidden, body)
		}
	}
	if !strings.Contains(body, `import "context"`) {
		t.Fatalf("stub should import nothing beyond context, got:\n%s", body)
	}
	if !strings.Contains(body, "func runCommandChannel(_ context.Context, _ *Config) {}") {
		t.Fatalf("stub must be an empty no-op, got:\n%s", body)
	}
}

func TestWindowsStillRefusesOpenTerminal(t *testing.T) {
	// The channel only accelerates open_terminal. Windows must keep refusing
	// it, so even a mis-scoped channel could not open a shell there.
	win := readAgentFile(t, "actions_windows.go")
	if !strings.Contains(win, "not supported on Windows") {
		t.Fatal("actions_windows.go must keep refusing open_terminal")
	}
}

func TestChannelStartIsGuardedInTheAgentLoop(t *testing.T) {
	agent := readAgentFile(t, "agent.go")
	idx := strings.Index(agent, "go runCommandChannel(ctx, cfg)")
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
