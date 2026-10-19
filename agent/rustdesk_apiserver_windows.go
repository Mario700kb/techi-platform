//go:build windows

package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/host"
	gopsprocess "github.com/shirou/gopsutil/v3/process"
)

// remoteSupportReloadBootWindow bounds when the agent may restart Remote
// Support to load an updated configuration: right after boot nobody is
// connected yet. Outside it the change takes effect at the next restart, so a
// technician's session is never cut to apply it.
const remoteSupportReloadBootWindow = 10 * time.Minute

var lastRemoteSupportReload time.Time

// ensurePlatformAPIServer points Remote Support at the platform as its
// api-server wherever none is set, so RustDesk reports every connection
// (opened, password accepted, closed) and refused logins to the platform.
// The MSI writes no api-server since 2.1.24; installs before it wrote the
// platform URL, which is kept. A value someone chose (rustdesk_api_server, or
// any other non-empty value) is left as it is.
func ensurePlatformAPIServer(cfg *Config) {
	if cfg.RustDeskAPIServer != "" {
		return
	}
	apiServer := platformAPIServer(cfg)
	if apiServer == "" {
		return
	}
	updated := 0
	for _, dir := range rustDeskConfigDirs() {
		path := filepath.Join(dir, "TECHI Remote Support2.toml")
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		patched, changed := setTOMLOptionIfEmpty(string(data), "api-server", apiServer)
		if !changed {
			continue
		}
		if isReadOnlyFile(path) {
			removeTomlReadOnly(path) // agents before 2.1.35 left it read-only
		}
		err = os.WriteFile(path, []byte(patched), 0644)
		if err != nil {
			log.Printf("[rustdesk_manage] api-server update failed %s: %v", path, err)
			continue
		}
		log.Printf("[rustdesk_manage] api-server set to the platform: %s", path)
		updated++
	}
	if updated > 0 {
		reloadRemoteSupportIfIdle()
	}
}

func reloadRemoteSupportIfIdle() {
	uptime, err := host.Uptime()
	if err != nil || time.Duration(uptime)*time.Second > remoteSupportReloadBootWindow {
		log.Printf("[rustdesk_manage] Remote Support picks up the updated configuration at its next restart")
		return
	}
	if !lastRemoteSupportReload.IsZero() {
		return
	}
	if remoteSupportSessionActive(brandedRemoteSupportCmdlines()) {
		log.Printf("[rustdesk_manage] remote session active; Remote Support picks up the updated configuration at its next restart")
		return
	}
	lastRemoteSupportReload = time.Now()
	log.Printf("[rustdesk_manage] restarting Remote Support to load the updated configuration (uptime %ds, no session)", uptime)
	stopRustDeskServiceFn()
	if err := startRustDeskServiceFn(); err != nil {
		log.Printf("[rustdesk_manage] Remote Support restart failed: %v", err)
	}
}

// brandedRemoteSupportCmdlines returns the command line of every branded
// Remote Support process; a failed enumeration is reported as one unreadable
// entry so remoteSupportSessionActive fails safe.
func brandedRemoteSupportCmdlines() []string {
	procs, err := gopsprocess.Processes()
	if err != nil {
		return []string{""}
	}
	var cmdlines []string
	for _, p := range procs {
		name, nameErr := p.Name()
		if nameErr != nil || strings.ToLower(strings.TrimSpace(name)) != remoteSupportBrandedImageName {
			continue
		}
		cmdline, cmdErr := p.Cmdline()
		if cmdErr != nil {
			cmdline = ""
		}
		cmdlines = append(cmdlines, cmdline)
	}
	return cmdlines
}

var identityHealRestart time.Time

// restartRemoteSupportForIdentity restarts Remote Support once after its
// identity file was made writable again, so it generates and stores a key
// pair now instead of at its next chance restart. Never during a session.
func restartRemoteSupportForIdentity() {
	if !identityHealRestart.IsZero() {
		return
	}
	if remoteSupportSessionActive(brandedRemoteSupportCmdlines()) {
		log.Printf("[rustdesk_manage] identity file healed; remote session active, Remote Support keeps its ID from its next restart")
		return
	}
	identityHealRestart = time.Now()
	log.Printf("[rustdesk_manage] restarting Remote Support so it stores its key pair and keeps its ID")
	stopRustDeskServiceFn()
	if err := startRustDeskServiceFn(); err != nil {
		log.Printf("[rustdesk_manage] Remote Support restart failed: %v", err)
	}
}
