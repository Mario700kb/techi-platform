//go:build windows

package main

// Managed tray removal.
//
// TECHI Remote Support tray mode is deprecated: the supported architecture is
// the TECHI Agent service + the TECHI Remote Support Windows service, with the
// UI opened ON DEMAND from the Start Menu / Desktop shortcut. Nothing may run
// "TECHI Remote Support.exe --tray" in the background.
//
// This file only ever REMOVES tray startup. It never creates any. Everything
// here is idempotent and safe to run on every install, upgrade, repair,
// reinstall and heartbeat convergence pass.
//
// What is deliberately NOT touched:
//   - the managed MSI, its service, identity TOML or configuration;
//   - the normal Start Menu / Desktop shortcut, which targets the exe with NO
//     arguments and is how the user opens the UI (only shortcuts that actually
//     pass --tray are removed);
//   - the "--service"/"--server" daemon processes.

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"
)

// removeManagedTrayArtifacts converges an endpoint onto the supported
// architecture by deleting every managed tray startup path it can find.
func removeManagedTrayArtifacts() trayArtifactRemoval {
	removal := trayArtifactRemoval{}

	removal.ScheduledTask = removeTrayScheduledTask()
	removal.RunKeys = removeTrayRunKeyEntries()
	removal.Shortcuts = removeTrayStartupShortcuts()
	removal.Processes = stopRemoteSupportTrayProcesses()

	if removal.HasAny() {
		log.Printf("[rustdesk_tray] removed deprecated tray startup: %s", removal.Summary())
	}
	return removal
}

// removeTrayScheduledTask unregisters the "TECHI Remote Support Tray" logon
// task. schtasks.exe is Microsoft-signed and already the agent's task mechanism
// (no PowerShell, nothing for AV/AMSI to block).
func removeTrayScheduledTask() bool {
	if !scheduledTaskExists(rustdeskTrayTaskName) {
		return false
	}
	// End a running instance first so the delete cannot race it.
	_, _ = runWithTimeout(15*time.Second, schtasksPath(), "/End", "/TN", rustdeskTrayTaskName)
	if _, err := runWithTimeout(15*time.Second, schtasksPath(), "/Delete", "/TN", rustdeskTrayTaskName, "/F"); err != nil {
		log.Printf("[rustdesk_tray] could not delete task %q: %v", rustdeskTrayTaskName, err)
		return false
	}
	log.Printf("[rustdesk_tray] deleted deprecated scheduled task %q", rustdeskTrayTaskName)
	return true
}

// trayRunKeyRoots are the autostart registry keys checked for --tray entries.
var trayRunKeyRoots = []struct {
	Key  registry.Key
	Path string
	Name string
}{
	{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, "HKLM"},
	{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run`, "HKLM32"},
	{registry.CURRENT_USER, `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, "HKCU"},
}

// removeTrayRunKeyEntries deletes autostart values whose command line launches
// Remote Support with --tray. A value that merely points at the exe WITHOUT
// --tray is left alone: that is a user-facing launcher, not a background tray.
func removeTrayRunKeyEntries() []string {
	removed := []string{}
	for _, root := range trayRunKeyRoots {
		key, err := registry.OpenKey(root.Key, root.Path, registry.QUERY_VALUE|registry.SET_VALUE)
		if err != nil {
			continue
		}
		names, err := key.ReadValueNames(0)
		if err != nil {
			key.Close()
			continue
		}
		for _, name := range names {
			value, _, err := key.GetStringValue(name)
			if err != nil || !commandLineIsTrayLauncher(value) {
				continue
			}
			if err := key.DeleteValue(name); err != nil {
				log.Printf("[rustdesk_tray] could not delete %s Run value %q: %v", root.Name, name, err)
				continue
			}
			log.Printf("[rustdesk_tray] deleted %s Run value %q (%s)", root.Name, name, value)
			removed = append(removed, root.Name+`\`+name)
		}
		key.Close()
	}
	return removed
}

// removeTrayStartupShortcuts deletes Startup-folder .lnk files that pass --tray.
// The check reads the shortcut's raw bytes for the argument string (LNK stores
// arguments as UTF-16LE, sometimes ANSI), so ONLY shortcuts that actually launch
// tray mode are removed -- the normal UI shortcut in the Start Menu / on the
// Desktop, which passes no arguments, can never match.
func removeTrayStartupShortcuts() []string {
	removed := []string{}
	for _, dir := range trayStartupDirs() {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".lnk") {
				continue
			}
			path := filepath.Join(dir, entry.Name())
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			if !shortcutBytesLaunchTray(data) {
				continue
			}
			if err := os.Remove(path); err != nil {
				log.Printf("[rustdesk_tray] could not remove startup shortcut %s: %v", path, err)
				continue
			}
			log.Printf("[rustdesk_tray] removed tray startup shortcut %s", path)
			removed = append(removed, path)
		}
	}
	return removed
}

func trayStartupDirs() []string {
	dirs := []string{
		filepath.Join(os.Getenv("ProgramData"), `Microsoft\Windows\Start Menu\Programs\StartUp`),
		filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs\Startup`),
	}
	systemDrive := os.Getenv("SystemDrive")
	if systemDrive == "" {
		systemDrive = "C:"
	}
	users, err := os.ReadDir(filepath.Join(systemDrive+string(os.PathSeparator), "Users"))
	if err == nil {
		for _, user := range users {
			if !user.IsDir() {
				continue
			}
			dirs = append(dirs, filepath.Join(systemDrive+string(os.PathSeparator), "Users", user.Name(),
				`AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`))
		}
	}
	return dirs
}

// stopRemoteSupportTrayProcesses terminates stale background --tray processes,
// leaving the --service/--server daemon (same image name) untouched. Returns how
// many were stopped.
func stopRemoteSupportTrayProcesses() int {
	return killProcessesByPID("tray sweep", remoteSupportTrayProcessPIDs())
}

// stopRemoteSupportRuntimeByPID stops the whole Remote Support runtime (service
// via SCM, then any surviving process by PID) so an installer can replace files.
// Exposed to the MSI as the `stop-remote-support-runtime` subcommand, replacing
// the blanket `taskkill /F /IM "TECHI Remote Support.exe"` the custom actions
// used to run.
func stopRemoteSupportRuntimeByPID() int {
	_, _ = runWithTimeout(30*time.Second, "sc", "stop", rustdeskServiceName)
	time.Sleep(2 * time.Second)
	return killProcessesByPID("runtime stop", remoteSupportProcessPIDs())
}
