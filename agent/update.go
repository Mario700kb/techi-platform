//go:build windows

package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// performSelfUpdate downloads the MSI at update.URL, verifies its SHA256 (if
// provided), and installs it silently via msiexec. Called in a goroutine so it
// does not block the heartbeat loop.
func performSelfUpdate(update *AgentUpdate) {
	if update == nil || !update.Available || update.URL == "" {
		return
	}
	log.Printf("[self_update] starting update to v%s from %s", update.Version, update.URL)

	msiPath := agentMSICachePath(update.Version)
	if err := downloadAgentMSI(update.URL, msiPath); err != nil {
		log.Printf("[self_update] download failed: %v", err)
		return
	}

	if update.Checksum != "" {
		if !sha256Matches(msiPath, strings.ToLower(update.Checksum)) {
			log.Printf("[self_update] checksum mismatch — aborting")
			_ = os.Remove(msiPath)
			return
		}
		log.Printf("[self_update] checksum verified")
	}

	log.Printf("[self_update] installing %s", msiPath)
	if err := installAgentMSI(msiPath); err != nil {
		log.Printf("[self_update] install failed: %v", err)
		return
	}

	log.Printf("[self_update] v%s installed successfully — service will restart via SCM", update.Version)
	_ = os.Remove(msiPath)
}

// agentMSICachePath returns a stable temp path for the agent MSI.
func agentMSICachePath(version string) string {
	programData := strings.TrimSpace(os.Getenv("ProgramData"))
	base := os.TempDir()
	if programData != "" {
		base = programData
	}
	dir := filepath.Join(base, "TechiAgent", "cache")
	_ = os.MkdirAll(dir, 0755)
	v := sanitizeCachePart(version)
	if v == "" {
		v = "latest"
	}
	return filepath.Join(dir, "techi-agent-"+v+".msi")
}

// downloadAgentMSI downloads url to dest with 3 attempts and exponential backoff.
func downloadAgentMSI(url, dest string) error {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		if err := downloadFile(url, dest, 300); err == nil {
			return nil
		} else {
			lastErr = err
			if attempt < 3 {
				delay := time.Duration(attempt*30) * time.Second
				log.Printf("[self_update] download attempt %d failed: %v; retrying in %s", attempt, err, delay)
				time.Sleep(delay)
			}
		}
	}
	return fmt.Errorf("download failed after 3 attempts: %w", lastErr)
}

// installAgentMSI runs msiexec silently. Exit code 3010 (reboot required) is
// treated as success — the Windows SCM auto-recovery restarts the service.
func installAgentMSI(msiPath string) error {
	cmd := exec.Command(
		"msiexec", "/i", msiPath,
		"/quiet", "/norestart",
		"REINSTALL=ALL", "REINSTALLMODE=vomus",
	)
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 3010 {
			return nil // reboot required — treat as success
		}
		return fmt.Errorf("msiexec: %w", err)
	}
	return nil
}
