//go:build linux

package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// Linux action handlers. Actions that only make sense on Windows (RustDesk
// management, PowerShell, power policy, protocol registration) return a clear
// "not supported on Linux" error so the operator sees why rather than a
// silent failure. Real system actions use systemd.

const linuxServiceName = "techi-agent"

// runLinuxCommand runs a command with the action's context (deadline/cancel).
func runLinuxCommand(ctx context.Context, name string, args ...string) actionResult {
	cmd := exec.CommandContext(ctx, name, args...)
	var out, errb strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err := cmd.Run()
	res := actionResult{output: out.String(), stderr: errb.String()}
	if err != nil {
		res.err = fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
		return res
	}
	res.message = fmt.Sprintf("%s %s: ok", name, strings.Join(args, " "))
	return res
}

func handleRestartDevice(ctx context.Context) actionResult {
	// systemctl reboot when available, else fall back to shutdown -r.
	if hasSystemd() {
		return runLinuxCommand(ctx, "systemctl", "reboot")
	}
	return runLinuxCommand(ctx, "shutdown", "-r", "now")
}

func handleRestartAgent(ctx context.Context) actionResult {
	if !hasSystemd() {
		return actionResult{err: fmt.Errorf("restart_agent: systemd not available")}
	}
	// Fire an immediate follow-up heartbeat once systemd brings us back.
	pendingImmediateHeartbeat.Store(true)
	return runLinuxCommand(ctx, "systemctl", "restart", linuxServiceName)
}

func handleRebootPC(ctx context.Context, _ map[string]interface{}) actionResult {
	return handleRestartDevice(ctx)
}

// --- Windows-only actions: explicit "not supported" on Linux ---

func handleRestartRustDesk(_ context.Context, _ *Config) actionResult {
	return notSupportedOnLinux("restart_rustdesk")
}

func handleReinstallRustDesk(_ context.Context, _ *Config) actionResult {
	return notSupportedOnLinux("reinstall_rustdesk")
}

func handleReopenRustDesk(_ context.Context, _ *Config) actionResult {
	return notSupportedOnLinux("reopen_rustdesk")
}

func handleApplyPowerPolicy(_ context.Context, _ *Config) actionResult {
	return notSupportedOnLinux("apply_power_policy")
}

func handleRepairConfigRustDesk(_ context.Context, _ *Config) actionResult {
	return notSupportedOnLinux("repair_config_rustdesk")
}

func handleDeployRemoteSupport(_ context.Context, _ *Config, _ map[string]interface{}) actionResult {
	return notSupportedOnLinux("deploy_remote_support")
}

func handleSetRemotePassword(_ context.Context, _ *Config, _ map[string]interface{}) actionResult {
	return notSupportedOnLinux("set_remote_password")
}

func handleRegisterTechiProtocol(_ context.Context) actionResult {
	return notSupportedOnLinux("register_protocol")
}

func handleRunPowerShell(_ context.Context, _ map[string]interface{}) actionResult {
	return notSupportedOnLinux("run_powershell")
}

func handleSelfUpdate(_ context.Context, _ map[string]interface{}) actionResult {
	// Self-update is normally triggered by the heartbeat response
	// (performSelfUpdate); this action path lets an operator force it.
	go performSelfUpdate(&AgentUpdate{Available: false})
	return actionResult{message: "self_update: triggered (applies on next update signal)"}
}

func notSupportedOnLinux(action string) actionResult {
	return actionResult{err: fmt.Errorf("%s: not supported on Linux", action)}
}
