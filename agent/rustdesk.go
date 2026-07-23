package main

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// cliProbeInterval throttles the --get-id/--version CLI probes below: each
// spawns a second instance of the single-instance-locked Remote Support exe,
// so probing on every heartbeat (every ~60s) piles up processes far faster
// than a kill-on-timeout can clean them up. Once we have a usable cached
// value there's no need to re-probe more than occasionally.
const cliProbeInterval = 30 * time.Minute

var (
	cliProbeMu      sync.Mutex
	cliProbeVersion string
	cliProbeVerAt   time.Time
	cliProbeIDAt    time.Time
)

func cachedRustDeskVersion(path string) string {
	cliProbeMu.Lock()
	if cliProbeVersion != "" && time.Since(cliProbeVerAt) < cliProbeInterval {
		v := cliProbeVersion
		cliProbeMu.Unlock()
		return v
	}
	cliProbeMu.Unlock()

	v := rustDeskVersion(path)
	cliProbeMu.Lock()
	if v != "" {
		cliProbeVersion = v
		cliProbeVerAt = time.Now()
	}
	cliProbeMu.Unlock()
	return v
}

func shouldProbeRustDeskID(currentID string) bool {
	if !isUsableRustDeskID(currentID) {
		return true
	}
	cliProbeMu.Lock()
	defer cliProbeMu.Unlock()
	return time.Since(cliProbeIDAt) >= cliProbeInterval
}

func recordRustDeskIDProbe() {
	cliProbeMu.Lock()
	cliProbeIDAt = time.Now()
	cliProbeMu.Unlock()
}

type RustDeskInfo struct {
	ID            string `json:"rustdesk_id"`
	EncID         string `json:"rustdesk_enc_id,omitempty"`
	InstallStatus string `json:"rustdesk_install_status"`
	Status        string `json:"rustdesk_status"`
	Version       string `json:"rustdesk_version"`
	InstallPath   string `json:"rustdesk_install_path"`
}

func discoverRustDesk(cfg *Config) RustDeskInfo {
	info := RustDeskInfo{
		ID:            configuredRustDeskID(cfg),
		InstallStatus: "unknown",
		Status:        "unknown",
	}

	switch runtime.GOOS {
	case "windows":
		info = discoverRustDeskWindows(info)
	default:
		info = discoverRustDeskPortable(info)
	}

	if info.ID == "" {
		info.ID = configuredRustDeskID(cfg)
	}
	return info
}

func configuredRustDeskID(cfg *Config) string {
	id := strings.TrimSpace(cfg.RustDeskID)
	if !isUsableRustDeskID(id) {
		return ""
	}
	return id
}

// normalizeRustDeskID strips whitespace and non-digit characters.
// "1 235 009 710" → "1235009710"
func normalizeRustDeskID(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// isNumericRustDeskID returns true for a normalized all-digit ID of 5–20 digits.
func isNumericRustDeskID(id string) bool {
	if len(id) < 5 || len(id) > 20 {
		return false
	}
	for _, r := range id {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func isUsableRustDeskID(id string) bool {
	id = strings.TrimSpace(id)
	if id == "" {
		return false
	}
	lower := strings.ToLower(id)
	if lower == "rustdesk-placeholder" || lower == "unknown" || lower == "unset" || lower == "none" {
		return false
	}
	if strings.HasPrefix(lower, "agent_") || strings.HasPrefix(lower, "pending_") {
		return false
	}
	return isNumericRustDeskID(normalizeRustDeskID(id))
}

// localRustDeskIDFromCLI runs `rustdesk.exe --get-id` and returns the
// normalized numeric ID (e.g. "1235009710") or "" if unavailable.
//
// This spawns a second instance of the (single-instance-locked) Remote
// Support exe. If it doesn't exit cleanly on its own, the 5s timeout below
// kills it -- but cmd.Process.Kill() only kills that one PID, not any
// children it spawned, so a hung/non-exiting --get-id leaves an orphaned
// process that holds the single-instance lock forever (manual launches of
// Remote Support then silently do nothing, since they just forward to the
// orphan instead of opening a window). killProcessTree below force-kills
// the whole tree as a safety net.
func localRustDeskIDFromCLI(installPath string) string {
	if installPath == "" {
		return ""
	}
	cmd := exec.Command(installPath, "--get-id")
	var out bytes.Buffer
	cmd.Stdout = &out
	done := make(chan error, 1)
	go func() { done <- cmd.Run() }()
	select {
	case <-time.After(5 * time.Second):
		if cmd.Process != nil {
			killProcessTree(cmd.Process.Pid)
		}
		return ""
	case <-done:
	}
	scanner := bufio.NewScanner(strings.NewReader(out.String()))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		id := normalizeRustDeskID(line)
		if isNumericRustDeskID(id) {
			return id
		}
	}
	return ""
}

// killProcessTree force-kills pid and its descendants. Used as a safety net
// when a spawned CLI probe (--get-id, --version) doesn't exit on its own --
// cmd.Process.Kill() alone only terminates the single PID we spawned.
func killProcessTree(pid int) {
	_, _ = runWithTimeout(5*time.Second, "taskkill", "/F", "/T", "/PID", strconv.Itoa(pid))
}

func discoverRustDeskWindows(info RustDeskInfo) RustDeskInfo {
	msi := detectRemoteSupportMSIRegistration("")
	installPath := firstExistingPath([]string{
		// Program Files is primary -- matches the proven TECHI-Remote-Support.iss
		// reference installer and the existing fleet's install location.
		// ProgramData/LOCALAPPDATA remain fallbacks for machines that picked up
		// the incorrect ProgramData install during the brief window it shipped.
		filepath.Join(os.Getenv("ProgramFiles"), "TECHI Remote Support", "TECHI Remote Support.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "TECHI Remote Support", "TECHI Remote Support.exe"),
		filepath.Join(os.Getenv("ProgramData"), "TECHI Remote Support", "TECHI Remote Support.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "TECHI Remote Support", "TECHI Remote Support.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "TECHI Remote Support", "rustdesk.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "TECHI Remote Support", "rustdesk.exe"),
		filepath.Join(os.Getenv("ProgramData"), "TECHI Remote Support", "rustdesk.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "TECHI Remote Support", "rustdesk.exe"),
	})

	if installPath != "" {
		info.InstallStatus = "installed"
		info.InstallPath = installPath
		info.Version = selectRemoteSupportVersion(cachedRustDeskVersion(installPath), msi)
	} else {
		info.InstallStatus = "not_installed"
	}
	if msi.Version != "" {
		if fullPath := firstExistingPath(remoteSupportFullMSIPaths()); fullPath != "" {
			info.InstallStatus = "installed"
			info.InstallPath = fullPath
		}
		info.Version = selectRemoteSupportVersion(info.Version, msi)
	}

	info.Status = rustDeskWindowsStatus()

	// Prefer CLI: rustdesk.exe --get-id gives the exact ID shown in the UI.
	// Only probe when we don't have a usable ID yet, or periodically to
	// catch drift -- see cliProbeInterval.
	if installPath != "" && shouldProbeRustDeskID(info.ID) {
		if cliID := localRustDeskIDFromCLI(installPath); cliID != "" {
			info.ID = cliID
		}
		recordRustDeskIDProbe()
	}

	// Read TOML files for encID, and ID as fallback if CLI produced nothing.
	fileID, encID := readRustDeskFromKnownFiles()
	if info.ID == "" && fileID != "" {
		info.ID = fileID
	}
	if encID != "" {
		info.EncID = encID
	}
	return info
}

func discoverRustDeskPortable(info RustDeskInfo) RustDeskInfo {
	installPath, err := exec.LookPath("rustdesk")
	if err == nil && installPath != "" {
		info.InstallStatus = "installed"
		info.InstallPath = installPath
		info.Version = rustDeskVersion(installPath)
		info.Status = "unknown"
	} else {
		info.InstallStatus = "not_installed"
		info.Status = "not_installed"
	}

	id, encID := readRustDeskFromKnownFiles()
	if id != "" {
		info.ID = id
	}
	if encID != "" {
		info.EncID = encID
	}
	return info
}

func firstExistingPath(paths []string) string {
	for _, path := range paths {
		if path == "" {
			continue
		}
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return ""
}

func rustDeskVersion(path string) string {
	if path == "" {
		return ""
	}
	cmd := exec.Command(path, "--version")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	done := make(chan error, 1)
	go func() { done <- cmd.Run() }()
	select {
	case <-time.After(2 * time.Second):
		if cmd.Process != nil {
			killProcessTree(cmd.Process.Pid)
		}
		return ""
	case err := <-done:
		if err != nil {
			return ""
		}
		return strings.TrimSpace(out.String())
	}
}

func rustDeskWindowsStatus() string {
	// Primary service: TECHI Remote Support.
	fullServiceState := ""
	output, err := exec.Command("sc", "query", "TECHI Remote Support").Output()
	if err == nil {
		lower := strings.ToLower(string(output))
		if strings.Contains(lower, "running") {
			fullServiceState = "running"
		}
		if strings.Contains(lower, "stopped") {
			fullServiceState = "stopped"
		}
	}

	brandedProcess := false
	output, err = exec.Command("tasklist", "/FI", "IMAGENAME eq TECHI Remote Support.exe").Output()
	if err == nil && strings.Contains(string(output), "TECHI Remote Support.exe") {
		brandedProcess = true
	}
	legacyProcess := false
	output, err = exec.Command("tasklist", "/FI", "IMAGENAME eq rustdesk.exe").Output()
	if err == nil && strings.Contains(strings.ToLower(string(output)), "rustdesk.exe") {
		legacyProcess = true
	}

	// Fallback services: legacy RustDesk service names.
	legacyServiceRunning := false
	for _, svc := range []string{"RustDesk", "rustdesk"} {
		output, err = exec.Command("sc", "query", svc).Output()
		if err == nil && strings.Contains(strings.ToLower(string(output)), "running") {
			legacyServiceRunning = true
			break
		}
	}
	return classifyRustDeskWindowsRuntime(fullServiceState, brandedProcess, legacyProcess, legacyServiceRunning)
}

func selectRemoteSupportVersion(fileVersion string, msi remoteSupportMSIRegistration) string {
	if strings.TrimSpace(msi.Version) != "" {
		return strings.TrimSpace(msi.Version)
	}
	return strings.TrimSpace(fileVersion)
}

func classifyRustDeskWindowsRuntime(fullServiceState string, brandedProcess bool, legacyProcess bool, legacyServiceRunning bool) string {
	switch strings.ToLower(strings.TrimSpace(fullServiceState)) {
	case "running":
		if legacyProcess || legacyServiceRunning {
			return "conflicting_dual_install"
		}
		return "running"
	case "stopped":
		if brandedProcess || legacyProcess {
			return "tray_only"
		}
		return "stopped"
	}
	if brandedProcess || legacyProcess {
		return "tray_only"
	}
	if legacyServiceRunning {
		return "legacy_service_running"
	}
	return "not_running"
}

type remoteSupportMSIRegistration struct {
	ProductCode string
	Version     string
}

func remoteSupportFullMSIPaths() []string {
	return []string{
		filepath.Join(os.Getenv("ProgramFiles"), "TECHI Remote Support", "TECHI Remote Support.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "TECHI Remote Support", "TECHI Remote Support.exe"),
	}
}

func detectRemoteSupportMSIRegistration(productGUID string) remoteSupportMSIRegistration {
	if strings.TrimSpace(productGUID) != "" {
		if version := queryUninstallDisplayVersion(productGUID); version != "" {
			return remoteSupportMSIRegistration{ProductCode: productGUID, Version: version}
		}
	}

	for _, root := range []string{
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
		`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
	} {
		out, err := runWithTimeout(10*time.Second, "reg", "query", root, "/s", "/f", "TECHI Remote Support", "/d")
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(out), "\n") {
			key := strings.TrimSpace(line)
			if !strings.HasPrefix(strings.ToUpper(key), "HKEY_LOCAL_MACHINE\\") {
				continue
			}
			name := queryRegistryStringValue(key, "DisplayName")
			if !strings.EqualFold(strings.TrimSpace(name), "TECHI Remote Support") {
				continue
			}
			version := queryRegistryStringValue(key, "DisplayVersion")
			if version == "" {
				continue
			}
			productCode := filepath.Base(key)
			return remoteSupportMSIRegistration{ProductCode: productCode, Version: version}
		}
	}
	return remoteSupportMSIRegistration{}
}

func queryUninstallDisplayVersion(guid string) string {
	if guid == "" {
		return ""
	}
	for _, root := range []string{
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\` + guid,
		`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\` + guid,
	} {
		if version := queryRegistryStringValue(root, "DisplayVersion"); version != "" {
			return version
		}
	}
	return ""
}

func queryRegistryStringValue(root string, valueName string) string {
	out, err := runWithTimeout(5*time.Second, "reg", "query", root, "/v", valueName)
	if err != nil {
		return ""
	}
	valueName = strings.ToLower(valueName)
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(strings.ToLower(line), valueName) {
			parts := strings.Fields(line)
			if len(parts) >= 3 {
				return strings.Join(parts[2:], " ")
			}
		}
	}
	return ""
}

func readRustDeskFromKnownFiles() (id, encID string) {
	for _, path := range rustDeskConfigCandidates() {
		fileID, fileEncID := readRustDeskFieldsFromFile(path)
		if id == "" && fileID != "" {
			id = fileID
		}
		if encID == "" && fileEncID != "" {
			encID = fileEncID
		}
		if id != "" && encID != "" {
			return
		}
	}
	return
}

func rustDeskConfigCandidates() []string {
	home, _ := os.UserHomeDir()
	candidates := []string{
		filepath.Join(os.Getenv("APPDATA"), "TECHI Remote Support", "config", "TECHI Remote Support2.toml"),
		filepath.Join(os.Getenv("APPDATA"), "TECHI Remote Support", "config", "TECHI Remote Support.toml"),
		filepath.Join(os.Getenv("APPDATA"), "TECHI Remote Support", "config", "TECHI Remote Support2_local.toml"),
		filepath.Join(os.Getenv("APPDATA"), "TECHI Remote Support", "config", "TECHI Remote Support_local.toml"),
		filepath.Join(os.Getenv("APPDATA"), "TECHI Remote Support", "TECHI Remote Support2.toml"),
		filepath.Join(os.Getenv("APPDATA"), "TECHI Remote Support", "TECHI Remote Support.toml"),
		filepath.Join(os.Getenv("PROGRAMDATA"), "TECHI Remote Support", "config", "TECHI Remote Support2.toml"),
		filepath.Join(os.Getenv("PROGRAMDATA"), "TECHI Remote Support", "config", "TECHI Remote Support.toml"),
		filepath.Join(os.Getenv("PROGRAMDATA"), "TECHI Remote Support", "config", "TECHI Remote Support2_local.toml"),
		filepath.Join(os.Getenv("PROGRAMDATA"), "TECHI Remote Support", "config", "TECHI Remote Support_local.toml"),
		filepath.Join(os.Getenv("SystemRoot"), "ServiceProfiles", "LocalService", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support2.toml"),
		filepath.Join(os.Getenv("SystemRoot"), "ServiceProfiles", "LocalService", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support.toml"),
		filepath.Join(os.Getenv("SystemRoot"), "ServiceProfiles", "LocalService", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support2_local.toml"),
		filepath.Join(os.Getenv("SystemRoot"), "ServiceProfiles", "LocalService", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support_local.toml"),
		filepath.Join(home, ".config", "TECHI Remote Support", "TECHI Remote Support2.toml"),
		filepath.Join(home, ".config", "TECHI Remote Support", "TECHI Remote Support.toml"),
		filepath.Join(home, "Library", "Application Support", "TECHI Remote Support", "TECHI Remote Support2.toml"),
		filepath.Join(home, "Library", "Application Support", "TECHI Remote Support", "TECHI Remote Support.toml"),
	}
	for _, pattern := range []string{
		filepath.Join(os.Getenv("SystemDrive")+string(os.PathSeparator), "Users", "*", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support2.toml"),
		filepath.Join(os.Getenv("SystemDrive")+string(os.PathSeparator), "Users", "*", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support.toml"),
		filepath.Join(os.Getenv("SystemDrive")+string(os.PathSeparator), "Users", "*", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support2_local.toml"),
		filepath.Join(os.Getenv("SystemDrive")+string(os.PathSeparator), "Users", "*", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support_local.toml"),
	} {
		if matches, err := filepath.Glob(pattern); err == nil {
			candidates = append(candidates, matches...)
		}
	}
	return candidates
}

func readRustDeskFieldsFromFile(path string) (id, encID string) {
	if path == "" {
		return
	}
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimPrefix(strings.TrimSpace(scanner.Text()), "\ufeff")
		lower := strings.ToLower(line)
		if !strings.Contains(lower, "id") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.Trim(strings.ToLower(parts[0]), " \"'")
		value := strings.SplitN(parts[1], "#", 2)[0]
		value = strings.Trim(strings.TrimSpace(value), " \"'")

		switch key {
		case "id", "rustdesk_id":
			if id == "" {
				normalized := normalizeRustDeskID(value)
				if isNumericRustDeskID(normalized) {
					id = normalized
				}
			}
		case "enc_id":
			if encID == "" && value != "" {
				encID = value
			}
		}
	}
	return
}
