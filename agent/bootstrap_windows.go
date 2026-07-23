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
//   techi-agent.exe remove-tray-artifacts
//   techi-agent.exe stop-remote-support-runtime
//
// Only Microsoft-signed system binaries (schtasks.exe) are spawned.

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// runBootstrapConfigCommand mirrors the old WriteAgentConfig custom action:
// create C:\ProgramData\TECHI\logs and agent.config.json, but only when the
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

	dataDir := filepath.Dir(windowsLegacyConfigPath)
	if err := os.MkdirAll(filepath.Join(dataDir, "logs"), 0755); err != nil {
		writeDeployLog("[bootstrap-config]", "mkdir failed: "+err.Error())
		return 1
	}

	if _, err := os.Stat(windowsLegacyConfigPath); err == nil && strings.TrimSpace(*reenroll) != "1" {
		writeDeployLog("[bootstrap-config]", "config preserved path="+windowsLegacyConfigPath)
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
	if err := os.WriteFile(windowsLegacyConfigPath, data, 0600); err != nil {
		writeDeployLog("[bootstrap-config]", "config write failed: "+err.Error())
		return 1
	}
	writeDeployLog("[bootstrap-config]", "config created path="+windowsLegacyConfigPath)
	return 0
}

// runRemoveTrayArtifactsCommand implements the `remove-tray-artifacts`
// subcommand: it deletes the deprecated "TECHI Remote Support Tray" logon task
// and every other --tray startup path (autostart values, startup shortcuts,
// stale --tray processes).
//
// The MSI custom action that used to CREATE that task is gone. The old
// `rs-tray-task` name stays wired to this same removal in main.go, because MSIs
// already deployed in the field still invoke it -- on those endpoints it now
// converges them onto the supported architecture instead of re-registering the
// task. New callers must use `remove-tray-artifacts`.
func runRemoveTrayArtifactsCommand() int {
	removal := removeManagedTrayArtifacts()
	writeDeployLog("[remove-tray-artifacts]", "deprecated tray startup removed: "+removal.Summary())
	return 0
}

// runStopRemoteSupportRuntimeCommand implements `stop-remote-support-runtime`:
// stop the managed service and terminate the Remote Support processes BY PID so
// an installer can replace files. Replaces the blanket
// `taskkill /F /IM "TECHI Remote Support.exe"` the MSI custom actions ran, which
// killed every process sharing the executable name.
func runStopRemoteSupportRuntimeCommand() int {
	stopped := stopRemoteSupportRuntimeByPID()
	writeDeployLog("[stop-remote-support-runtime]", fmt.Sprintf("service stopped, %d process(es) terminated by pid", stopped))
	return 0
}
