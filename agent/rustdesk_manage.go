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
	// rustdeskDefaultInstallPath is the primary EXE path used for password
	// configuration and direct-launch fallbacks. Program Files, matching the
	// proven TECHI-Remote-Support.iss reference installer and the existing
	// fleet's install location -- NOT ProgramData (an earlier, incorrect
	// assumption baked into this same file; see git history).
	rustdeskDefaultInstallPath = `C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`
	// rustdeskLegacyExePath is a fallback for installations that still carry
	// the upstream rustdesk.exe binary name alongside the branded one.
	rustdeskLegacyExePath = `C:\Program Files\TECHI Remote Support\rustdesk.exe`
	// rustdeskServiceName is the Windows Service (installer.wxs ServiceInstall,
	// "--service") that runs the actual connection daemon -- this is what
	// accepts incoming remote-control sessions. RustDesk's own source confirms
	// "--tray" (rustdeskTrayTaskName below) is only a thin UI client that shows
	// an icon; it never starts a daemon by itself. An earlier change in this
	// codebase dropped this service on a theory that a SYSTEM-context service
	// can't do interactive screen capture (Session 0 isolation) -- that theory
	// was wrong: RustDesk's --service is designed to run exactly this way, and
	// without it Remote Support shows as installed/running (the tray) but
	// every connect attempt fails, since nothing is listening.
	rustdeskServiceName = "TECHI Remote Support"
	// rustdeskTrayTaskName is the Scheduled Task (created by installer.wxs)
	// that launches the tray icon in the logged-on user's own session at
	// logon -- "--tray". This is a cosmetic companion to the service above
	// (matches RustDesk's own install_service(), which both creates the SCM
	// service AND drops a --tray shortcut into the Startup folder) -- it is
	// NOT a substitute for the service. schtasks /run against this task is
	// how the agent (itself running as SYSTEM) can nudge the tray icon back
	// open in the user's session, the same Session-0 hand-off problem that
	// makes a direct exec.Command of the exe from this process ineffective.
	rustdeskTrayTaskName = "TECHI Remote Support Tray"
)

// ensureRustDesk checks and heals TECHI Remote Support installation, config, and service.
// Returns without error even if healing steps fail so heartbeat always continues.
func ensureRustDesk(cfg *Config, configPath string) {
	if !cfg.RustDeskManageEnabled {
		log.Printf("[rustdesk_manage] disabled — skipping")
		return
	}
	if installerTransactionActive() {
		log.Printf("[rustdesk_manage] installer transaction active — deferring Remote Support reconciliation")
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
		schemaChanged := cfg.RustDeskOptionsSchemaVer != rustDeskOptionsSchemaVersion
		skipConfigRepair := false
		if !cfg.RustDeskForceConfig && !schemaChanged && cfg.RustDeskLastRepairAt != "" {
			if lastRepair, err := time.Parse(time.RFC3339, cfg.RustDeskLastRepairAt); err == nil {
				since := time.Since(lastRepair)
				if since < 30*time.Minute {
					log.Printf("[rustdesk_manage] cooldown active (last repair %s ago) — skipping config repair",
						since.Round(time.Second))
					skipConfigRepair = true
				}
			}
		}
		if schemaChanged {
			log.Printf("[rustdesk_manage] managed options schema changed (%d -> %d) — bypassing cooldown",
				cfg.RustDeskOptionsSchemaVer, rustDeskOptionsSchemaVersion)
		}

		if !skipConfigRepair {
			if changed, err := writeRustDeskConfig(cfg); err != nil {
				log.Printf("[rustdesk_manage] config write failed: %v", err)
			} else if changed {
				repaired = true
			}
			cfg.RustDeskOptionsSchemaVer = rustDeskOptionsSchemaVersion
		}

		// Service is the real connection daemon -- always ensured regardless
		// of cooldown, same as the tray.
		if changed, err := ensureRustDeskService(); err != nil {
			log.Printf("[rustdesk_manage] service ensure failed: %v", err)
		} else if changed {
			repaired = true
		}

		// Tray is a cosmetic companion to the service -- always ensured too.
		if changed, err := ensureRustDeskTrayRunning(); err != nil {
			log.Printf("[rustdesk_manage] tray ensure failed: %v", err)
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

func installerTransactionActive() bool {
	info, err := os.Stat(installerActiveMarkerPath)
	if err != nil {
		return false
	}
	// A stale marker must not disable reconciliation forever after an
	// interrupted install/rollback. MSI rollback removes the marker; this is a
	// second safety net for power loss or a killed msiexec.
	return time.Since(info.ModTime()) < 30*time.Minute
}

func isRustDeskInstalled() bool {
	if _, err := os.Stat(rustdeskDefaultInstallPath); err == nil {
		return true
	}
	// Fallback: some older builds ship rustdesk.exe alongside the branded exe.
	_, err := os.Stat(rustdeskLegacyExePath)
	return err == nil
}

func verifyRustDeskSync(cfg *Config, info RustDeskInfo) string {
	if info.InstallStatus != "installed" {
		return "not_installed"
	}
	if !cfg.RustDeskManageEnabled {
		return "discovered"
	}
	found := false
	for _, dir := range rustDeskConfigDirs() {
		data, err := os.ReadFile(filepath.Join(dir, "TECHI Remote Support.toml"))
		if err != nil {
			continue
		}
		found = true
		if !rustDeskConfigNeedsRepair(string(data), cfg) {
			return "synced"
		}
	}
	if !found {
		return "sync_pending"
	}
	return "sync_failed"
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
			// Clear read-only (set by us after the last repair) before writing,
			// then restore it immediately after -- this is what prevents RustDesk
			// from wiping the managed keys when its service restarts.
			removeTomlReadOnly(path)
			if err := os.WriteFile(path, []byte(patched), 0644); err != nil {
				log.Printf("[rustdesk_manage] write %s: %v", path, err)
				continue
			}
			log.Printf("[rustdesk_manage] repaired: %s", path)
			setTomlReadOnly(path)
			repaired = true
		} else {
			// File does not exist yet: write a fresh minimal config.
			// Do NOT set read-only here -- RustDesk must be able to write its
			// own identity fields (id, enc_id, key_pair) into this file on
			// first run.  The next heartbeat cycle will find the file, detect
			// that managed options are missing, and patch+protect it then.
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

// isRustDeskProcessRunning checks via tasklist whether the tray app process
// is already running in some session. There is no SCM service to query --
// see the rustdeskTrayTaskName comment for why.
func isRustDeskProcessRunning() bool {
	out, err := runWithTimeout(10*time.Second, "tasklist", "/FI", "IMAGENAME eq TECHI Remote Support.exe")
	if err == nil && strings.Contains(string(out), "TECHI Remote Support.exe") {
		return true
	}
	out, err = runWithTimeout(10*time.Second, "tasklist", "/FI", "IMAGENAME eq rustdesk.exe")
	return err == nil && strings.Contains(strings.ToLower(string(out)), "rustdesk.exe")
}

// stopRustDeskTray kills any running tray process, across sessions. Used
// before a restart/reinstall/config-repair/password-change so the relaunch
// picks up fresh state. No SCM service to stop -- see rustdeskTrayTaskName.
func stopRustDeskTray() {
	_, _ = runWithTimeout(15*time.Second, "taskkill", "/F", "/IM", "TECHI Remote Support.exe")
	_, _ = runWithTimeout(15*time.Second, "taskkill", "/F", "/IM", "rustdesk.exe")
}

// startRustDeskTray triggers the Scheduled Task to relaunch the tray app in
// the logged-on user's own session. Falls back to a direct launch from this
// (SYSTEM) process if the task is missing or schtasks fails -- that won't
// render interactively (Session 0), but still gets *a* process running.
func startRustDeskTray() error {
	if _, err := runWithTimeout(15*time.Second, "schtasks", "/run", "/tn", rustdeskTrayTaskName); err == nil {
		return nil
	}
	_, err := runWithTimeout(15*time.Second, rustdeskDefaultInstallPath, "--tray")
	return err
}

// ensureRustDeskTrayRunning nudges Remote Support back open if it's not
// running, by triggering the Scheduled Task installer.wxs creates (At Logon
// trigger, runs as the interactive user). schtasks /run executes the task's
// action immediately in the currently logged-on user's session even though
// this agent process itself runs as SYSTEM -- the Task Scheduler service
// handles that session hand-off correctly, unlike a raw exec.Command of the
// exe from a SYSTEM process (which would be confined to Session 0). If no
// user is logged on, the task simply won't have anywhere to run, same as it
// wouldn't have run at logon either -- an accepted limitation of this model.
func ensureRustDeskTrayRunning() (bool, error) {
	if isRustDeskProcessRunning() {
		return false, nil
	}
	log.Printf("[rustdesk_manage] tray not running — triggering scheduled task")
	if _, err := runWithTimeout(10*time.Second, "schtasks", "/run", "/tn", rustdeskTrayTaskName); err != nil {
		return false, fmt.Errorf("schtasks /run: %w", err)
	}
	log.Printf("[rustdesk_manage] scheduled task triggered")
	return true, nil
}

// ensureRustDeskService makes sure the SCM service -- the actual connection
// daemon -- is running, creating it if installer.wxs's ServiceInstall somehow
// didn't (e.g. an older install predating the service). Mirrors RustDesk's
// own get_create_service(): binPath is the exe with "--service" appended.
func ensureRustDeskService() (bool, error) {
	out, err := runWithTimeout(10*time.Second, "sc", "query", rustdeskServiceName)
	if err == nil {
		lower := strings.ToLower(string(out))
		if strings.Contains(lower, "running") {
			setRustDeskServiceRecovery()
			return false, nil
		}
		if strings.Contains(lower, strings.ToLower(rustdeskServiceName)) {
			log.Printf("[rustdesk_manage] service exists but not running — starting")
			if _, err2 := runWithTimeout(30*time.Second, "sc", "start", rustdeskServiceName); err2 != nil {
				return false, fmt.Errorf("sc start: %w", err2)
			}
			log.Printf("[rustdesk_manage] service started")
			setRustDeskServiceRecovery()
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
	setRustDeskServiceRecovery()
	return true, nil
}

// setRustDeskServiceRecovery configures SCM to auto-restart the service if it
// ever exits, on any cause -- including a user closing it from the tray icon.
// RustDesk's tray "Exit" can terminate the whole process the SCM is tracking
// (not just hide a window), so without this an operator clicking it stops
// remote-support connectivity until the next heartbeat's ensureRustDeskService
// call (up to HeartbeatSeconds later). 15s/15s/60s restart delays make SCM
// itself bring it back almost immediately, well before that.
func setRustDeskServiceRecovery() {
	if _, err := runWithTimeout(10*time.Second, "sc", "failure", rustdeskServiceName,
		"reset=", "86400", "actions=", "restart/15000/restart/15000/restart/60000"); err != nil {
		log.Printf("[rustdesk_manage] sc failure (recovery policy) failed: %v", err)
	}
}

// stopRustDeskServiceFn and startRustDeskServiceFn give action handlers a
// restart sequence for the actual connection daemon, mirroring stopRustDeskTray
// / startRustDeskTray for the cosmetic tray companion.
func stopRustDeskServiceFn() {
	_, _ = runWithTimeout(15*time.Second, "sc", "stop", rustdeskServiceName)
}

func startRustDeskServiceFn() error {
	if _, err := runWithTimeout(30*time.Second, "sc", "start", rustdeskServiceName); err != nil {
		// Service might not exist yet on an older install -- fall back to
		// ensureRustDeskService, which creates it if needed.
		if _, err2 := ensureRustDeskService(); err2 != nil {
			return fmt.Errorf("sc start: %v; ensure failed: %w", err, err2)
		}
		return nil
	}
	setRustDeskServiceRecovery()
	return nil
}

// setRustDeskPassword writes the plaintext password directly into the
// identity config file (the suffix-less "TECHI Remote Support.toml" --
// hbb_common/src/config.rs: Config::load_("") holds id/enc_id/password/salt/
// key_pair; the "2"-suffixed file is Config2/options, a different file).
// RustDesk hashes a plaintext password automatically the next time it loads
// or stores this file (migrate_permanent_password_to_hashed_storage), so
// this does not require a running daemon -- unlike the `--password` CLI
// flag, which talks to the daemon over IPC and silently no-ops (still exits
// 0) if nothing is listening.
func setRustDeskPassword(password string) error {
	dirs := rustDeskConfigDirs()
	wrote := false
	var lastErr error
	for _, dir := range dirs {
		path := filepath.Join(dir, "TECHI Remote Support.toml")
		existing, readErr := os.ReadFile(path)
		if readErr != nil {
			// Identity file doesn't exist here yet -- nothing to patch; it's
			// created by RustDesk itself on first run, not by us.
			continue
		}
		patched, changed := applyTOMLTopLevelPatch(string(existing), "password", password)
		if !changed {
			wrote = true
			continue
		}
		removeTomlReadOnly(path)
		if err := os.WriteFile(path, []byte(patched), 0644); err != nil {
			lastErr = err
			continue
		}
		setTomlReadOnly(path)
		log.Printf("[rustdesk_manage] password written to %s", path)
		wrote = true
	}
	if !wrote {
		if lastErr != nil {
			return fmt.Errorf("set password: %w", lastErr)
		}
		return fmt.Errorf("set password: no identity config file found in any known location")
	}
	return nil
}

// applyRemoteSupportPassword sets the server-pushed per-device password on
// RustDesk and restarts the service so it takes effect immediately, instead of
// waiting for the next management cycle. Best-effort; errors are logged only.
func applyRemoteSupportPassword(password string) {
	if strings.TrimSpace(password) == "" {
		return
	}
	if err := setRustDeskPassword(password); err != nil {
		log.Printf("[rustdesk_manage] apply per-device password failed: %v", err)
		return
	}
	stopRustDeskServiceFn()
	time.Sleep(1 * time.Second)
	if err := startRustDeskServiceFn(); err != nil {
		log.Printf("[rustdesk_manage] restart after password (non-fatal): %v", err)
	}
	log.Printf("[rustdesk_manage] applied per-device password from server")
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
