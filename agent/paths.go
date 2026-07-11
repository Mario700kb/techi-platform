package main

import (
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const (
	windowsConfigPath       = `C:\ProgramData\TechiAgent\agent.config.json`
	windowsLegacyConfigPath = `C:\ProgramData\TECHI\agent.config.json`
	windowsLogPath          = `C:\ProgramData\TechiAgent\logs\agent.log`

	agentLogMaxBytes  = 5 * 1024 * 1024
	deployLogMaxBytes = 1 * 1024 * 1024
)

func defaultConfigPath() string {
	if runtime.GOOS == "windows" {
		return windowsConfigPath
	}
	return "config.json"
}

func defaultLogPath() string {
	if runtime.GOOS == "windows" {
		return windowsLogPath
	}
	return ""
}

func migrateLegacyConfigIfNeeded(configPath string) error {
	if runtime.GOOS != "windows" || configPath != windowsConfigPath {
		return nil
	}
	return migrateConfigIfNeeded(configPath, windowsLegacyConfigPath, defaultLogPath())
}

func migrateConfigIfNeeded(configPath string, legacyConfigPath string, logPath string) error {
	if _, err := os.Stat(configPath); err == nil {
		// Canonical is authoritative once present. Validate it, but never merge
		// or overwrite it from the legacy bootstrap source.
		_, err = loadConfig(configPath)
		return err
	} else if !os.IsNotExist(err) {
		return err
	}
	if _, err := os.Stat(legacyConfigPath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if dir := filepath.Dir(configPath); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	if logPath != "" {
		if err := os.MkdirAll(filepath.Dir(logPath), 0700); err != nil {
			return err
		}
	}

	// A malformed bootstrap file must never become the canonical runtime
	// config. loadConfig also proves the source is readable.
	if _, err := loadConfig(legacyConfigPath); err != nil {
		return err
	}
	data, err := os.ReadFile(legacyConfigPath)
	if err != nil {
		return err
	}
	tmp := configPath + ".migrate.tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	if _, err := loadConfig(tmp); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, configPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	lockdownConfigACL(configPath)
	log.Printf("migrated legacy agent config from %s to %s", legacyConfigPath, configPath)
	return nil
}

// refreshEnrollmentTokenIfNeeded covers a device whose canonical config
// already exists but was never successfully enrolled (no device_id) and
// has no token of its own -- e.g. a prior install that left a half-written
// file before the agent's first heartbeat. Without this, a device stuck in
// that state stays stuck forever: the plain copy above only runs once, the
// very first time the canonical file is created, so a later MSI run that
// writes a fresh, valid token into the legacy file never reaches the
// canonical file the agent actually loads. Never touches a file that
// already has a device_id -- enrollment, once established, is untouched.
func refreshEnrollmentTokenIfNeeded(configPath string, legacyConfigPath string) error {
	canonicalBytes, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	var canonical struct {
		DeviceID        int    `json:"device_id,omitempty"`
		EnrollmentToken string `json:"enrollment_token,omitempty"`
	}
	if err := json.Unmarshal(canonicalBytes, &canonical); err != nil {
		return err
	}
	if canonical.DeviceID != 0 || canonical.EnrollmentToken != "" {
		return nil
	}

	legacyBytes, err := os.ReadFile(legacyConfigPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var legacy struct {
		EnrollmentToken string `json:"enrollment_token,omitempty"`
	}
	if err := json.Unmarshal(legacyBytes, &legacy); err != nil {
		return err
	}
	if legacy.EnrollmentToken == "" {
		return nil
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(canonicalBytes, &raw); err != nil {
		return err
	}
	raw["enrollment_token"] = legacy.EnrollmentToken
	updated, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	if err := os.WriteFile(configPath, updated, 0600); err != nil {
		return err
	}
	log.Printf("refreshed enrollment_token in %s from %s (device not yet enrolled)", configPath, legacyConfigPath)
	return nil
}

func configureLogging(path string, fileOnly bool) error {
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	writer, err := newRotatingFileWriter(path, agentLogMaxBytes)
	if err != nil {
		return err
	}
	if fileOnly {
		log.SetOutput(writer)
		return nil
	}
	log.SetOutput(io.MultiWriter(os.Stderr, writer))
	return nil
}

// rotatingFileWriter appends to path and, when the file would exceed maxBytes,
// renames it to path+".1" (replacing any previous one) and starts fresh. Disk
// usage is therefore bounded at ~2×maxBytes per log. The standard log package
// serialises writes, so no extra locking is needed here.
type rotatingFileWriter struct {
	path        string
	maxBytes    int64
	file        *os.File
	size        int64
	lastAttempt time.Time
}

func newRotatingFileWriter(path string, maxBytes int64) (*rotatingFileWriter, error) {
	w := &rotatingFileWriter{path: path, maxBytes: maxBytes}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *rotatingFileWriter) open() error {
	file, err := os.OpenFile(w.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return err
	}
	w.file = file
	w.size = info.Size()
	return nil
}

func (w *rotatingFileWriter) Write(p []byte) (int, error) {
	// The time guard keeps a failed rename (file locked by AV etc.) from
	// being retried on every single write.
	if w.size+int64(len(p)) > w.maxBytes && time.Since(w.lastAttempt) > time.Minute {
		w.lastAttempt = time.Now()
		w.rotate()
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	return n, err
}

func (w *rotatingFileWriter) rotate() {
	_ = w.file.Close()
	_ = os.Remove(w.path + ".1")
	_ = os.Rename(w.path, w.path+".1")
	if err := w.open(); err != nil {
		// Reopen must never leave the writer without a handle; retry plain.
		w.file, _ = os.OpenFile(w.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		w.size = 0
	}
}

// rotateFileIfOversize is for logs written via short-lived appends
// (deploy.log): rename to .1 once the size cap is passed.
func rotateFileIfOversize(path string, maxBytes int64) {
	info, err := os.Stat(path)
	if err != nil || info.Size() <= maxBytes {
		return
	}
	_ = os.Remove(path + ".1")
	_ = os.Rename(path, path+".1")
}
