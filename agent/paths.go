package main

import (
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
)

const (
	windowsConfigPath = `C:\ProgramData\TECHI\agent.config.json`
	windowsLogPath    = `C:\ProgramData\TECHI\logs\agent.log`
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
