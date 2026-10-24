package main

import (
	"bytes"
	"fmt"
	"log"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"time"

	gopsprocess "github.com/shirou/gopsutil/v3/process"
)

const maxProcesses = 50
const maxSoftware = 500

// ProcessInfo is a lightweight snapshot of one running process.
type ProcessInfo struct {
	PID      int32   `json:"pid"`
	Name     string  `json:"name"`
	MemoryMB float64 `json:"memory_mb,omitempty"`
}

// ServiceInfo is a snapshot of one Windows service.
type ServiceInfo struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Status      string `json:"status"`
	StartupType string `json:"startup_type,omitempty"`
}

// SoftwareInfo is an installed software/package inventory entry. On Windows,
// an app that can be removed without anyone at the PC also carries how
// (Uninstall: "msi" for a Windows Installer product, "quiet" for a quiet
// uninstall command) and its registry key, which the uninstall_software
// action reads again before it runs anything.
type SoftwareInfo struct {
	Name         string `json:"name"`
	Version      string `json:"version,omitempty"`
	Publisher    string `json:"publisher,omitempty"`
	InstallDate  string `json:"install_date,omitempty"`
	Uninstall    string `json:"uninstall,omitempty"`
	UninstallKey string `json:"uninstall_key,omitempty"`
}

// PatchStatus eshte snapshot i lehte read-only per OS updates.
type PatchStatus struct {
	PendingUpdates int    `json:"pending_updates"`
	RebootRequired bool   `json:"reboot_required"`
	LastUpdateAt   string `json:"last_update_at,omitempty"`
	PatchState     string `json:"patch_state"`
}

// collectServices lists the Windows services; other platforms report none.
func collectServices() []ServiceInfo {
	if runtime.GOOS != "windows" {
		return nil
	}
	return collectWindowsServices()
}

func collectSoftwareInventory() []SoftwareInfo {
	switch runtime.GOOS {
	case "windows":
		return collectWindowsSoftware()
	case "darwin":
		return collectMacApplications()
	case "linux":
		return collectLinuxPackages()
	default:
		return nil
	}
}

func collectPatchStatus() *PatchStatus {
	switch runtime.GOOS {
	case "windows":
		return collectWindowsPatchStatus()
	case "darwin":
		return collectMacPatchStatus()
	case "linux":
		return collectLinuxPatchStatus()
	default:
		return &PatchStatus{PatchState: "unknown"}
	}
}

func collectProcessList() []ProcessInfo {
	all, err := gopsprocess.Processes()
	if err != nil {
		log.Printf("processes: list failed: %v", err)
		return nil
	}

	type entry struct {
		info ProcessInfo
		rss  uint64
	}

	entries := make([]entry, 0, len(all))
	for _, p := range all {
		name, _ := p.Name()
		if name == "" {
			continue
		}
		memInfo, _ := p.MemoryInfo()
		var rss uint64
		if memInfo != nil {
			rss = memInfo.RSS
		}
		entries = append(entries, entry{
			info: ProcessInfo{
				PID:      p.Pid,
				Name:     name,
				MemoryMB: float64(rss) / (1024 * 1024),
			},
			rss: rss,
		})
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].rss > entries[j].rss
	})

	n := min(len(entries), maxProcesses)
	result := make([]ProcessInfo, n)
	for i := range result {
		result[i] = entries[i].info
	}
	return result
}

func collectWindowsSoftware() []SoftwareInfo {
	roots := []string{
		`HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`,
		`HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
		`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`,
	}

	seen := map[string]struct{}{}
	var software []SoftwareInfo
	for _, root := range roots {
		out, err := runWithTimeout(20*time.Second, "reg", "query", root, "/s")
		if err != nil {
			log.Printf("software: reg query failed for %s: %v", root, err)
			continue
		}
		for _, app := range parseWindowsUninstallRegistry(string(out)) {
			key := strings.ToLower(app.Name + "|" + app.Version + "|" + app.Publisher)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			software = append(software, app)
			if len(software) >= maxSoftware {
				return software
			}
		}
	}

	sort.Slice(software, func(i, j int) bool {
		return strings.ToLower(software[i].Name) < strings.ToLower(software[j].Name)
	})
	return software
}

func parseWindowsUninstallRegistry(raw string) []SoftwareInfo {
	var current SoftwareInfo
	var software []SoftwareInfo
	key, windowsInstaller, quiet := "", false, false
	flush := func() {
		if strings.TrimSpace(current.Name) != "" {
			if method := uninstallMethod(key, windowsInstaller, quiet); method != "" {
				current.Uninstall = method
				current.UninstallKey = key
			}
			software = append(software, current)
		}
		current = SoftwareInfo{}
		key, windowsInstaller, quiet = "", false, false
	}

	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "HKEY_") {
			flush()
			key = trimmed
			continue
		}
		name, value := parseRegValueLine(trimmed)
		switch name {
		case "DisplayName":
			current.Name = value
		case "DisplayVersion":
			current.Version = value
		case "Publisher":
			current.Publisher = value
		case "InstallDate":
			current.InstallDate = value
		case "WindowsInstaller":
			windowsInstaller = value == "0x1" || value == "1"
		case "QuietUninstallString":
			quiet = strings.TrimSpace(value) != ""
		}
	}
	flush()
	return software
}

// uninstallMethod is how an app can be removed with nobody at the PC: "msi"
// for a Windows Installer product (its key is the product code), "quiet" for
// an app that registered a quiet uninstall command, "" when it cannot be.
func uninstallMethod(key string, windowsInstaller bool, quiet bool) string {
	if windowsInstaller && isProductCode(registryLeaf(key)) {
		return "msi"
	}
	if quiet {
		return "quiet"
	}
	return ""
}

func registryLeaf(key string) string {
	if i := strings.LastIndex(key, `\`); i >= 0 {
		return key[i+1:]
	}
	return key
}

// isProductCode reports a braced GUID, the form of a Windows Installer
// product code: {8-4-4-4-12 hex}.
func isProductCode(s string) bool {
	if len(s) != 38 || s[0] != '{' || s[37] != '}' {
		return false
	}
	for i, c := range s[1:37] {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
				return false
			}
		}
	}
	return true
}

func parseRegValueLine(line string) (string, string) {
	fields := strings.Fields(line)
	if len(fields) < 3 || !strings.HasPrefix(fields[1], "REG_") {
		return "", ""
	}
	idx := strings.Index(line, fields[1])
	if idx < 0 {
		return fields[0], ""
	}
	return fields[0], strings.TrimSpace(line[idx+len(fields[1]):])
}

func collectMacApplications() []SoftwareInfo {
	paths := []string{"/Applications", "/System/Applications"}
	seen := map[string]struct{}{}
	var software []SoftwareInfo
	for _, path := range paths {
		entries, err := os.ReadDir(path)
		if err != nil {
			log.Printf("software: read %s failed: %v", path, err)
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || !strings.HasSuffix(entry.Name(), ".app") {
				continue
			}
			name := strings.TrimSuffix(entry.Name(), ".app")
			if name == "" {
				continue
			}
			key := strings.ToLower(name)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			software = append(software, SoftwareInfo{Name: name})
			if len(software) >= maxSoftware {
				return software
			}
		}
	}
	sort.Slice(software, func(i, j int) bool {
		return strings.ToLower(software[i].Name) < strings.ToLower(software[j].Name)
	})
	return software
}

func collectLinuxPackages() []SoftwareInfo {
	commands := [][]string{
		{"dpkg-query", "-W", "-f=${Package}\t${Version}\n"},
		{"rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n"},
		{"apk", "info", "-v"},
		{"pacman", "-Q"},
	}
	for _, command := range commands {
		out, err := runWithTimeout(15*time.Second, command[0], command[1:]...)
		if err != nil {
			continue
		}
		software := parseLinuxPackageList(string(out), command[0])
		if len(software) > 0 {
			return software
		}
	}
	return nil
}

func parseLinuxPackageList(raw string, source string) []SoftwareInfo {
	var software []SoftwareInfo
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		app := SoftwareInfo{}
		switch source {
		case "dpkg-query", "rpm":
			parts := strings.Split(line, "\t")
			app.Name = strings.TrimSpace(parts[0])
			if len(parts) > 1 {
				app.Version = strings.TrimSpace(parts[1])
			}
			if len(parts) > 2 {
				app.Publisher = strings.TrimSpace(parts[2])
			}
		default:
			parts := strings.Fields(line)
			app.Name = parts[0]
			if len(parts) > 1 {
				app.Version = parts[1]
			}
		}
		if app.Name == "" {
			continue
		}
		software = append(software, app)
		if len(software) >= maxSoftware {
			break
		}
	}
	return software
}

// windowsPendingUpdatesScript counts the updates Windows Update will install
// as patches. The plain search (IsInstalled=0 and IsHidden=0) also returned
// drivers, optional and preview updates (BrowseOnly) and Microsoft Defender
// security-intelligence updates, which arrive several times a day and install
// themselves within minutes: Mario-Lenovo showed "1 patch pending" that the
// Windows Update page on the PC never listed (2026-10-17). BrowseOnly cannot
// be a search criterion (0x80240032), so the filter runs on the results.
// Definition Updates is matched by its category ID, not its localised name.
const windowsPendingUpdatesScript = "$s=New-Object -ComObject Microsoft.Update.Session; " +
	"$r=$s.CreateUpdateSearcher().Search('IsInstalled=0 and IsHidden=0'); " +
	"@($r.Updates | Where-Object { $_.Type -eq 1 -and -not $_.BrowseOnly -and " +
	"-not ($_.Categories | Where-Object { $_.CategoryID -eq 'e0789628-ce08-4437-be74-2495b842f43b' }) }).Count"

func collectWindowsPatchStatus() *PatchStatus {
	status := &PatchStatus{PatchState: "unknown"}

	if out, err := runWithTimeout(20*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command",
		windowsPendingUpdatesScript); err == nil {
		status.PendingUpdates = parseFirstInt(string(out))
	} else {
		log.Printf("patch: windows update count failed: %v", err)
	}

	status.RebootRequired = windowsRebootRequired()
	status.LastUpdateAt = windowsLastUpdateDate()
	status.PatchState = computePatchState(status.PendingUpdates, status.RebootRequired, true)
	return status
}

func windowsRebootRequired() bool {
	keys := []string{
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`,
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`,
	}
	// PendingFileRenameOperations is not consulted: installers and updaters
	// leave entries there that never need a restart, and it marked 87% of the
	// fleet as waiting for one (2026-10-16).
	for _, key := range keys {
		out, err := runWithTimeout(5*time.Second, "reg", "query", key)
		if err == nil && strings.TrimSpace(string(out)) != "" {
			return true
		}
	}
	return false
}

func windowsLastUpdateDate() string {
	out, err := runWithTimeout(10*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command",
		"$h=Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 1; if ($h -and $h.InstalledOn) { $h.InstalledOn.ToString('yyyy-MM-dd') }")
	if err != nil {
		log.Printf("patch: windows last update failed: %v", err)
		return ""
	}
	return strings.TrimSpace(string(out))
}

func collectMacPatchStatus() *PatchStatus {
	out, err := runWithTimeout(25*time.Second, "softwareupdate", "-l")
	if err != nil {
		log.Printf("patch: macOS softwareupdate check failed: %v", err)
		return &PatchStatus{PatchState: "unknown"}
	}
	pending := parseMacSoftwareUpdateCount(string(out))
	rebootRequired := macUpdateNeedsRestart(string(out))
	status := &PatchStatus{
		PendingUpdates: pending,
		RebootRequired: rebootRequired,
		PatchState:     computePatchState(pending, rebootRequired, true),
	}
	return status
}

func parseMacSoftwareUpdateCount(raw string) int {
	count := 0
	for _, line := range strings.Split(raw, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "*") {
			count++
		}
	}
	return count
}

func macUpdateNeedsRestart(raw string) bool {
	normalized := strings.ToLower(raw)
	return strings.Contains(normalized, "restart") || strings.Contains(normalized, "reboot")
}

func collectLinuxPatchStatus() *PatchStatus {
	commands := [][]string{
		{"apt", "list", "--upgradable"},
		{"dnf", "check-update", "-q"},
		{"yum", "check-update", "-q"},
		{"apk", "version", "-l", "<"},
		{"pacman", "-Qu"},
	}
	for _, command := range commands {
		out, err := runWithTimeout(15*time.Second, command[0], command[1:]...)
		if err != nil && len(out) == 0 {
			continue
		}
		pending := parseLinuxUpdateCount(string(out), command[0])
		rebootRequired := linuxRebootRequired()
		return &PatchStatus{
			PendingUpdates: pending,
			RebootRequired: rebootRequired,
			PatchState:     computePatchState(pending, rebootRequired, true),
		}
	}
	return &PatchStatus{PatchState: "unknown"}
}

func parseLinuxUpdateCount(raw string, source string) int {
	count := 0
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "Listing") || strings.HasPrefix(line, "Last metadata") {
			continue
		}
		count++
	}
	return count
}

func linuxRebootRequired() bool {
	_, err := os.Stat("/var/run/reboot-required")
	return err == nil
}

func computePatchState(pending int, rebootRequired bool, known bool) string {
	if !known {
		return "unknown"
	}
	if rebootRequired {
		return "reboot_required"
	}
	if pending > 0 {
		return "updates_available"
	}
	return "up_to_date"
}

func parseFirstInt(raw string) int {
	for _, field := range strings.Fields(raw) {
		var value int
		if _, err := fmt.Sscanf(field, "%d", &value); err == nil {
			return value
		}
	}
	return 0
}

// runWithTimeout executes a command and kills it if it exceeds the timeout.
func runWithTimeout(timeout time.Duration, name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return buf.Bytes(), err
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("command %s timed out after %s", name, timeout)
	}
}
