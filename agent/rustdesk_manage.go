//go:build windows

package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	rustdeskDefaultInstallPath = `C:\Program Files\RustDesk\rustdesk.exe`
	rustdeskServiceName        = "RustDesk"
)

// ensureRustDesk checks and heals RustDesk installation, config, and service.
// Returns without error even if healing steps fail so heartbeat always continues.
func ensureRustDesk(cfg *Config) {
	if !cfg.RustDeskManageEnabled {
		log.Printf("[rustdesk_manage] disabled — skipping")
		return
	}

	installed := isRustDeskInstalled()

	if !installed {
		if cfg.RustDeskMSIUrl == "" {
			log.Printf("[rustdesk_manage] not installed and no MSI URL configured — skipping install")
		} else {
			if err := installRustDeskMSI(cfg); err != nil {
				log.Printf("[rustdesk_manage] install failed: %v — continuing heartbeat", err)
				return
			}
			installed = isRustDeskInstalled()
		}
	} else {
		log.Printf("[rustdesk_manage] already installed at %s", rustdeskDefaultInstallPath)
	}

	if installed {
		if err := writeRustDeskConfig(cfg); err != nil {
			log.Printf("[rustdesk_manage] config write failed: %v", err)
		}
		if err := ensureRustDeskService(); err != nil {
			log.Printf("[rustdesk_manage] service ensure failed: %v", err)
		}
		if cfg.RustDeskDefaultPassword != "" {
			if err := setRustDeskPassword(cfg.RustDeskDefaultPassword); err != nil {
				log.Printf("[rustdesk_manage] password set failed: %v", err)
			}
		}
	}
}

func isRustDeskInstalled() bool {
	_, err := os.Stat(rustdeskDefaultInstallPath)
	return err == nil
}

func installRustDeskMSI(cfg *Config) error {
	log.Printf("[rustdesk_manage] downloading MSI from %s", cfg.RustDeskMSIUrl)

	tmpPath := filepath.Join(os.TempDir(), "rustdesk_setup.msi")
	if err := downloadFile(cfg.RustDeskMSIUrl, tmpPath, cfg.TimeoutSeconds*10); err != nil {
		return fmt.Errorf("MSI download failed: %w", err)
	}
	defer func() { _ = os.Remove(tmpPath) }()

	log.Printf("[rustdesk_manage] installing MSI silently")
	if _, err := runWithTimeout(5*time.Minute, "msiexec", "/i", tmpPath, "/qn", "/norestart"); err != nil {
		return fmt.Errorf("msiexec failed: %w", err)
	}
	log.Printf("[rustdesk_manage] installed successfully")
	return nil
}

func writeRustDeskConfig(cfg *Config) error {
	content := buildRustDeskTOML(cfg)

	dirs := rustDeskConfigDirs()

	wrote := 0
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Printf("[rustdesk_manage] mkdir %s: %v", dir, err)
			continue
		}
		for _, name := range []string{"RustDesk2.toml", "RustDesk.toml"} {
			path := filepath.Join(dir, name)
			if !cfg.RustDeskForceConfig {
				if _, err := os.Stat(path); err == nil {
					log.Printf("[rustdesk_manage] config exists, skipping (force_config=false): %s", path)
					continue
				}
			}
			if err := os.WriteFile(path, []byte(content), 0644); err != nil {
				log.Printf("[rustdesk_manage] write %s: %v", path, err)
				continue
			}
			log.Printf("[rustdesk_manage] configured: %s", path)
			wrote++
		}
	}

	if wrote > 0 {
		log.Printf("[rustdesk_manage] config written to %d locations", wrote)
	}
	return nil
}

func buildRustDeskTOML(cfg *Config) string {
	rendezvous := cfg.RustDeskRendezvousServer
	relay := cfg.RustDeskRelayServer
	api := cfg.RustDeskAPIServer
	key := cfg.RustDeskKey

	var sb strings.Builder
	sb.WriteString("rendezvous_server = ''\n")
	sb.WriteString("nat_type = 1\n")
	sb.WriteString("serial = 0\n")
	sb.WriteString("unlock_pin = ''\n")
	sb.WriteString("trusted_devices = ''\n")
	sb.WriteString("\n[options]\n")
	if rendezvous != "" {
		fmt.Fprintf(&sb, "custom-rendezvous-server = '%s'\n", rendezvous)
	}
	if relay != "" {
		fmt.Fprintf(&sb, "relay-server = '%s'\n", relay)
	}
	if api != "" {
		fmt.Fprintf(&sb, "api-server = '%s'\n", api)
	}
	if key != "" {
		fmt.Fprintf(&sb, "key = '%s'\n", key)
	}
	return sb.String()
}

func rustDeskConfigDirs() []string {
	dirs := []string{
		`C:\ProgramData\RustDesk\config`,
		`C:\Windows\System32\config\systemprofile\AppData\Roaming\RustDesk\config`,
		`C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config`,
	}
	usersRoot := os.Getenv("SystemDrive") + `\Users`
	if entries, err := os.ReadDir(usersRoot); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			name := e.Name()
			if name == "Public" || name == "Default" || name == "Default User" || name == "All Users" {
				continue
			}
			dirs = append(dirs, filepath.Join(usersRoot, name, `AppData\Roaming\RustDesk\config`))
		}
	}
	return dirs
}

func ensureRustDeskService() error {
	out, err := runWithTimeout(10*time.Second, "sc", "query", rustdeskServiceName)
	if err == nil {
		lower := strings.ToLower(string(out))
		if strings.Contains(lower, "running") {
			log.Printf("[rustdesk_manage] service already running")
			return nil
		}
		if strings.Contains(lower, strings.ToLower(rustdeskServiceName)) {
			log.Printf("[rustdesk_manage] service exists but not running — starting")
			if _, err2 := runWithTimeout(30*time.Second, "sc", "start", rustdeskServiceName); err2 != nil {
				return fmt.Errorf("sc start: %w", err2)
			}
			log.Printf("[rustdesk_manage] service started")
			return nil
		}
	}

	binPath := fmt.Sprintf(`%s --service`, rustdeskDefaultInstallPath)
	log.Printf("[rustdesk_manage] creating service")
	if _, err2 := runWithTimeout(15*time.Second, "sc", "create", rustdeskServiceName,
		"binPath=", binPath, "start=", "auto", "DisplayName=", "RustDesk"); err2 != nil {
		return fmt.Errorf("sc create: %w", err2)
	}
	if _, err2 := runWithTimeout(30*time.Second, "sc", "start", rustdeskServiceName); err2 != nil {
		return fmt.Errorf("sc start after create: %w", err2)
	}
	log.Printf("[rustdesk_manage] service created and started")
	return nil
}

func setRustDeskPassword(password string) error {
	if _, err := runWithTimeout(15*time.Second, rustdeskDefaultInstallPath, "--password", password); err != nil {
		return fmt.Errorf("set password: %w", err)
	}
	log.Printf("[rustdesk_manage] password configured")
	return nil
}

func downloadFile(url, dest string, timeoutSeconds int) error {
	if timeoutSeconds <= 0 {
		timeoutSeconds = 120
	}
	client := &http.Client{Timeout: time.Duration(timeoutSeconds) * time.Second}
	resp, err := client.Get(url) //nolint:noctx
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}
