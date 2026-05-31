package main

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

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
			_ = cmd.Process.Kill()
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

func discoverRustDeskWindows(info RustDeskInfo) RustDeskInfo {
	installPath := firstExistingPath([]string{
		filepath.Join(os.Getenv("ProgramFiles"), "TECHI Remote Support", "TECHI Remote Support.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "TECHI Remote Support", "TECHI Remote Support.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "TECHI Remote Support", "TECHI Remote Support.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "TECHI Remote Support", "rustdesk.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "TECHI Remote Support", "rustdesk.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "TECHI Remote Support", "rustdesk.exe"),
	})

	if installPath != "" {
		info.InstallStatus = "installed"
		info.InstallPath = installPath
		info.Version = rustDeskVersion(installPath)
	} else {
		info.InstallStatus = "not_installed"
	}

	info.Status = rustDeskWindowsStatus()

	// Prefer CLI: rustdesk.exe --get-id gives the exact ID shown in the UI.
	if installPath != "" {
		if cliID := localRustDeskIDFromCLI(installPath); cliID != "" {
			info.ID = cliID
		}
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
		_ = cmd.Process.Kill()
		return ""
	case err := <-done:
		if err != nil {
			return ""
		}
		return strings.TrimSpace(out.String())
	}
}

func rustDeskWindowsStatus() string {
	// Primary process: branded TECHI exe.
	output, err := exec.Command("tasklist", "/FI", "IMAGENAME eq TECHI Remote Support.exe").Output()
	if err == nil && strings.Contains(string(output), "TECHI Remote Support.exe") {
		return "running"
	}
	// Fallback process: legacy upstream binary name.
	output, err = exec.Command("tasklist", "/FI", "IMAGENAME eq rustdesk.exe").Output()
	if err == nil && strings.Contains(strings.ToLower(string(output)), "rustdesk.exe") {
		return "running"
	}

	// Primary service: TECHI Remote Support.
	output, err = exec.Command("sc", "query", "TECHI Remote Support").Output()
	if err == nil {
		lower := strings.ToLower(string(output))
		if strings.Contains(lower, "running") {
			return "running"
		}
		if strings.Contains(lower, "stopped") {
			return "stopped"
		}
	}
	// Fallback services: legacy RustDesk service names.
	for _, svc := range []string{"RustDesk", "rustdesk"} {
		output, err = exec.Command("sc", "query", svc).Output()
		if err == nil && strings.Contains(strings.ToLower(string(output)), "running") {
			return "running"
		}
	}
	return "not_running"
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
