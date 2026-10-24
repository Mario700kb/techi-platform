//go:build windows

package main

// Operator actions on a Windows PC's processes, services and software
// (2.1.41): end a process, start/stop/restart a service, uninstall an app.
// Each runs as native code and checks what the operator saw again on the PC
// before it acts — a PID must still belong to the process of that name, an
// uninstall key must still name that app — and none touches the agent,
// Remote Support or the parts of Windows that keep the PC running.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	gopsprocess "github.com/shirou/gopsutil/v3/process"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	serviceStateWait = 60 * time.Second
	processExitWait  = 10 * time.Second
	uninstallTimeout = 15 * time.Minute
)

// protectedProcesses cannot be ended from the console: Windows itself (ending
// them logs everyone off or stops the PC), this agent and Remote Support.
var protectedProcesses = map[string]bool{
	"system":                   true,
	"registry":                 true,
	"smss.exe":                 true,
	"csrss.exe":                true,
	"wininit.exe":              true,
	"winlogon.exe":             true,
	"services.exe":             true,
	"lsass.exe":                true,
	"lsaiso.exe":               true,
	"svchost.exe":              true, // hosts many services; stop the service instead
	"dwm.exe":                  true,
	"msmpeng.exe":              true,
	"techi-agent.exe":          true,
	"techi-agent-watchdog.exe": true,
	"techi remote support.exe": true,
	"rustdesk.exe":             true,
}

// protectedServices cannot be stopped or restarted from the console (starting
// them is always allowed): this agent, Remote Support, and the services
// without which Windows, its networking or the watchdog task stop working.
var protectedServices = map[string]bool{
	"techiagent":             true,
	"techi remote support":   true,
	"rpcss":                  true,
	"rpceptmapper":           true,
	"dcomlaunch":             true,
	"lsm":                    true,
	"samss":                  true,
	"plugplay":               true,
	"power":                  true,
	"brokerinfrastructure":   true,
	"coremessagingregistrar": true,
	"systemeventsbroker":     true,
	"schedule":               true,
	"eventlog":               true,
	"profsvc":                true,
	"gpsvc":                  true,
	"nsi":                    true,
	"dhcp":                   true,
	"bfe":                    true,
	"mpssvc":                 true,
}

var uninstallRoots = []struct {
	prefix string
	root   registry.Key
}{
	{`HKEY_LOCAL_MACHINE\SOFTWARE\MICROSOFT\WINDOWS\CURRENTVERSION\UNINSTALL\`, registry.LOCAL_MACHINE},
	{`HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432NODE\MICROSOFT\WINDOWS\CURRENTVERSION\UNINSTALL\`, registry.LOCAL_MACHINE},
	{`HKEY_CURRENT_USER\SOFTWARE\MICROSOFT\WINDOWS\CURRENTVERSION\UNINSTALL\`, registry.CURRENT_USER},
}

// ------------------------------------------------------------------ //
// kill_process                                                        //
// ------------------------------------------------------------------ //

func handleKillProcess(ctx context.Context, cfg *Config, params map[string]interface{}) actionResult {
	pid, ok := intParam(params, "pid")
	name := stringParam(params, "name")
	if !ok || pid <= 4 || name == "" {
		return actionResult{err: fmt.Errorf("kill_process needs the PID and name of the process")}
	}
	if pid == int64(os.Getpid()) || protectedProcesses[strings.ToLower(name)] {
		return actionResult{err: fmt.Errorf("%s is protected and cannot be ended from the console", name)}
	}
	p, err := gopsprocess.NewProcessWithContext(ctx, int32(pid))
	if err != nil {
		return actionResult{err: fmt.Errorf("%s (PID %d) is no longer running", name, pid)}
	}
	actual, err := p.NameWithContext(ctx)
	if err != nil || !strings.EqualFold(actual, name) {
		return actionResult{err: fmt.Errorf("PID %d is no longer %s (now %q); nothing was ended", pid, name, actual)}
	}
	if err := p.KillWithContext(ctx); err != nil {
		return actionResult{err: fmt.Errorf("could not end %s (PID %d): %v", actual, pid, err)}
	}
	deadline := time.Now().Add(processExitWait)
	for time.Now().Before(deadline) {
		if running, err := p.IsRunningWithContext(ctx); err != nil || !running {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	refreshInventorySoon(cfg)
	return actionResult{message: fmt.Sprintf("Ended %s (PID %d)", actual, pid)}
}

// ------------------------------------------------------------------ //
// service_control                                                     //
// ------------------------------------------------------------------ //

func handleServiceControl(ctx context.Context, cfg *Config, params map[string]interface{}) actionResult {
	name := stringParam(params, "name")
	operation := strings.ToLower(stringParam(params, "operation"))
	if name == "" {
		return actionResult{err: fmt.Errorf("service_control needs the service name")}
	}
	if operation != "start" && operation != "stop" && operation != "restart" {
		return actionResult{err: fmt.Errorf("service_control: unknown operation %q (start, stop or restart)", operation)}
	}
	if operation != "start" && protectedServices[strings.ToLower(name)] {
		return actionResult{err: fmt.Errorf("%s keeps Windows or this agent running; it cannot be stopped or restarted from the console", name)}
	}

	m, err := mgr.Connect()
	if err != nil {
		return actionResult{err: fmt.Errorf("service manager: %v", err)}
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return actionResult{err: fmt.Errorf("service %s not found", name)}
	}
	defer s.Close()

	var message string
	switch operation {
	case "start":
		message, err = startServiceAndWait(ctx, s, name)
	case "stop":
		message, err = stopServiceAndWait(ctx, s, name)
	case "restart":
		if _, err = stopServiceAndWait(ctx, s, name); err == nil {
			if _, err = startServiceAndWait(ctx, s, name); err == nil {
				message = "Restarted " + name
			}
		}
	}
	refreshInventorySoon(cfg)
	if err != nil {
		return actionResult{err: err}
	}
	return actionResult{message: message}
}

func startServiceAndWait(ctx context.Context, s *mgr.Service, name string) (string, error) {
	status, err := s.Query()
	if err == nil && status.State == svc.Running {
		return name + " is already running", nil
	}
	if config, err := s.Config(); err == nil && config.StartType == mgr.StartDisabled {
		return "", fmt.Errorf("%s is disabled; set its startup type before starting it", name)
	}
	if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return "", fmt.Errorf("could not start %s: %v", name, err)
	}
	if err := waitServiceState(ctx, s, svc.Running); err != nil {
		return "", fmt.Errorf("%s did not start: %v", name, err)
	}
	return "Started " + name, nil
}

func stopServiceAndWait(ctx context.Context, s *mgr.Service, name string) (string, error) {
	status, err := s.Query()
	if err == nil && status.State == svc.Stopped {
		return name + " is already stopped", nil
	}
	if _, err := s.Control(svc.Stop); err != nil {
		switch {
		case errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE):
			return name + " is already stopped", nil
		case errors.Is(err, windows.ERROR_DEPENDENT_SERVICES_RUNNING):
			return "", fmt.Errorf("other running services depend on %s; stop them first", name)
		case errors.Is(err, windows.ERROR_INVALID_SERVICE_CONTROL):
			return "", fmt.Errorf("%s does not accept a stop request", name)
		default:
			return "", fmt.Errorf("could not stop %s: %v", name, err)
		}
	}
	if err := waitServiceState(ctx, s, svc.Stopped); err != nil {
		return "", fmt.Errorf("%s did not stop: %v", name, err)
	}
	return "Stopped " + name, nil
}

func waitServiceState(ctx context.Context, s *mgr.Service, want svc.State) error {
	started := time.Now()
	deadline := started.Add(serviceStateWait)
	for {
		status, err := s.Query()
		if err != nil {
			return err
		}
		if status.State == want {
			return nil
		}
		// A start that fails leaves the service stopped, not pending.
		if want == svc.Running && status.State == svc.Stopped && time.Since(started) > 2*time.Second {
			return fmt.Errorf("it stopped again (exit code %d)", status.Win32ExitCode)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("still %s after %s", serviceStateName(status.State), serviceStateWait)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// ------------------------------------------------------------------ //
// uninstall_software                                                  //
// ------------------------------------------------------------------ //

type uninstallEntry struct {
	name             string
	windowsInstaller bool
	quietCommand     string
	uninstallString  string
	inno             bool
}

func (e uninstallEntry) silent() silentUninstall {
	return silentUninstallFor(e.name, e.quietCommand, e.uninstallString, e.inno)
}

func handleUninstallSoftware(ctx context.Context, cfg *Config, params map[string]interface{}) actionResult {
	key := stringParam(params, "uninstall_key")
	name := stringParam(params, "name")
	if key == "" || name == "" {
		return actionResult{err: fmt.Errorf("uninstall_software needs the app's name and uninstall key")}
	}
	if isProtectedSoftware(name) {
		return actionResult{err: fmt.Errorf("%s is part of TECHI and cannot be uninstalled from the console", name)}
	}
	entry, err := readUninstallEntry(key)
	if err != nil {
		return actionResult{err: err}
	}
	if !strings.EqualFold(strings.TrimSpace(entry.name), name) {
		return actionResult{err: fmt.Errorf("the uninstall entry now names %q, not %s; nothing was removed", entry.name, name)}
	}

	ctx, cancel := context.WithTimeout(ctx, uninstallTimeout)
	defer cancel()
	var message string
	silent := entry.silent()
	switch uninstallMethod(key, entry.windowsInstaller, silent.command != "") {
	case "msi":
		message, err = runMsiUninstall(ctx, registryLeaf(key), entry.name)
	case "quiet":
		message, err = runQuietUninstall(ctx, silent, entry.name)
	default:
		err = fmt.Errorf("%s has no silent uninstall; remove it over Remote Support", entry.name)
	}
	refreshInventorySoon(cfg)
	if err != nil {
		return actionResult{err: err}
	}
	return actionResult{message: message}
}

func isProtectedSoftware(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	return lower == "techi agent" || strings.HasPrefix(lower, "techi remote support") || strings.HasPrefix(lower, "techi endpoint")
}

// openUninstallKey opens one of the three Uninstall keys' direct children,
// never anything else, in the 64-bit view (the WOW6432Node path is explicit).
func openUninstallKey(key string) (registry.Key, error) {
	clean := strings.TrimSpace(key)
	upper := strings.ToUpper(clean)
	for _, r := range uninstallRoots {
		if !strings.HasPrefix(upper, r.prefix) {
			continue
		}
		leaf := clean[len(r.prefix):]
		if leaf == "" || strings.ContainsAny(leaf, "\\/\"\x00") {
			break
		}
		path := clean[len(`HKEY_LOCAL_MACHINE\`):]
		if r.root == registry.CURRENT_USER {
			path = clean[len(`HKEY_CURRENT_USER\`):]
		}
		return registry.OpenKey(r.root, path, registry.QUERY_VALUE|registry.WOW64_64KEY)
	}
	return 0, fmt.Errorf("%q is not an app's uninstall entry", key)
}

func readUninstallEntry(key string) (uninstallEntry, error) {
	k, err := openUninstallKey(key)
	if errors.Is(err, registry.ErrNotExist) {
		return uninstallEntry{}, fmt.Errorf("the app is no longer installed (its uninstall entry is gone)")
	}
	if err != nil {
		return uninstallEntry{}, err
	}
	defer k.Close()
	var entry uninstallEntry
	entry.name, _, _ = k.GetStringValue("DisplayName")
	if v, _, err := k.GetIntegerValue("WindowsInstaller"); err == nil {
		entry.windowsInstaller = v == 1
	}
	entry.quietCommand = expandedString(k, "QuietUninstallString")
	entry.uninstallString = expandedString(k, "UninstallString")
	if _, _, err := k.GetStringValue("Inno Setup: Setup Version"); err == nil {
		entry.inno = true
	}
	return entry, nil
}

func expandedString(k registry.Key, name string) string {
	v, valueType, err := k.GetStringValue(name)
	if err != nil {
		return ""
	}
	if valueType == registry.EXPAND_SZ {
		if expanded, err := registry.ExpandString(v); err == nil {
			v = expanded
		}
	}
	return strings.TrimSpace(v)
}

func runMsiUninstall(ctx context.Context, productCode string, name string) (string, error) {
	systemRoot := strings.TrimSpace(os.Getenv("SystemRoot"))
	if systemRoot == "" {
		systemRoot = `C:\Windows`
	}
	msiexec := filepath.Join(systemRoot, "System32", "msiexec.exe")
	cmd := exec.CommandContext(ctx, msiexec, "/x", productCode, "/qn", "/norestart")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	err := cmd.Run()
	code := exitCode(err)
	switch {
	case ctx.Err() != nil:
		return "", fmt.Errorf("uninstalling %s did not finish within %s", name, uninstallTimeout)
	case code == 0:
		return "Uninstalled " + name, nil
	case code == 3010 || code == 1641:
		return "Uninstalled " + name + "; a restart finishes it", nil
	case code == 1605:
		return name + " was already uninstalled", nil
	case code == 1618:
		return "", fmt.Errorf("another installation is running on the PC; try again when it finishes")
	case code > 0:
		return "", fmt.Errorf("uninstalling %s failed: Windows Installer error %d", name, code)
	default:
		return "", fmt.Errorf("could not run msiexec: %v", err)
	}
}

func runQuietUninstall(ctx context.Context, silent silentUninstall, name string) (string, error) {
	command := silent.command
	exe := commandExecutable(command)
	if exe == "" {
		return "", fmt.Errorf("the quiet uninstall command of %s is empty", name)
	}
	cmd := exec.CommandContext(ctx, exe)
	// The registered command line is passed as is: its own quoting and flags.
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: command, HideWindow: true}
	err := cmd.Run()
	code := exitCode(err)
	switch {
	case ctx.Err() != nil:
		return "", fmt.Errorf("uninstalling %s did not finish within %s", name, uninstallTimeout)
	case code == 0:
		return "Uninstalled " + name, nil
	case code == 3010:
		return "Uninstalled " + name + "; a restart finishes it", nil
	case slices.Contains(silent.okCodes, code):
		return "Uninstalled " + name, nil
	case code > 0:
		return "", fmt.Errorf("the uninstaller of %s exited with code %d", name, code)
	default:
		return "", fmt.Errorf("could not run the uninstaller of %s: %v", name, err)
	}
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

// ------------------------------------------------------------------ //
// shared                                                              //
// ------------------------------------------------------------------ //

// refreshInventorySoon collects processes, services and software again and
// sends them with an immediate heartbeat, so the console shows the result.
func refreshInventorySoon(cfg *Config) {
	go func() {
		heavyInventory.forceCollect(cfg)
		pendingForceInventory.Store(true)
		pendingImmediateHeartbeat.Store(true)
		wakeHeartbeat()
	}()
}

func intParam(params map[string]interface{}, key string) (int64, bool) {
	switch v := params[key].(type) {
	case float64:
		if v == float64(int64(v)) {
			return int64(v), true
		}
	case int:
		return int64(v), true
	case int64:
		return v, true
	}
	return 0, false
}
