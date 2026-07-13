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

func handleRegisterTechiProtocol(_ context.Context) actionResult {
	return notSupportedOnLinux("register_protocol")
}

func handleRunPowerShell(_ context.Context, _ map[string]interface{}) actionResult {
	return notSupportedOnLinux("run_powershell")
}

// handleRunCommand executes a script via the requested engine (Command Center,
// Platform Expansion). Auto-resolution to bash happens server-side; the agent
// honors the engine it is given, defaulting to bash.
func handleRunCommand(ctx context.Context, params map[string]interface{}) actionResult {
	command, _ := params["command"].(string)
	if strings.TrimSpace(command) == "" {
		return actionResult{err: fmt.Errorf("run_command: empty command")}
	}
	engine, _ := params["engine"].(string)
	engine = strings.ToLower(strings.TrimSpace(engine))

	var name string
	var args []string
	switch engine {
	case "sh":
		name, args = "sh", []string{"-c", command}
	case "python", "python3":
		name, args = "python3", []string{"-c", command}
	case "busybox":
		name, args = "busybox", []string{"sh", "-c", command}
	default: // bash / auto
		name, args = "bash", []string{"-c", command}
	}
	if _, err := exec.LookPath(name); err != nil {
		return actionResult{err: fmt.Errorf("run_command: %s not available", name)}
	}
	return runLinuxCommand(ctx, name, args...)
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
