//go:build windows

package main

// Native (script-free) MSI custom-action bodies.
//
// The combined bootstrap MSI (installer.wxs) used to run its post-install
// steps through PowerShell one-liners. Strict AV/AMSI policies (Symantec,
// CybeeAI, ...) block those scripts, leaving fresh installs half-configured.
// The MSI now calls the agent exe it just installed:
//
//   techi-agent.exe bootstrap-config -api-url ... -enrollment-token ...
//                                    [-reenroll 1] [-rustdesk-server ...]
//                                    [-rustdesk-relay ...] [-rustdesk-key ...]
//   techi-agent.exe rs-tray-task
//
// Only Microsoft-signed system binaries (schtasks.exe) are spawned.

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

// runBootstrapConfigCommand mirrors the old WriteAgentConfig custom action:
// create C:\ProgramData\TechiAgent\logs and agent.config.json, but only when the
// config does not exist yet — or when -reenroll 1 (manual install with a new
// token) explicitly asks to overwrite. Field set matches the old PS body.
func runBootstrapConfigCommand(args []string) int {
	fs := flag.NewFlagSet("bootstrap-config", flag.ContinueOnError)
	apiURL := fs.String("api-url", "https://api-rdp.techi.com.al", "backend api url")
	enrollmentToken := fs.String("enrollment-token", "", "enrollment token for first heartbeat")
	reenroll := fs.String("reenroll", "", "set to 1 to overwrite an existing config (manual re-enroll)")
	rustdeskServer := fs.String("rustdesk-server", "", "rustdesk rendezvous server")
	rustdeskRelay := fs.String("rustdesk-relay", "", "rustdesk relay server")
	rustdeskKey := fs.String("rustdesk-key", "", "rustdesk public key")
	rustdeskPassword := fs.String("rustdesk-password", "", "rustdesk default permanent password")
	if err := fs.Parse(args); err != nil {
		return 1
	}

	dataDir := filepath.Dir(windowsConfigPath)
	if err := os.MkdirAll(filepath.Join(dataDir, "logs"), 0755); err != nil {
		writeDeployLog("[bootstrap-config]", "mkdir failed: "+err.Error())
		return 1
	}

	if _, err := os.Stat(windowsConfigPath); err == nil && strings.TrimSpace(*reenroll) != "1" {
		writeDeployLog("[bootstrap-config]", "config preserved path="+windowsConfigPath)
		return 0
	}

	cfg := map[string]interface{}{
		"api_url":                    strings.TrimSpace(*apiURL),
		"enrollment_token":           strings.TrimSpace(*enrollmentToken),
		"timeout_seconds":            30,
		"heartbeat_interval_seconds": 60,
		"retries":                    3,
		"retry_delay_seconds":        10,
		"collect_processes":          true,
		"collect_software":           true,
		"collect_services":           true,
	}
	if strings.TrimSpace(*rustdeskServer) != "" {
		cfg["rustdesk_manage_enabled"] = true
		cfg["rustdesk_rendezvous_server"] = strings.TrimSpace(*rustdeskServer)
		cfg["rustdesk_relay_server"] = strings.TrimSpace(*rustdeskRelay)
		cfg["rustdesk_key"] = strings.TrimSpace(*rustdeskKey)
	}
	// The agent sets this as the RustDesk permanent password on every heartbeat
	// (rustdesk_manage.go setRustDeskPassword) once the identity TOML exists.
	// Without it in the config, GPO/MSI installs leave a random RS password and
	// the managed connect-url password never matches.
	if strings.TrimSpace(*rustdeskPassword) != "" {
		cfg["rustdesk_default_password"] = strings.TrimSpace(*rustdeskPassword)
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return 1
	}
	if err := os.WriteFile(windowsConfigPath, data, 0600); err != nil {
		writeDeployLog("[bootstrap-config]", "config write failed: "+err.Error())
		return 1
	}
	lockdownConfigACL(windowsConfigPath)
	writeDeployLog("[bootstrap-config]", "config created path="+windowsConfigPath)
	return 0
}

// runInstallerHealthCheckCommand is the MSI transaction's authoritative
// success gate. A RUNNING service alone is not Agent operational health.
func runInstallerHealthCheckCommand() int {
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		status, err := readLifecycleStatus()
		if err == nil && status.State == stateOperational && time.Since(status.UpdatedAt) < 5*time.Minute && windowsPIDIsLive(status.PID) {
			writeDeployLog("[installer-health]", "operational")
			return 0
		}
		if err == nil && status.State == stateFaulted {
			writeDeployLog("[installer-health]", "failed state=faulted")
			return 1
		}
		time.Sleep(2 * time.Second)
	}
	writeDeployLog("[installer-health]", "failed reason=operational_timeout")
	return 1
}

func windowsPIDIsLive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	windows.CloseHandle(h)
	return true
}

// runRSTrayTaskCommand mirrors the old CreateRustDeskTrayTask custom action:
// register the "TECHI Remote Support Tray" logon task for the local Users
// group with no execution time limit, then trigger it once for the session
// that is already logged on. Registration goes through `schtasks /XML` — the
// task definition is data, not a script, so AV/AMSI has nothing to block.
func runRSTrayTaskCommand() int {
	programFiles := strings.TrimSpace(os.Getenv("ProgramFiles"))
	if programFiles == "" {
		programFiles = `C:\Program Files`
	}
	rsExe := filepath.Join(programFiles, "TECHI Remote Support", "TECHI Remote Support.exe")

	xmlPath := filepath.Join(os.TempDir(), "techi-rs-tray-task.xml")
	if err := os.WriteFile(xmlPath, encodeUTF16LEWithBOM(rsTrayTaskXML(rsExe)), 0600); err != nil {
		writeDeployLog("[rs-tray-task]", "task xml write failed: "+err.Error())
		return 1
	}
	defer os.Remove(xmlPath)

	create := exec.Command(schtasksPath(), "/Create", "/TN", rustdeskTrayTaskName, "/XML", xmlPath, "/F")
	if out, err := create.CombinedOutput(); err != nil {
		writeDeployLog("[rs-tray-task]", fmt.Sprintf("task register failed: %v: %s", err, strings.TrimSpace(string(out))))
		return 1
	}
	writeDeployLog("[rs-tray-task]", "task registered, exe="+rsExe)

	// Best effort: the "At Logon" trigger does not fire for a session that is
	// already active during a manual install; /Run starts it once now. On a
	// /quiet install with no interactive user this simply does nothing.
	run := exec.Command(schtasksPath(), "/Run", "/TN", rustdeskTrayTaskName)
	if _, err := run.CombinedOutput(); err == nil {
		writeDeployLog("[rs-tray-task]", "task run triggered")
	}
	return 0
}

// rsTrayTaskXML is the Task Scheduler definition previously built with
// PowerShell ScheduledTasks cmdlets: logon trigger, BUILTIN\Users group
// principal (SID, locale-safe), least privilege, battery-friendly, and
// ExecutionTimeLimit PT0S (no limit — the schtasks CLI cannot express that,
// which is why the definition ships as XML).
func rsTrayTaskXML(rsExe string) string {
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <GroupId>S-1-5-32-545</GroupId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>` + xmlEscape(rsExe) + `</Command>
      <Arguments>--tray</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

func xmlEscape(s string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	)
	return replacer.Replace(s)
}

// encodeUTF16LEWithBOM converts s to UTF-16LE with a byte-order mark, the
// canonical encoding Task Scheduler uses for exported task definitions.
func encodeUTF16LEWithBOM(s string) []byte {
	codes := utf16.Encode([]rune(s))
	buf := make([]byte, 0, 2+len(codes)*2)
	buf = append(buf, 0xFF, 0xFE)
	for _, c := range codes {
		buf = append(buf, byte(c), byte(c>>8))
	}
	return buf
}
