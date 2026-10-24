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
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	gopsprocess "github.com/shirou/gopsutil/v3/process"
	"golang.org/x/sys/windows"
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
	rotateFileIfOversize(path, deployLogMaxBytes)
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
	confirmWindow := fs.Duration("swap-confirm-window", swapConfirmWindow, "how long to watch the new agent before keeping it unconfirmed")
	if err := fs.Parse(args); err != nil {
		return 1
	}

	err := performBinarySwap(*target, *apiURL, *enrollmentToken, *confirmWindow)
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
// stop service -> backup -> copy self over target -> start service -> watch
// the new agent (swap_guard_windows.go). It rolls back to the backup only on
// a definite failure, and keeps the backup in every case.
func performBinarySwap(targetExe string, apiURL string, enrollmentToken string, confirmWindow time.Duration) error {
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

	// A second self_update inside the confirm window would race the first
	// swap's rollback and clear its marker.
	if swapInProgress() {
		return fmt.Errorf("another swap is in progress; try again later")
	}
	writeSwapMarker()
	defer clearSwapMarker()

	if err := stopAgentServiceAndProcesses(m, targetExe); err != nil {
		return err
	}

	backup := filepath.Join(filepath.Dir(targetExe), agentBackupExeName)
	if _, err := os.Stat(targetExe); err == nil {
		if err := copyFileWithRetry(targetExe, backup, "[self_update]"); err != nil {
			// The old exe is untouched; bring its service back before giving up.
			if serr := ensureAgentServiceRunning(m, targetExe); serr != nil {
				writeDeployLog("[self_update]", "restart after failed backup: "+serr.Error())
			}
			return fmt.Errorf("backup failed: %w", err)
		}
		writeDeployLog("[self_update]", "backup written path="+backup)
	} else {
		writeDeployLog("[self_update]", "no exe at target before swap; nothing to back up")
	}

	if err := copyFileWithRetry(self, targetExe, "[self_update]"); err != nil {
		rollbackBinarySwap(m, backup, targetExe, self)
		return fmt.Errorf("install new exe failed: %w", err)
	}
	installedAt := time.Now()
	writeDeployLog("[self_update]", fmt.Sprintf("installed: %s -> %s", self, targetExe))

	if err := ensureAgentServiceRunning(m, targetExe); err != nil {
		writeDeployLog("[self_update]", "service failed after swap: "+err.Error())
		rollbackBinarySwap(m, backup, targetExe, self)
		return fmt.Errorf("service not running after swap: %w", err)
	}

	verdict, reason := watchNewAgent(m, targetExe, installedAt, confirmWindow)
	switch verdict {
	case swapConfirmed:
		writeDeployLog("[self_update]", "complete: "+reason+"; previous exe kept at "+backup)
	case swapUnconfirmed:
		writeDeployLog("[self_update]", fmt.Sprintf("complete, not confirmed within %s (%s); keeping the new version and the backup", confirmWindow, reason))
	default:
		writeDeployLog("[self_update]", "new agent failed: "+reason)
		rollbackBinarySwap(m, backup, targetExe, self)
		return fmt.Errorf("new agent failed: %s", reason)
	}
	return nil
}

// watchNewAgent polls the machine until the swap guard reaches a verdict.
func watchNewAgent(m *mgr.Mgr, targetExe string, installedAt time.Time, window time.Duration) (swapVerdict, string) {
	w := newSwapWatch(installedAt, window)
	for {
		o := swapObservation{Now: time.Now()}
		_, err := os.Stat(targetExe)
		o.ExeExists = !os.IsNotExist(err)
		if service, err := m.OpenService(serviceName); err == nil {
			status, qerr := service.Query()
			service.Close()
			o.ServiceRunning = qerr == nil && status.State == svc.Running
		}
		if status, err := readLifecycleStatus(); err == nil {
			o.Lifecycle = status
		}
		if verdict, reason := w.observe(o); verdict != swapPending {
			return verdict, reason
		}
		time.Sleep(swapPollInterval)
	}
}

// rollbackBinarySwap puts the previous exe back. Without a backup it copies
// the new exe over the target again (a failed copy may have left it
// truncated), so the PC is never left with no agent at all.
func rollbackBinarySwap(m *mgr.Mgr, backup string, targetExe string, self string) {
	killAgentProcesses(targetExe)
	source := agentExeRestoreSource(backup, self, fileExists)
	switch {
	case source == backup:
		writeDeployLog("[self_update]", fmt.Sprintf("rollback: restoring %s -> %s", backup, targetExe))
	case source != "":
		writeDeployLog("[self_update]", "rollback: no backup found; reinstalling "+source)
	case fileExists(targetExe):
		writeDeployLog("[self_update]", "rollback: no backup and no new exe; starting the exe in place")
	default:
		writeDeployLog("[self_update]", "rollback: no backup and no exe to restore")
		return
	}
	if source != "" {
		if err := copyFileWithRetry(source, targetExe, "[self_update]"); err != nil {
			writeDeployLog("[self_update]", "rollback error: "+err.Error())
			return
		}
	}
	if err := ensureAgentServiceRunning(m, targetExe); err != nil {
		writeDeployLog("[self_update]", "rollback: service start failed: "+err.Error())
		return
	}
	writeDeployLog("[self_update]", "rollback: done and service running")
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

// serviceDeleteWait bounds the wait for a TechiAgent service that the SCM
// has marked for deletion (an MSI upgrade removed the old product while
// something still held a handle to it). Until the last handle closes,
// configuring it fails with ERROR_SERVICE_MARKED_FOR_DELETE and starting it
// fails with ERROR_SERVICE_DISABLED (seen in CI run 40112328325); the MSI
// used to give up at once with 1920 and roll back with 1603.
const serviceDeleteWait = 2 * time.Minute

// ensureAgentServiceRunning recreates the TechiAgent service if it is
// missing, reapplies the SCM failure actions, starts it, and verifies it
// reaches Running. A service marked for deletion is waited out, then
// recreated.
func ensureAgentServiceRunning(m *mgr.Mgr, targetExe string) error {
	deadline := time.Now().Add(serviceDeleteWait)
	logged := false
	for {
		err := startAgentServiceOnce(m, targetExe)
		if err == nil || !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) || time.Now().After(deadline) {
			return err
		}
		if !logged {
			writeDeployLog("[self_update]", "service marked for deletion; waiting for the SCM to release it")
			logged = true
		}
		// An old service process that never finished stopping keeps it alive.
		killAgentProcesses(targetExe)
		time.Sleep(3 * time.Second)
	}
}

func startAgentServiceOnce(m *mgr.Mgr, targetExe string) error {
	service, err := m.OpenService(serviceName)
	if err != nil {
		writeDeployLog("[self_update]", "service missing; recreating")
		service, err = m.CreateService(serviceName, targetExe, mgr.Config{
			DisplayName: agentServiceDisplayName,
			Description: "TECHI Platform endpoint monitoring and management agent",
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
		// The reliable sign of a pending delete: Start reports it as "disabled".
		if errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
			return fmt.Errorf("service recovery actions: %w", err)
		}
		writeDeployLog("[self_update]", "warning: recovery actions not applied: "+err.Error())
	}

	status, err := service.Query()
	if err == nil && status.State == svc.Running {
		return nil
	}
	if err := service.Start(); err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
			return fmt.Errorf("service start: %w", err)
		}
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
// scheduled task (from its own copy of the agent, see watchdog_windows.go)
// and by the MSI's EnsureServiceCreated: put back a missing exe while the
// service is registered, recreate the service if it vanished while the exe
// still exists, reapply recovery actions, and start it when stopped.
func runWatchdogCheckCommand() int {
	targetExe := agentTargetExePath()
	m, err := mgr.Connect()
	if err != nil {
		writeDeployLog("[watchdog]", "scm connect error: "+err.Error())
		return 1
	}
	defer m.Disconnect()

	if swapInProgress() {
		writeDeployLog("[watchdog]", "self-update swap in progress; agent service left alone")
		ensureRemoteSupportRunningFromWatchdog(m)
		return 0
	}

	registered := false
	if service, err := m.OpenService(serviceName); err == nil {
		registered = true
		service.Close()
	}
	_, statErr := os.Stat(targetExe)
	exeMissing := os.IsNotExist(statErr)

	if !registered && exeMissing {
		// The MSI uninstall removes the service and the exe but not this task.
		writeDeployLog("[watchdog]", "service and exe both missing: agent uninstalled; removing the watchdog task")
		deleteScheduledTask(agentWatchdogTaskName)
		removeAgentLeftovers()
		return 0
	}
	if exeMissing {
		if err := restoreMissingAgentExe(targetExe); err != nil {
			writeDeployLog("[watchdog]", "exe missing and not restored: "+err.Error())
			return 1
		}
	}

	agentRC := 0
	if !registered {
		writeDeployLog("[watchdog]", "service missing; recreating")
		if err := ensureAgentServiceRunning(m, targetExe); err != nil {
			writeDeployLog("[watchdog]", "service not running: "+err.Error())
			agentRC = 1
		}
	} else if err := ensureAgentServiceRunning(m, targetExe); err != nil {
		writeDeployLog("[watchdog]", "service not running: "+err.Error())
		agentRC = 1
	} else {
		// The service being RUNNING says nothing about the agent loop inside
		// it (a startup failure used to leave a dead loop behind a healthy-
		// looking service). The lifecycle state file distinguishes Service
		// Running / Agent Initializing / Agent Operational / Agent Faulted.
		checkAgentLifecycleFromWatchdog(m, targetExe)
	}

	// Also keep TECHI Remote Support alive: if an operator (or the user) stops
	// or closes it, remote access is lost until the next agent heartbeat. The
	// watchdog gives an independent 5-minute safety net even when the agent
	// itself is down. Only START an existing service — creation/config/binPath
	// is the agent's job (rustdesk_manage.go ensureRustDeskService).
	ensureRemoteSupportRunningFromWatchdog(m)
	return agentRC
}

// restoreMissingAgentExe copies an exe back over a missing techi-agent.exe
// (see agentExeRestoreSource for the order).
func restoreMissingAgentExe(targetExe string) error {
	self, err := os.Executable()
	if err != nil {
		self = ""
	}
	if strings.EqualFold(self, targetExe) {
		self = ""
	}
	source := agentExeRestoreSource(agentBackupExePath(), self, fileExists)
	if source == "" {
		return fmt.Errorf("no backup and no watchdog copy")
	}
	writeDeployLog("[watchdog]", "agent exe missing; restoring from "+source)
	if err := copyFileWithRetry(source, targetExe, "[watchdog]"); err != nil {
		return err
	}
	writeDeployLog("[watchdog]", "agent exe restored")
	return nil
}

// removeAgentLeftovers deletes what the MSI does not own after an uninstall:
// the swap backup now, the running watchdog copy at the next reboot.
func removeAgentLeftovers() {
	_ = os.Remove(agentBackupExePath())
	_ = os.Remove(swapMarkerPath())
	self, err := os.Executable()
	if err != nil || !strings.EqualFold(filepath.Base(self), agentWatchdogExeName) {
		return
	}
	if p, err := windows.UTF16PtrFromString(self); err == nil {
		_ = windows.MoveFileEx(p, nil, windows.MOVEFILE_DELAY_UNTIL_REBOOT)
	}
}

// lifecycleStaleAfter marks an initializing agent as wedged: while starting
// up, the agent refreshes agent.state.json on every config retry (backoff
// caps at 5 minutes) and every heartbeat attempt, so a startup-state file
// this old means the loop is stuck, not retrying.
const lifecycleStaleAfter = 30 * time.Minute

// checkAgentLifecycleFromWatchdog inspects the lifecycle state file written
// by the agent loop (lifecycle.go) and restarts the service when the agent
// is Faulted or has been stuck initializing past lifecycleStaleAfter. A
// healthy Operational agent logs nothing — deploy.log stays quiet.
func checkAgentLifecycleFromWatchdog(m *mgr.Mgr, targetExe string) {
	status, err := readLifecycleStatus()
	if err != nil {
		// Missing file: agent predates the lifecycle or hasn't started yet.
		if !os.IsNotExist(err) {
			writeDeployLog("[watchdog]", "lifecycle state unreadable: "+err.Error())
		}
		return
	}
	if status.State == stateOperational {
		return
	}

	age := time.Since(status.UpdatedAt)
	bucket := "Agent Initializing"
	if status.State == stateFaulted {
		bucket = "Agent Faulted"
	}
	writeDeployLog("[watchdog]", fmt.Sprintf(
		"service RUNNING but agent state=%s (%s) age=%s detail=%q",
		status.State, bucket, age.Round(time.Second), status.Detail))

	if status.State != stateFaulted && age <= lifecycleStaleAfter {
		return // still initializing and actively retrying — leave it alone
	}

	writeDeployLog("[watchdog]", "agent loop unhealthy; restarting TechiAgent service")
	if service, err := m.OpenService(serviceName); err == nil {
		if _, err := service.Control(svc.Stop); err != nil {
			writeDeployLog("[watchdog]", "lifecycle restart: stop control error: "+err.Error())
		}
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			st, qerr := service.Query()
			if qerr != nil || st.State == svc.Stopped {
				break
			}
			time.Sleep(2 * time.Second)
		}
		service.Close()
	}
	if err := ensureAgentServiceRunning(m, targetExe); err != nil {
		writeDeployLog("[watchdog]", "lifecycle restart failed: "+err.Error())
		return
	}
	writeDeployLog("[watchdog]", "lifecycle restart: service restarted")
}

// ensureRemoteSupportRunningFromWatchdog starts the "TECHI Remote Support"
// service if it exists and is not running. It never creates the service.
func ensureRemoteSupportRunningFromWatchdog(m *mgr.Mgr) {
	rs, err := m.OpenService(rustdeskServiceName)
	if err != nil {
		// Not installed yet, or agent hasn't created it — nothing to do here.
		return
	}
	defer rs.Close()
	status, err := rs.Query()
	if err != nil {
		return
	}
	if status.State == svc.Running || status.State == svc.StartPending {
		return
	}
	if err := rs.Start(); err != nil {
		writeDeployLog("[watchdog]", "remote support start failed: "+err.Error())
		return
	}
	writeDeployLog("[watchdog]", "remote support was stopped; started")
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
