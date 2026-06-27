//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
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
	// rustdeskDefaultInstallPath is the primary EXE path used for service
	// registration, password configuration, and direct-launch fallbacks.
	// ProgramData (not Program Files) to match installer.wxs and the
	// existing fleet's install location.
	rustdeskDefaultInstallPath = `C:\ProgramData\TECHI Remote Support\TECHI Remote Support.exe`
	// rustdeskLegacyExePath is a fallback for installations that still carry
	// the upstream rustdesk.exe binary name alongside the branded one.
	rustdeskLegacyExePath = `C:\ProgramData\TECHI Remote Support\rustdesk.exe`
	rustdeskServiceName   = "TECHI Remote Support"
)

// ensureRustDesk checks and heals TECHI Remote Support installation, config, and service.
// Returns without error even if healing steps fail so heartbeat always continues.
func ensureRustDesk(cfg *Config, configPath string) {
	if !cfg.RustDeskManageEnabled {
		log.Printf("[rustdesk_manage] disabled — skipping")
		return
	}

	installed := isRustDeskInstalled()
	repaired := false

	if !installed {
		if cfg.RustDeskMSIUrl == "" {
			log.Printf("[rustdesk_manage] not installed and no MSI URL configured — skipping install")
		} else {
			if err := installRustDeskMSI(cfg); err != nil {
				log.Printf("[rustdesk_manage] install failed: %v — continuing heartbeat", err)
				return
			}
			repaired = true
			installed = isRustDeskInstalled()
		}
	} else {
		log.Printf("[rustdesk_manage] already installed at %s", rustdeskDefaultInstallPath)
	}

	if installed {
		// Config repair with 30-minute cooldown.
		// The cooldown prevents unnecessary writes on every heartbeat when the
		// service has already updated the config with identity data.
		skipConfigRepair := false
		if !cfg.RustDeskForceConfig && cfg.RustDeskLastRepairAt != "" {
			if lastRepair, err := time.Parse(time.RFC3339, cfg.RustDeskLastRepairAt); err == nil {
				since := time.Since(lastRepair)
				if since < 30*time.Minute {
					log.Printf("[rustdesk_manage] cooldown active (last repair %s ago) — skipping config repair",
						since.Round(time.Second))
					skipConfigRepair = true
				}
			}
		}

		if !skipConfigRepair {
			if changed, err := writeRustDeskConfig(cfg); err != nil {
				log.Printf("[rustdesk_manage] config write failed: %v", err)
			} else if changed {
				repaired = true
			}
		}

		// Service check always runs regardless of cooldown.
		if changed, err := ensureRustDeskService(); err != nil {
			log.Printf("[rustdesk_manage] service ensure failed: %v", err)
		} else if changed {
			repaired = true
		}

		if cfg.RustDeskDefaultPassword != "" {
			if err := setRustDeskPassword(cfg.RustDeskDefaultPassword); err != nil {
				log.Printf("[rustdesk_manage] password set failed: %v", err)
			}
		}
	}

	if repaired {
		recordRustDeskRepair(cfg, configPath)
	}
}

func isRustDeskInstalled() bool {
	if _, err := os.Stat(rustdeskDefaultInstallPath); err == nil {
		return true
	}
	// Fallback: some older builds ship rustdesk.exe alongside the branded exe.
	_, err := os.Stat(rustdeskLegacyExePath)
	return err == nil
}

func installRustDeskMSI(cfg *Config) error {
	log.Printf("[rustdesk_manage] downloading MSI from %s", cfg.RustDeskMSIUrl)

	cachePath, err := cachedMSIPath(cfg)
	if err != nil {
		return err
	}
	if err := ensureCachedMSI(cfg, cachePath); err != nil {
		return fmt.Errorf("MSI cache failed: %w", err)
	}

	log.Printf("[rustdesk_manage] installing MSI silently")
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		if _, err := runWithTimeout(5*time.Minute, "msiexec", "/i", cachePath, "/qn", "/norestart"); err == nil {
			log.Printf("[rustdesk_manage] installed successfully")
			return nil
		} else {
			lastErr = err
			if attempt < 3 {
				delay := time.Duration(1<<uint(attempt-1)) * 5 * time.Second
				log.Printf("[rustdesk_manage] msiexec attempt %d failed: %v; retrying in %s", attempt, err, delay)
				time.Sleep(delay)
			}
		}
	}
	return fmt.Errorf("msiexec failed: %w", lastErr)
}

// writeRustDeskConfig ensures managed [options] keys are correct in every
// known config location. It operates in patch mode: existing files are updated
// in-place so identity fields (enc_id, key_pair, etc.) are never overwritten.
// New config files are created with a minimal base template.
//
// Returns (true, nil) only when at least one EXISTING file was repaired
// (managed values were wrong and have been corrected). Creating a config file
// that did not previously exist is initialisation, not repair, and is not
// counted as a change.
func writeRustDeskConfig(cfg *Config) (bool, error) {
	managed := managedRustDeskOptions(cfg)
	if len(managed) == 0 {
		return false, nil
	}

	dirs := rustDeskConfigDirs()
	repaired := false

	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Printf("[rustdesk_manage] mkdir %s: %v", dir, err)
			continue
		}

		// Only write TECHI Remote Support.toml (the options/config file).
		// TECHI Remote Support2.toml is the identity file managed by the
		// service itself — writing to it causes the repair loop.
		path := filepath.Join(dir, "TECHI Remote Support.toml")

		existing, readErr := os.ReadFile(path)

		if readErr == nil {
			// File exists: check whether managed values are already correct.
			existingStr := string(existing)
			if !cfg.RustDeskForceConfig && !rustDeskConfigNeedsRepair(existingStr, cfg) {
				continue // already correct, nothing to do
			}
			// Patch in-place: update only managed keys, leave identity intact.
			patched, changed := applyTOMLOptionPatch(existingStr, managed)
			if !changed {
				continue
			}
			if err := os.WriteFile(path, []byte(patched), 0644); err != nil {
				log.Printf("[rustdesk_manage] write %s: %v", path, err)
				continue
			}
			log.Printf("[rustdesk_manage] repaired: %s", path)
			repaired = true
		} else {
			// File does not exist yet: write a fresh minimal config.
			newContent := buildRustDeskTOML(cfg)
			if err := os.WriteFile(path, []byte(newContent), 0644); err != nil {
				log.Printf("[rustdesk_manage] init write %s: %v", path, err)
				continue
			}
			log.Printf("[rustdesk_manage] initialized: %s", path)
			// Intentionally NOT setting repaired=true for fresh files.
		}
	}

	return repaired, nil
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
		`C:\ProgramData\TECHI Remote Support\config`,
		`C:\Windows\System32\config\systemprofile\AppData\Roaming\TECHI Remote Support\config`,
		`C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\TECHI Remote Support\config`,
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
			dirs = append(dirs, filepath.Join(usersRoot, name, `AppData\Roaming\TECHI Remote Support\config`))
		}
	}
	return dirs
}

func ensureRustDeskService() (bool, error) {
	out, err := runWithTimeout(10*time.Second, "sc", "query", rustdeskServiceName)
	if err == nil {
		lower := strings.ToLower(string(out))
		if strings.Contains(lower, "running") {
			log.Printf("[rustdesk_manage] service already running")
			return false, nil
		}
		if strings.Contains(lower, strings.ToLower(rustdeskServiceName)) {
			log.Printf("[rustdesk_manage] service exists but not running — starting")
			if _, err2 := runWithTimeout(30*time.Second, "sc", "start", rustdeskServiceName); err2 != nil {
				return false, fmt.Errorf("sc start: %w", err2)
			}
			log.Printf("[rustdesk_manage] service started")
			return true, nil
		}
	}

	binPath := fmt.Sprintf(`%s --service`, rustdeskDefaultInstallPath)
	log.Printf("[rustdesk_manage] creating service")
	if _, err2 := runWithTimeout(15*time.Second, "sc", "create", rustdeskServiceName,
		"binPath=", binPath, "start=", "auto", "DisplayName=", "TECHI Remote Support"); err2 != nil {
		return false, fmt.Errorf("sc create: %w", err2)
	}
	if _, err2 := runWithTimeout(30*time.Second, "sc", "start", rustdeskServiceName); err2 != nil {
		return false, fmt.Errorf("sc start after create: %w", err2)
	}
	log.Printf("[rustdesk_manage] service created and started")
	return true, nil
}

func setRustDeskPassword(password string) error {
	if _, err := runWithTimeout(15*time.Second, rustdeskDefaultInstallPath, "--password", password); err != nil {
		return fmt.Errorf("set password: %w", err)
	}
	log.Printf("[rustdesk_manage] password configured")
	return nil
}


func recordRustDeskRepair(cfg *Config, configPath string) {
	cfg.RustDeskRepairCount++
	cfg.RustDeskLastRepairAt = time.Now().UTC().Format(time.RFC3339)
	if configPath == "" {
		return
	}
	if err := saveConfig(configPath, cfg); err != nil {
		log.Printf("[rustdesk_manage] repair state save failed: %v", err)
	}
}

func cachedMSIPath(cfg *Config) (string, error) {
	// filepath.Join never returns "" even when its first argument is "",
	// so check the env var explicitly before joining.
	programData := strings.TrimSpace(os.Getenv("ProgramData"))
	var base string
	if programData != "" {
		base = programData
	} else {
		base = os.TempDir()
	}
	root := filepath.Join(base, "TechiAgent", "cache")
	if err := os.MkdirAll(root, 0755); err != nil {
		return "", err
	}
	version := sanitizeCachePart(cfg.RustDeskPackageVersion)
	if version == "" {
		version = "latest"
	}
	return filepath.Join(root, "TECHI-Remote-Support-"+version+".msi"), nil
}

func sanitizeCachePart(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	var b strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func ensureCachedMSI(cfg *Config, cachePath string) error {
	expected := strings.TrimSpace(strings.ToLower(cfg.RustDeskMSIChecksumSHA256))
	if fileExists(cachePath) && (expected == "" || sha256Matches(cachePath, expected)) {
		log.Printf("[rustdesk_manage] using cached MSI at %s", cachePath)
		return nil
	}

	tmpPath := cachePath + ".download"
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		if err := downloadFile(cfg.RustDeskMSIUrl, tmpPath, cfg.TimeoutSeconds*10); err == nil {
			if expected != "" && !sha256Matches(tmpPath, expected) {
				_ = os.Remove(tmpPath)
				return fmt.Errorf("downloaded MSI checksum mismatch")
			}
			return os.Rename(tmpPath, cachePath)
		} else {
			lastErr = err
			if attempt < 3 {
				delay := time.Duration(1<<uint(attempt-1)) * 5 * time.Second
				log.Printf("[rustdesk_manage] MSI download attempt %d failed: %v; retrying in %s", attempt, err, delay)
				time.Sleep(delay)
			}
		}
	}

	if fileExists(cachePath) && (expected == "" || sha256Matches(cachePath, expected)) {
		log.Printf("[rustdesk_manage] backend unavailable; falling back to cached MSI at %s", cachePath)
		return nil
	}
	return lastErr
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func sha256Matches(path string, expected string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	sum := sha256.New()
	if _, err := io.Copy(sum, file); err != nil {
		return false
	}
	return hex.EncodeToString(sum.Sum(nil)) == expected
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
