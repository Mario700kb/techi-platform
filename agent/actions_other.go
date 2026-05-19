//go:build !windows

package main

import (
	"context"
	"fmt"
)

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
