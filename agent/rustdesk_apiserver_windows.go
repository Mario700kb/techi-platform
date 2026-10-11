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
// Support to load a cleaned configuration: right after boot nobody is
// connected yet. Outside it the cleaned file takes effect at the next
// restart, so a technician's session is never cut to apply it.
const remoteSupportReloadBootWindow = 10 * time.Minute

var lastRemoteSupportReload time.Time

// clearPlatformAPIServer removes an api-server that points Remote Support at
// the platform (RISK-SUPPLY-002) from every Config2 file. The MSI no longer
// writes it, but self_update replaces only techi-agent.exe, so devices that
// already carry it are cleaned here. An api-server the operator configured
// (rustdesk_api_server) is managed, not removed.
func clearPlatformAPIServer(cfg *Config) {
	if cfg.RustDeskAPIServer != "" {
		return
	}
	hosts := platformHosts(cfg)
	if len(hosts) == 0 {
		return
	}
	cleared := 0
	for _, dir := range rustDeskConfigDirs() {
		path := filepath.Join(dir, "TECHI Remote Support2.toml")
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		patched, changed := removeTOMLOptionIf(string(data), "api-server", func(v string) bool {
			return apiServerPointsAtPlatform(v, hosts)
		})
		if !changed {
			continue
		}
		readOnly := false
		if info, statErr := os.Stat(path); statErr == nil {
			readOnly = info.Mode().Perm()&0200 == 0
		}
		if readOnly {
			removeTomlReadOnly(path)
		}
		err = os.WriteFile(path, []byte(patched), 0644)
		if readOnly {
			setTomlReadOnly(path)
		}
		if err != nil {
			log.Printf("[rustdesk_manage] api-server removal failed %s: %v", path, err)
			continue
		}
		log.Printf("[rustdesk_manage] api-server pointing at the platform removed: %s", path)
		cleared++
	}
	if cleared > 0 {
		reloadRemoteSupportIfIdle()
	}
}

func reloadRemoteSupportIfIdle() {
	uptime, err := host.Uptime()
	if err != nil || time.Duration(uptime)*time.Second > remoteSupportReloadBootWindow {
		log.Printf("[rustdesk_manage] Remote Support picks up the cleaned configuration at its next restart")
		return
	}
	if !lastRemoteSupportReload.IsZero() {
		return
	}
	if remoteSupportSessionActive(brandedRemoteSupportCmdlines()) {
		log.Printf("[rustdesk_manage] remote session active; Remote Support picks up the cleaned configuration at its next restart")
		return
	}
	lastRemoteSupportReload = time.Now()
	log.Printf("[rustdesk_manage] restarting Remote Support to load the cleaned configuration (uptime %ds, no session)", uptime)
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
