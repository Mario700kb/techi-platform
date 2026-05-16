package main

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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

var rustDeskIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{6,64}$`)

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
	return rustDeskIDPattern.MatchString(id)
}

func discoverRustDeskWindows(info RustDeskInfo) RustDeskInfo {
	installPath := firstExistingPath([]string{
		filepath.Join(os.Getenv("ProgramFiles"), "RustDesk", "rustdesk.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "RustDesk", "rustdesk.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "RustDesk", "rustdesk.exe"),
	})

	if installPath != "" {
		info.InstallStatus = "installed"
		info.InstallPath = installPath
		info.Version = rustDeskVersion(installPath)
	} else {
		info.InstallStatus = "not_installed"
	}

	info.Status = rustDeskWindowsStatus()
	id, encID := readRustDeskFromKnownFiles()
	if id != "" {
		info.ID = id
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
	output, err := exec.Command("tasklist", "/FI", "IMAGENAME eq rustdesk.exe").Output()
	if err == nil && strings.Contains(strings.ToLower(string(output)), "rustdesk.exe") {
		return "running"
	}

	output, err = exec.Command("sc", "query", "RustDesk").Output()
	if err == nil {
		lower := strings.ToLower(string(output))
		if strings.Contains(lower, "running") {
			return "running"
		}
		if strings.Contains(lower, "stopped") {
			return "stopped"
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
		filepath.Join(os.Getenv("APPDATA"), "RustDesk", "config", "RustDesk2.toml"),
		filepath.Join(os.Getenv("APPDATA"), "RustDesk", "config", "RustDesk.toml"),
		filepath.Join(os.Getenv("APPDATA"), "RustDesk", "config", "RustDesk2_local.toml"),
		filepath.Join(os.Getenv("APPDATA"), "RustDesk", "config", "RustDesk_local.toml"),
		filepath.Join(os.Getenv("APPDATA"), "RustDesk", "RustDesk2.toml"),
		filepath.Join(os.Getenv("APPDATA"), "RustDesk", "RustDesk.toml"),
		filepath.Join(os.Getenv("PROGRAMDATA"), "RustDesk", "config", "RustDesk2.toml"),
		filepath.Join(os.Getenv("PROGRAMDATA"), "RustDesk", "config", "RustDesk.toml"),
		filepath.Join(os.Getenv("PROGRAMDATA"), "RustDesk", "config", "RustDesk2_local.toml"),
		filepath.Join(os.Getenv("PROGRAMDATA"), "RustDesk", "config", "RustDesk_local.toml"),
		filepath.Join(os.Getenv("SystemRoot"), "ServiceProfiles", "LocalService", "AppData", "Roaming", "RustDesk", "config", "RustDesk2.toml"),
		filepath.Join(os.Getenv("SystemRoot"), "ServiceProfiles", "LocalService", "AppData", "Roaming", "RustDesk", "config", "RustDesk.toml"),
		filepath.Join(os.Getenv("SystemRoot"), "ServiceProfiles", "LocalService", "AppData", "Roaming", "RustDesk", "config", "RustDesk2_local.toml"),
		filepath.Join(os.Getenv("SystemRoot"), "ServiceProfiles", "LocalService", "AppData", "Roaming", "RustDesk", "config", "RustDesk_local.toml"),
		filepath.Join(home, ".config", "rustdesk", "RustDesk2.toml"),
		filepath.Join(home, ".config", "rustdesk", "RustDesk.toml"),
		filepath.Join(home, "Library", "Preferences", "com.carriez.RustDesk", "RustDesk2.toml"),
		filepath.Join(home, "Library", "Preferences", "com.carriez.RustDesk", "RustDesk.toml"),
	}
	for _, pattern := range []string{
		filepath.Join(os.Getenv("SystemDrive")+string(os.PathSeparator), "Users", "*", "AppData", "Roaming", "RustDesk", "config", "RustDesk2.toml"),
		filepath.Join(os.Getenv("SystemDrive")+string(os.PathSeparator), "Users", "*", "AppData", "Roaming", "RustDesk", "config", "RustDesk.toml"),
		filepath.Join(os.Getenv("SystemDrive")+string(os.PathSeparator), "Users", "*", "AppData", "Roaming", "RustDesk", "config", "RustDesk2_local.toml"),
		filepath.Join(os.Getenv("SystemDrive")+string(os.PathSeparator), "Users", "*", "AppData", "Roaming", "RustDesk", "config", "RustDesk_local.toml"),
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
			if id == "" && isUsableRustDeskID(value) {
				id = value
			}
		case "enc_id":
			if encID == "" && value != "" {
				encID = value
			}
		}
	}
	return
}
