//go:build !windows

package main

import (
	"context"
	"fmt"
)

func handleRestartDevice(_ context.Context) actionResult {
	return actionResult{err: fmt.Errorf("restart_device: Windows-only action — not supported on this platform")}
}

func handleRestartAgent(_ context.Context) actionResult {
	return actionResult{err: fmt.Errorf("restart_agent: Windows-only action — use your service manager (systemd/launchctl) to restart the agent manually")}
}

func handleRestartRustDesk(_ context.Context, _ *Config) actionResult {
	return actionResult{err: fmt.Errorf("restart_rustdesk: Windows-only action")}
}

func handleReinstallRustDesk(_ context.Context, _ *Config) actionResult {
	return actionResult{err: fmt.Errorf("reinstall_rustdesk: Windows-only action")}
}

func handleReopenRustDesk(_ context.Context, _ *Config) actionResult {
	return actionResult{err: fmt.Errorf("reopen_rustdesk: Windows-only action")}
}

func handleApplyPowerPolicy(_ context.Context, _ *Config) actionResult {
	return actionResult{err: fmt.Errorf("apply_power_policy: Windows-only action")}
}
