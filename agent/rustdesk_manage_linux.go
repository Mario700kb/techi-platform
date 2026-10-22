//go:build linux

package main

import (
	"context"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// TECHI Remote Support on Linux is the upstream RustDesk package that the
// installer (/api/v1/install/linux) puts on machines with a desktop. Its
// systemd unit "rustdesk" runs as root, so its identity (id, key pair,
// password) lives in /root/.config/rustdesk/RustDesk.toml and its options in
// RustDesk2.toml. The installer writes the ID server options; the agent
// reports the ID and applies the per-device password the server hands out.

const linuxRustDeskUnit = "rustdesk"

// linuxRustDeskBinary returns the rustdesk executable, or "" when Remote
// Support is not installed.
func linuxRustDeskBinary() string {
	path, err := exec.LookPath("rustdesk")
	if err != nil {
		return ""
	}
	return path
}

var (
	rustDeskPasswordMu      sync.Mutex
	rustDeskAppliedPassword string
)

// ensureRustDesk applies the per-device password once per agent run, and
// again after a failure: a password the server sent while Remote Support was
// not installed yet, or its service was down, still reaches it.
func ensureRustDesk(cfg *Config, _ string) {
	password := strings.TrimSpace(cfg.RustDeskDefaultPassword)
	if password == "" || linuxRustDeskBinary() == "" {
		return
	}
	rustDeskPasswordMu.Lock()
	applied := rustDeskAppliedPassword == password
	rustDeskPasswordMu.Unlock()
	if !applied {
		applyRemoteSupportPassword(password)
	}
}

// applyRemoteSupportPassword sets the server-pushed per-device password on
// Remote Support.
func applyRemoteSupportPassword(password string) {
	password = strings.TrimSpace(password)
	bin := linuxRustDeskBinary()
	if password == "" || bin == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--password", password).CombinedOutput()
	if err := rustDeskPasswordResult(string(out), err); err != nil {
		log.Printf("[rustdesk_manage] apply per-device password failed: %v", err)
		return
	}
	rustDeskPasswordMu.Lock()
	rustDeskAppliedPassword = password
	rustDeskPasswordMu.Unlock()
	log.Printf("[rustdesk_manage] applied per-device password from server")
}

// rustDeskPasswordResult reads `rustdesk --password`: as root it hands the
// password to the running service over RustDesk's IPC and prints "Done!";
// anything else it prints is the reason it did not.
func rustDeskPasswordResult(output string, runErr error) error {
	text := strings.TrimSpace(output)
	if runErr != nil {
		return fmt.Errorf("rustdesk --password: %v (%s)", runErr, text)
	}
	if text != "" && !strings.Contains(text, "Done") {
		return fmt.Errorf("rustdesk --password: %s", text)
	}
	return nil
}
