//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// performSelfUpdate downloads the new techi-agent.exe, verifies its SHA256,
// then hands the binary swap to a detached copy of the new binary itself.
// The swap process survives when SCM stops this service process during the
// replacement.
//
// The MSI is never touched here -- self_update ships only the agent binary.
// TECHI Remote Support is never affected.
func performSelfUpdate(update *AgentUpdate) {
	if update == nil || !update.Available || update.URL == "" {
		return
	}
	log.Printf("[self_update] starting binary update to v%s from %s", update.Version, update.URL)

	exePath := agentBinaryCachePath(update.Version)
	if err := downloadAgentBinary(update.URL, exePath); err != nil {
		log.Printf("[self_update] download failed: %v", err)
		return
	}

	if update.Checksum != "" {
		if !sha256Matches(exePath, strings.ToLower(update.Checksum)) {
			log.Printf("[self_update] checksum mismatch; aborting")
			_ = os.Remove(exePath)
			return
		}
		log.Printf("[self_update] checksum verified")
	}

	log.Printf("[self_update] scheduling detached binary swap for %s", exePath)
	if err := swapAgentBinary(exePath); err != nil {
		log.Printf("[self_update] schedule failed: %v", err)
		return
	}

	log.Printf("[self_update] v%s swap helper launched", update.Version)
}

// agentBinaryCachePath returns a stable temp path for the downloaded exe.
func agentBinaryCachePath(version string) string {
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
	return filepath.Join(dir, "techi-agent-"+v+".exe")
}

// downloadAgentBinary downloads url to dest with 3 attempts and exponential backoff.
func downloadAgentBinary(url, dest string) error {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		if err := downloadFile(url, dest, 120); err == nil {
			return nil
		} else {
			lastErr = err
			if attempt < 3 {
				delay := time.Duration(attempt*15) * time.Second
				log.Printf("[self_update] download attempt %d failed: %v; retrying in %s", attempt, err, delay)
				time.Sleep(delay)
			}
		}
	}
	return fmt.Errorf("download failed after 3 attempts: %w", lastErr)
}

// swapAgentBinary runs the downloaded new exe itself through a one-shot
// Scheduled Task as SYSTEM (`techi-agent.exe swap-binary ...`).  Starting a
// plain child process from the agent is not enough: when the swap stops
// TechiAgent, Windows can terminate child processes that still belong to the
// service's process/job tree.  Task Scheduler gives the swap an independent
// parent before the service stops.
//
// No PowerShell (or any script) is involved: strict AV/AMSI policies on some
// managed domains block every script the agent writes, which used to make
// self_update fail silently there.  The swap logic itself lives in
// swap_windows.go and runs as native code inside the new binary.
func swapAgentBinary(newExePath string) error {
	if strings.TrimSpace(newExePath) == "" {
		return fmt.Errorf("empty exe path")
	}
	if _, err := os.Stat(newExePath); err != nil {
		return fmt.Errorf("new exe not accessible: %w", err)
	}

	taskName := "TECHI-Agent-SelfUpdate-" + sanitizeCachePart(time.Now().UTC().Format("20060102T150405Z"))
	taskRun := fmt.Sprintf(`"%s" swap-binary -swap-target "%s" -swap-task "%s"`,
		newExePath, agentTargetExePath(), taskName)
	if err := registerOneShotSystemTask(taskName, taskRun); err != nil {
		return fmt.Errorf("start swap task: %w", err)
	}
	writeDeployLog("[self_update]", fmt.Sprintf("scheduled task launched task=%s new=%s", taskName, newExePath))
	return nil
}
