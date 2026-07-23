//go:build windows

package main

import (
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	gopsprocess "github.com/shirou/gopsutil/v3/process"
	"golang.org/x/sys/windows/svc/mgr"
)

// remoteSupportBrandedImageName / remoteSupportLegacyImageName are the two exe
// names Remote Support can run under. All four managed processes (--service,
// --server, two --tray) share the branded name, which is exactly why image name
// alone can never establish the runtime role.
const (
	remoteSupportBrandedImageName = "techi remote support.exe"
	remoteSupportLegacyImageName  = "rustdesk.exe"
)

// remoteSupportServiceState reads the SCM state of the managed service through
// the Service Control Manager API rather than parsing sc.exe output.
//
// This removes every failure mode the previous `sc query "TECHI Remote Support"`
// text scrape had: the service name is passed as an exact string (no shell
// quoting), a missing service surfaces as ERROR_SERVICE_DOES_NOT_EXIST (1060)
// instead of an opaque non-zero exit, there is no output to parse, and the
// returned state is a NUMERIC SERVICE_STATUS code -- so a localized Windows
// (where sc.exe prints neither "RUNNING" nor "STOPPED") is read correctly.
//
// An error here means "state undetermined" and is returned to the caller to be
// logged; it must never be interpreted as evidence about the installation.
func remoteSupportServiceState() (string, error) {
	return windowsServiceState(rustdeskServiceName)
}

// windowsServiceState is THE authoritative service-state reader for the agent:
// discovery, deployment, repair, reinstall and the periodic service check all
// go through it. There is no second implementation and no sc.exe output parsing
// anywhere in the Remote Support path.
func windowsServiceState(name string) (string, error) {
	m, err := mgr.Connect()
	if err != nil {
		return "", fmt.Errorf("SCM connect: %w", err)
	}
	defer m.Disconnect()

	service, err := m.OpenService(name)
	if err != nil {
		return "", fmt.Errorf("open service %q: %w", name, err)
	}
	defer service.Close()

	status, err := service.Query()
	if err != nil {
		return "", fmt.Errorf("query service %q: %w", name, err)
	}

	state := remoteSupportServiceStateName(uint32(status.State))
	if state == "" {
		return "", fmt.Errorf("service %q returned unrecognized SERVICE_STATUS state %d", name, status.State)
	}
	return state, nil
}

// windowsServiceExists reports registration (not run state). A service that
// exists but cannot be queried still counts as existing -- the distinction the
// old `sc query` substring check could not make.
func windowsServiceExists(name string) bool {
	m, err := mgr.Connect()
	if err != nil {
		log.Printf("[rustdesk] service existence probe: SCM connect failed: %v", err)
		return false
	}
	defer m.Disconnect()

	service, err := m.OpenService(name)
	if err != nil {
		return false
	}
	service.Close()
	return true
}

// legacyRemoteSupportServiceRunning reports whether an upstream RustDesk service
// is running -- the dual-install signal. Same authoritative reader.
func legacyRemoteSupportServiceRunning() bool {
	for _, name := range []string{"RustDesk", "rustdesk"} {
		if state, err := windowsServiceState(name); err == nil && state == "running" {
			return true
		}
	}
	return false
}

// verifiedRemoteSupportExePath returns the process's executable path when it can
// be established, either directly or from its command line. An empty result
// means "unverified" -- such a process is never a termination target.
func verifiedRemoteSupportExePath(p *gopsprocess.Process) string {
	if exe, err := p.Exe(); err == nil && strings.TrimSpace(exe) != "" {
		return exe
	}
	cmdline, err := p.Cmdline()
	if err != nil {
		return ""
	}
	return executablePathFromCommandLine(cmdline)
}

// remoteSupportProcessesUnder returns the PIDs of processes whose image name is
// one of names AND whose executable lives inside one of dirs.
//
// The install-path check is what makes termination safe: an unrelated program
// that merely happens to be called "TECHI Remote Support.exe" somewhere else on
// the disk is never touched, and a process whose path cannot be verified is
// skipped rather than killed on the strength of its filename.
func remoteSupportProcessesUnder(names []string, dirs []string) []int32 {
	procs, err := gopsprocess.Processes()
	if err != nil {
		log.Printf("[rustdesk] process selection: enumeration failed: %v", err)
		return nil
	}
	var pids []int32
	for _, p := range procs {
		name, nameErr := p.Name()
		if nameErr != nil {
			continue
		}
		lowerName := strings.ToLower(strings.TrimSpace(name))
		matched := false
		for _, candidate := range names {
			if lowerName == candidate {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		exePath := verifiedRemoteSupportExePath(p)
		if exePath == "" {
			log.Printf("[rustdesk] process selection: skipping pid=%d (%s) — executable path could not be verified", p.Pid, name)
			continue
		}
		if !executablePathUnderAny(exePath, dirs) {
			log.Printf("[rustdesk] process selection: skipping pid=%d (%s) — %s is outside the Remote Support install directories", p.Pid, name, exePath)
			continue
		}
		pids = append(pids, p.Pid)
	}
	return pids
}

// remoteSupportProcessPIDs returns every Remote Support process installed under a
// known Remote Support directory. Used by the install/uninstall stop paths.
func remoteSupportProcessPIDs() []int32 {
	return remoteSupportProcessesUnder(
		[]string{remoteSupportBrandedImageName, remoteSupportLegacyImageName},
		remoteSupportAllInstallDirs(),
	)
}

// legacyRemoteSupportProcessPIDs returns upstream rustdesk.exe processes only --
// the legacy runtime a migration must clear.
func legacyRemoteSupportProcessPIDs() []int32 {
	return remoteSupportProcessesUnder(
		[]string{remoteSupportLegacyImageName},
		remoteSupportAllInstallDirs(),
	)
}

// killProcessesByPID terminates exactly the given PIDs. Every process-stop path
// in the agent funnels through here: there is no blanket `taskkill /IM` against
// "TECHI Remote Support.exe" anywhere, because the managed daemon
// ("--service"/"--server") shares that image name with everything else.
func killProcessesByPID(reason string, pids []int32) int {
	stopped := 0
	for _, pid := range pids {
		if _, err := runWithTimeout(10*time.Second, "taskkill", "/F", "/PID", strconv.Itoa(int(pid))); err != nil {
			log.Printf("[rustdesk] %s: could not stop pid %d: %v", reason, pid, err)
			continue
		}
		stopped++
	}
	if stopped > 0 {
		log.Printf("[rustdesk] %s: stopped %d process(es) by pid", reason, stopped)
	}
	return stopped
}

// remoteSupportTrayProcessPIDs returns the PIDs of MANAGED processes running the
// branded exe with "--tray". Two independent checks must both pass: the
// executable must live in a managed install directory, and the command line must
// show tray mode and not "--service"/"--server" -- the daemon shares the image
// name and must survive the sweep.
func remoteSupportTrayProcessPIDs() []int32 {
	procs, err := gopsprocess.Processes()
	if err != nil {
		log.Printf("[rustdesk] tray sweep: process enumeration failed: %v", err)
		return nil
	}
	managedDirs := remoteSupportManagedInstallDirs()
	var pids []int32
	for _, p := range procs {
		name, nameErr := p.Name()
		if nameErr != nil || strings.ToLower(strings.TrimSpace(name)) != remoteSupportBrandedImageName {
			continue
		}
		cmdline, cmdErr := p.Cmdline()
		if cmdErr != nil {
			continue // role unknown -- never kill on a guess
		}
		lower := strings.ToLower(cmdline)
		if strings.Contains(lower, "--service") || strings.Contains(lower, "--server") {
			continue // the managed daemon: must survive
		}
		if !strings.Contains(lower, "--tray") {
			continue
		}
		exePath := verifiedRemoteSupportExePath(p)
		if !executablePathUnderAny(exePath, managedDirs) {
			log.Printf("[rustdesk] tray sweep: skipping pid=%d — %q is outside the managed install directories", p.Pid, exePath)
			continue
		}
		pids = append(pids, p.Pid)
	}
	return pids
}

// collectRemoteSupportProcessSignals separates the managed daemon from the
// cosmetic tray by reading each branded process's command line. gopsutil is
// already an agent dependency and reads this through the native Windows API --
// no PowerShell, no WMIC, no new runtime dependency.
func collectRemoteSupportProcessSignals() remoteSupportProcessSignals {
	procs, err := gopsprocess.Processes()
	if err != nil {
		log.Printf("[rustdesk] process enumeration failed: %v — falling back to image-name detection (roles unknown)", err)
		return remoteSupportProcessSignalsFromImageNames()
	}

	var brandedCmdlines []string
	legacy := false
	for _, p := range procs {
		name, nameErr := p.Name()
		if nameErr != nil {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(name)) {
		case remoteSupportBrandedImageName:
			cmdline, cmdErr := p.Cmdline()
			if cmdErr != nil {
				// Counted as branded-with-unknown-role, never dropped: losing the
				// process entirely would understate what is running.
				log.Printf("[rustdesk] command line unreadable for %s pid=%d: %v", name, p.Pid, cmdErr)
				cmdline = ""
			}
			brandedCmdlines = append(brandedCmdlines, cmdline)
		case remoteSupportLegacyImageName:
			legacy = true
		}
	}
	return classifyRemoteSupportProcessArgs(brandedCmdlines, legacy)
}

// remoteSupportProcessSignalsFromImageNames is the degraded fallback used only
// when process enumeration itself fails. It can prove presence but not role, so
// every branded process it finds is reported with an unknown role.
func remoteSupportProcessSignalsFromImageNames() remoteSupportProcessSignals {
	signals := remoteSupportProcessSignals{}
	if out, err := runWithTimeout(10*time.Second, "tasklist", "/FI", "IMAGENAME eq TECHI Remote Support.exe"); err == nil {
		if strings.Contains(strings.ToLower(string(out)), remoteSupportBrandedImageName) {
			signals.Branded = true
		}
	}
	if out, err := runWithTimeout(10*time.Second, "tasklist", "/FI", "IMAGENAME eq rustdesk.exe"); err == nil {
		if strings.Contains(strings.ToLower(string(out)), remoteSupportLegacyImageName) {
			signals.Legacy = true
		}
	}
	return signals
}
