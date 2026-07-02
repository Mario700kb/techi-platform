//go:build windows

package main

// Native (script-free) binary swap and watchdog check.
//
// Strict AV/AMSI policies on some managed domains block every PowerShell
// script the agent launches, which silently broke self_update and the
// watchdog there. Everything here therefore runs as compiled Go code inside
// techi-agent.exe itself, driven by two subcommands:
//
//   techi-agent.exe swap-binary  -swap-target <exe> [-swap-task <name>]
//                                [-swap-api-url <url>] [-swap-enrollment-token <t>]
//   techi-agent.exe watchdog-check
//
// The only external processes used are Microsoft-signed system binaries
// (schtasks.exe); no .ps1/.cmd files are written or executed.

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	gopsprocess "github.com/shirou/gopsutil/v3/process"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	agentServiceDisplayName = "TECHI Agent"
	agentBackupExeName      = "techi-agent-old.exe"
)

func agentProgramDataDir() string {
	programData := strings.TrimSpace(os.Getenv("ProgramData"))
	if programData == "" {
		programData = `C:\ProgramData`
	}
	return filepath.Join(programData, "TechiAgent")
}

func agentTargetExePath() string {
	return filepath.Join(agentProgramDataDir(), "techi-agent.exe")
}

func deployLogFilePath() string {
	return filepath.Join(agentProgramDataDir(), "deploy.log")
}

// writeDeployLog appends a line to deploy.log so swap/watchdog activity is
// visible to operators in the same file the previous helpers used.
func writeDeployLog(tag string, message string) {
	path := deployLogFilePath()
	_ = os.MkdirAll(filepath.Dir(path), 0755)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	stamp := time.Now().Format("2006-01-02 15:04:05")
	_, _ = fmt.Fprintf(f, "%s %s %s\r\n", stamp, tag, message)
}

// ------------------------------------------------------------------ //
// swap-binary subcommand                                              //
// ------------------------------------------------------------------ //

func runBinarySwapCommand(args []string) int {
	fs := flag.NewFlagSet("swap-binary", flag.ContinueOnError)
	target := fs.String("swap-target", agentTargetExePath(), "path of the installed service exe to replace")
	taskName := fs.String("swap-task", "", "one-shot scheduled task name to delete when done")
	apiURL := fs.String("swap-api-url", "", "api url used only when creating a fresh config")
	enrollmentToken := fs.String("swap-enrollment-token", "", "enrollment token used only when no config exists")
	if err := fs.Parse(args); err != nil {
		return 1
	}

	err := performBinarySwap(*target, *apiURL, *enrollmentToken)
	if *taskName != "" {
		deleteScheduledTask(*taskName)
	}
	if err != nil {
		writeDeployLog("[self_update]", "failed: "+err.Error())
		return 1
	}
	return 0
}

// performBinarySwap replaces targetExe with the currently running executable:
// stop service -> backup -> copy self over target -> start service, with
// rollback to the backup if the service does not come back.
func performBinarySwap(targetExe string, apiURL string, enrollmentToken string) error {
	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot resolve own path: %w", err)
	}
	self, _ = filepath.Abs(self)
	targetExe, _ = filepath.Abs(targetExe)
	writeDeployLog("[self_update]", fmt.Sprintf("begin binary_swap new=%s target=%s", self, targetExe))

	if strings.EqualFold(self, targetExe) {
		return fmt.Errorf("refusing to swap: running from the target path itself")
	}
	ensureFreshAgentConfig(apiURL, enrollmentToken)

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("scm connect: %w", err)
	}
	defer m.Disconnect()

	if err := stopAgentServiceAndProcesses(m, targetExe); err != nil {
		return err
	}

	backup := filepath.Join(filepath.Dir(targetExe), agentBackupExeName)
	if _, err := os.Stat(targetExe); err == nil {
		if err := copyFileSync(targetExe, backup); err != nil {
			return fmt.Errorf("backup failed: %w", err)
		}
		writeDeployLog("[self_update]", "backup written path="+backup)
	}

	if err := copyFileSync(self, targetExe); err != nil {
		rollbackBinarySwap(m, backup, targetExe)
		return fmt.Errorf("install new exe failed: %w", err)
	}
	writeDeployLog("[self_update]", fmt.Sprintf("installed: %s -> %s", self, targetExe))

	if err := ensureAgentServiceRunning(m, targetExe); err != nil {
		writeDeployLog("[self_update]", "service failed after swap: "+err.Error())
		rollbackBinarySwap(m, backup, targetExe)
		return fmt.Errorf("service not running after swap: %w", err)
	}

	_ = os.Remove(backup)
	writeDeployLog("[self_update]", "complete: binary swap succeeded")
	return nil
}

func rollbackBinarySwap(m *mgr.Mgr, backup string, targetExe string) {
	writeDeployLog("[self_update]", fmt.Sprintf("rollback: restoring %s -> %s", backup, targetExe))
	if _, err := os.Stat(backup); err != nil {
		writeDeployLog("[self_update]", "rollback: no backup found")
		return
	}
	killAgentProcesses(targetExe)
	if err := copyFileSync(backup, targetExe); err != nil {
		writeDeployLog("[self_update]", "rollback error: "+err.Error())
		return
	}
	if err := ensureAgentServiceRunning(m, targetExe); err != nil {
		writeDeployLog("[self_update]", "rollback: service start failed: "+err.Error())
		return
	}
	writeDeployLog("[self_update]", "rollback: backup restored and service running")
}

// stopAgentServiceAndProcesses stops TechiAgent, waits until it is fully
// stopped (not StopPending -- the process must release the exe lock), then
// force-kills any lingering techi-agent process other than this one.
func stopAgentServiceAndProcesses(m *mgr.Mgr, targetExe string) error {
	service, err := m.OpenService(serviceName)
	if err == nil {
		defer service.Close()
		status, qerr := service.Query()
		writeDeployLog("[self_update]", fmt.Sprintf("service status before stop=%s", serviceStateName(status.State)))
		if qerr == nil && status.State != svc.Stopped {
			if _, cerr := service.Control(svc.Stop); cerr != nil {
				writeDeployLog("[self_update]", "service stop control error: "+cerr.Error())
			}
		}
		deadline := time.Now().Add(45 * time.Second)
		for time.Now().Before(deadline) {
			status, qerr = service.Query()
			if qerr != nil || status.State == svc.Stopped {
				break
			}
			time.Sleep(2 * time.Second)
		}
		writeDeployLog("[self_update]", fmt.Sprintf("service status after wait=%s", serviceStateName(status.State)))
	} else {
		writeDeployLog("[self_update]", "service missing before swap")
	}

	killAgentProcesses(targetExe)
	time.Sleep(2 * time.Second)
	writeDeployLog("[self_update]", "service fully stopped; proceeding with swap")
	return nil
}

// killAgentProcesses force-kills every techi-agent.exe process except the
// current one, so the target file is guaranteed unlocked before the rename.
func killAgentProcesses(targetExe string) {
	self := int32(os.Getpid())
	procs, err := gopsprocess.Processes()
	if err != nil {
		return
	}
	for _, p := range procs {
		if p.Pid == self {
			continue
		}
		name, err := p.Name()
		if err != nil || !strings.EqualFold(name, "techi-agent.exe") {
			continue
		}
		if exe, err := p.Exe(); err == nil && targetExe != "" && !strings.EqualFold(exe, targetExe) {
			// A different techi-agent.exe (e.g. another swap helper) — leave it.
			continue
		}
		writeDeployLog("[self_update]", fmt.Sprintf("killing lingering agent process pid=%d", p.Pid))
		_ = p.Kill()
	}
}

// ensureAgentServiceRunning recreates the TechiAgent service if it is
// missing, reapplies the SCM failure actions, starts it, and verifies it
// reaches Running.
func ensureAgentServiceRunning(m *mgr.Mgr, targetExe string) error {
	service, err := m.OpenService(serviceName)
	if err != nil {
		writeDeployLog("[self_update]", "service missing; recreating")
		service, err = m.CreateService(serviceName, targetExe, mgr.Config{
			DisplayName: agentServiceDisplayName,
			StartType:   mgr.StartAutomatic,
		})
		if err != nil {
			return fmt.Errorf("service create: %w", err)
		}
	}
	defer service.Close()

	recoveryActions := []mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 1 * time.Minute},
		{Type: mgr.ServiceRestart, Delay: 1 * time.Minute},
		{Type: mgr.ServiceRestart, Delay: 5 * time.Minute},
	}
	if err := service.SetRecoveryActions(recoveryActions, 86400); err != nil {
		writeDeployLog("[self_update]", "warning: recovery actions not applied: "+err.Error())
	}

	status, err := service.Query()
	if err == nil && status.State == svc.Running {
		return nil
	}
	if err := service.Start(); err != nil {
		writeDeployLog("[self_update]", "service start error: "+err.Error())
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		status, err = service.Query()
		if err == nil && status.State == svc.Running {
			writeDeployLog("[self_update]", "service final status=Running")
			return nil
		}
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("service state=%s", serviceStateName(status.State))
}

// ensureFreshAgentConfig mirrors the old bridge helper: create a minimal
// config only when none exists at all and an enrollment token was supplied.
// Existing configs (and device identity) are never touched.
func ensureFreshAgentConfig(apiURL string, enrollmentToken string) {
	if _, err := os.Stat(windowsConfigPath); err == nil {
		writeDeployLog("[self_update]", "config preserved path="+windowsConfigPath)
		return
	}
	if _, err := os.Stat(windowsLegacyConfigPath); err == nil {
		writeDeployLog("[self_update]", "config preserved path="+windowsLegacyConfigPath)
		return
	}
	if strings.TrimSpace(enrollmentToken) == "" {
		writeDeployLog("[self_update]", "config missing and no enrollment token supplied; leaving enrollment to existing agent/bootstrap")
		return
	}
	if strings.TrimSpace(apiURL) == "" {
		apiURL = "https://api-rdp.techi.com.al"
	}
	cfg := map[string]interface{}{
		"api_url":                    strings.TrimSpace(apiURL),
		"enrollment_token":           strings.TrimSpace(enrollmentToken),
		"timeout_seconds":            30,
		"heartbeat_interval_seconds": 60,
		"retries":                    3,
		"retry_delay_seconds":        10,
		"collect_processes":          true,
		"collect_software":           true,
		"collect_services":           true,
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(windowsLegacyConfigPath), 0700); err != nil {
		writeDeployLog("[self_update]", "config create failed: "+err.Error())
		return
	}
	if err := os.WriteFile(windowsLegacyConfigPath, data, 0600); err != nil {
		writeDeployLog("[self_update]", "config create failed: "+err.Error())
		return
	}
	writeDeployLog("[self_update]", "config created path="+windowsLegacyConfigPath)
}

// ------------------------------------------------------------------ //
// watchdog-check subcommand                                           //
// ------------------------------------------------------------------ //

// runWatchdogCheckCommand is executed by the "TECHI Agent Watchdog"
// scheduled task: recreate the service if it vanished while the exe still
// exists, reapply recovery actions, and start it when stopped.
func runWatchdogCheckCommand() int {
	targetExe := agentTargetExePath()
	m, err := mgr.Connect()
	if err != nil {
		writeDeployLog("[watchdog]", "scm connect error: "+err.Error())
		return 1
	}
	defer m.Disconnect()

	if _, err := m.OpenService(serviceName); err != nil {
		if _, serr := os.Stat(targetExe); serr != nil {
			writeDeployLog("[watchdog]", "service missing and exe missing; cannot recover")
			return 0
		}
		writeDeployLog("[watchdog]", "service missing; recreating")
	}
	if err := ensureAgentServiceRunning(m, targetExe); err != nil {
		writeDeployLog("[watchdog]", "service not running: "+err.Error())
		return 1
	}
	return 0
}

// ------------------------------------------------------------------ //
// schtasks helpers (Microsoft-signed system binary, no scripts)        //
// ------------------------------------------------------------------ //

func schtasksPath() string {
	systemRoot := strings.TrimSpace(os.Getenv("SystemRoot"))
	if systemRoot == "" {
		systemRoot = `C:\Windows`
	}
	return filepath.Join(systemRoot, "System32", "schtasks.exe")
}

// registerOneShotSystemTask registers and immediately starts a run-once
// scheduled task as SYSTEM. The command must delete the task itself via
// deleteScheduledTask when it finishes.
func registerOneShotSystemTask(taskName string, taskRun string) error {
	create := exec.Command(
		schtasksPath(),
		"/Create", "/TN", taskName, "/TR", taskRun,
		"/SC", "ONCE", "/ST", "00:00",
		"/RU", "SYSTEM", "/RL", "HIGHEST", "/F",
	)
	if out, err := create.CombinedOutput(); err != nil {
		return fmt.Errorf("schtasks create: %w: %s", err, strings.TrimSpace(string(out)))
	}
	run := exec.Command(schtasksPath(), "/Run", "/TN", taskName)
	if out, err := run.CombinedOutput(); err != nil {
		deleteScheduledTask(taskName)
		return fmt.Errorf("schtasks run: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// registerRecurringSystemTask registers (or replaces) a task that runs the
// command as SYSTEM every intervalMinutes, indefinitely.
func registerRecurringSystemTask(taskName string, taskRun string, intervalMinutes int) error {
	create := exec.Command(
		schtasksPath(),
		"/Create", "/TN", taskName, "/TR", taskRun,
		"/SC", "MINUTE", "/MO", fmt.Sprintf("%d", intervalMinutes),
		"/RU", "SYSTEM", "/RL", "HIGHEST", "/F",
	)
	if out, err := create.CombinedOutput(); err != nil {
		return fmt.Errorf("schtasks create: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func deleteScheduledTask(taskName string) {
	cmd := exec.Command(schtasksPath(), "/Delete", "/TN", taskName, "/F")
	_, _ = cmd.CombinedOutput()
}

// copyFileSync copies src to dst (overwriting) and fsyncs the result so the
// binary is fully on disk before the service starts from it.
func copyFileSync(src string, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
