//go:build linux

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

// performSelfUpdate on Linux: download the new binary, verify SHA256, atomically
// replace the running executable (rename is safe while running — the old inode
// stays open), then `systemctl restart` to re-exec. Mirrors the Windows
// philosophy (download → verify → swap → restart) without Scheduled Tasks.
//
// rep (may be nil) receives the progress and any failure; see
// update_progress.go for the stages.
func performSelfUpdate(update *AgentUpdate, rep updateReporter) {
	if update == nil || !update.Available || update.URL == "" {
		return
	}
	log.Printf("[self_update] starting binary update to v%s from %s", update.Version, update.URL)

	self, err := os.Executable()
	if err != nil {
		reason := fmt.Sprintf("swap could not start: cannot resolve own path: %v", err)
		log.Printf("[self_update] %s", reason)
		if rep != nil {
			rep.Fail(reason)
		}
		return
	}
	self, _ = filepath.EvalSymlinks(self)

	tmp := self + ".new"
	defer os.Remove(tmp)
	if err := runSelfUpdate(update, rep, tmp, func(path string) error {
		if err := os.Chmod(path, 0755); err != nil {
			return fmt.Errorf("chmod: %w", err)
		}
		// Keep the previous binary for rollback, then atomically swap.
		_ = os.Rename(self, self+".old")
		if err := os.Rename(path, self); err != nil {
			_ = os.Rename(self+".old", self)
			return fmt.Errorf("replace binary: %w", err)
		}
		return nil
	}); err != nil {
		return
	}
	log.Printf("[self_update] binary replaced; restarting service")
	reportProgress(rep, stageRestarting, progressRestarting,
		fmt.Sprintf("Binary replaced; the agent service restarts with v%s", update.Version))
	flushReporter(rep, reporterFlushWait)

	if hasSystemd() {
		if err := exec.Command("systemctl", "restart", linuxServiceName).Run(); err != nil {
			log.Printf("[self_update] systemctl restart failed: %v", err)
		}
	} else {
		log.Printf("[self_update] no systemd; exiting so a supervisor can re-exec")
		os.Exit(0)
	}
}
