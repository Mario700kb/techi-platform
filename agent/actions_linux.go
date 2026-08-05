//go:build linux

package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
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

func handleRestartAgent(_ context.Context) actionResult {
	if !hasSystemd() {
		return actionResult{err: fmt.Errorf("restart_agent: systemd not available")}
	}
	// Fire an immediate follow-up heartbeat once systemd brings us back.
	pendingImmediateHeartbeat.Store(true)

	// `systemctl restart techi-agent` SIGTERMs this very process. Running it
	// under the action's context meant that signal cancelled the context, which
	// killed the systemctl child mid-restart: the restart still happened, but
	// the action reported "signal: terminated" and the operator saw a failure
	// for a command that worked (device 812, 2026-08-05).
	//
	// Detach into a new session so it survives our death, and delay it briefly
	// so the completion callback is on the wire before systemd stops us.
	cmd := exec.Command("sh", "-c", "sleep 3; systemctl restart "+linuxServiceName)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return actionResult{err: fmt.Errorf("restart_agent: %w", err)}
	}
	_ = cmd.Process.Release()
	return actionResult{message: "restart_agent: restart scheduled"}
}

func handleRebootPC(ctx context.Context, _ map[string]interface{}) actionResult {
	return handleRestartDevice(ctx)
}

// --- Windows-only actions: explicit "not supported" on Linux ---

func handleRestartRustDesk(_ context.Context, _ *Config) actionResult {
	return notSupportedOnLinux("restart_rustdesk")
}

func handleReinstallRustDesk(_ context.Context, _ *Config, _ map[string]interface{}) actionResult {
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

func handleSelfUpdate(_ context.Context, params map[string]interface{}) actionResult {
	// Mirrors the Windows handler: the server supplies the exact package to
	// install, and performSelfUpdate (update_linux.go) downloads, verifies the
	// SHA-256, swaps the binary atomically and restarts the service.
	//
	// This used to pass Available:false, i.e. do nothing at all, while
	// reporting "triggered" — so the action sat in `running` forever waiting
	// for a version change that could never come (device 812, 2026-08-05).
	url := stringParam(params, "download_url")
	version := stringParam(params, "version")
	checksum := stringParam(params, "sha256")
	if url == "" {
		return actionResult{err: fmt.Errorf("self_update: missing 'download_url' parameter")}
	}
	go performSelfUpdate(&AgentUpdate{
		Available: true,
		Version:   version,
		URL:       url,
		Checksum:  checksum,
	})
	return actionResult{message: fmt.Sprintf("Self-update to v%s initiated in background", version)}
}

// stringParam mirrors the Windows helper; the two files never co-compile.
func stringParam(params map[string]interface{}, key string) string {
	if params == nil {
		return ""
	}
	if v, ok := params[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

func notSupportedOnLinux(action string) actionResult {
	return actionResult{err: fmt.Errorf("%s: not supported on Linux", action)}
}
