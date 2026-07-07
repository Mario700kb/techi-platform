//go:build linux

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// performSelfUpdate on Linux: download the new binary, verify SHA256, atomically
// replace the running executable (rename is safe while running — the old inode
// stays open), then `systemctl restart` to re-exec. Mirrors the Windows
// philosophy (download → verify → swap → restart) without Scheduled Tasks.
func performSelfUpdate(update *AgentUpdate) {
	if update == nil || !update.Available || update.URL == "" {
		return
	}
	log.Printf("[self_update] starting binary update to v%s from %s", update.Version, update.URL)

	self, err := os.Executable()
	if err != nil {
		log.Printf("[self_update] cannot resolve own path: %v", err)
		return
	}
	self, _ = filepath.EvalSymlinks(self)

	tmp := self + ".new"
	if err := linuxDownloadFile(update.URL, tmp, 120); err != nil {
		log.Printf("[self_update] download failed: %v", err)
		return
	}
	defer os.Remove(tmp)

	if update.Checksum != "" {
		sum, err := linuxSHA256(tmp)
		if err != nil || !strings.EqualFold(sum, update.Checksum) {
			log.Printf("[self_update] checksum mismatch (want %s got %s); aborting", update.Checksum, sum)
			return
		}
		log.Printf("[self_update] checksum verified")
	}

	if err := os.Chmod(tmp, 0755); err != nil {
		log.Printf("[self_update] chmod failed: %v", err)
		return
	}
	// Keep the previous binary for rollback, then atomically swap.
	_ = os.Rename(self, self+".old")
	if err := os.Rename(tmp, self); err != nil {
		log.Printf("[self_update] swap failed: %v; restoring", err)
		_ = os.Rename(self+".old", self)
		return
	}
	log.Printf("[self_update] binary replaced; restarting service")

	if hasSystemd() {
		if err := exec.Command("systemctl", "restart", linuxServiceName).Run(); err != nil {
			log.Printf("[self_update] systemctl restart failed: %v", err)
		}
	} else {
		log.Printf("[self_update] no systemd; exiting so a supervisor can re-exec")
		os.Exit(0)
	}
}

func linuxDownloadFile(url, dest string, timeoutSeconds int) error {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		if err := linuxDownloadOnce(url, dest, timeoutSeconds); err == nil {
			return nil
		} else {
			lastErr = err
			if attempt < 3 {
				time.Sleep(time.Duration(attempt*15) * time.Second)
			}
		}
	}
	return fmt.Errorf("download failed after 3 attempts: %w", lastErr)
}

func linuxDownloadOnce(url, dest string, timeoutSeconds int) error {
	client := &http.Client{Timeout: time.Duration(timeoutSeconds) * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, resp.Body)
	return err
}

func linuxSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
