package main

import (
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
		return nil
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
