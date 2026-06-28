package main

import (
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
)

const (
	windowsConfigPath       = `C:\ProgramData\TechiAgent\agent.config.json`
	windowsLegacyConfigPath = `C:\ProgramData\TECHI\agent.config.json`
	windowsLogPath          = `C:\ProgramData\TechiAgent\logs\agent.log`
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
		return refreshEnrollmentTokenIfNeeded(configPath, legacyConfigPath)
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

	src, err := os.Open(legacyConfigPath)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.OpenFile(configPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(dst, src)
	closeErr := dst.Close()
	if copyErr != nil {
		_ = os.Remove(configPath)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(configPath)
		return closeErr
	}
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
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if fileOnly {
		log.SetOutput(file)
		return nil
	}
	log.SetOutput(io.MultiWriter(os.Stderr, file))
	return nil
}
