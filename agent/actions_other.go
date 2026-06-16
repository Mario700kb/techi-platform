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

func handleRepairConfigRustDesk(_ context.Context, _ *Config) actionResult {
	return actionResult{err: fmt.Errorf("repair_config_rustdesk: Windows-only action")}
}

func handleDeployRemoteSupport(_ context.Context, _ *Config, _ map[string]interface{}) actionResult {
	return actionResult{err: fmt.Errorf("deploy_remote_support: Windows-only action")}
}

func handleSetRemotePassword(_ context.Context, _ *Config, _ map[string]interface{}) actionResult {
	return actionResult{err: fmt.Errorf("set_remote_password: Windows-only action")}
}

func handleRegisterTechiProtocol(_ context.Context) actionResult {
	return actionResult{err: fmt.Errorf("register_protocol: Windows-only action")}
}

func handleRebootPC(_ context.Context, _ map[string]interface{}) actionResult {
	return actionResult{err: fmt.Errorf("reboot_pc: Windows-only action")}
}

func handleRunPowerShell(_ context.Context, _ map[string]interface{}) actionResult {
	return actionResult{err: fmt.Errorf("run_powershell: Windows-only action")}
}

func handleSelfUpdate(_ context.Context, _ map[string]interface{}) actionResult {
	return actionResult{err: fmt.Errorf("self_update: Windows-only action")}
}
