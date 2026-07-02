package main

import (
	"log"
	"os"
)

// setTomlReadOnly marks a RustDesk TOML config file read-only so that when
// the "TECHI Remote Support" Windows Service restarts it cannot overwrite the
// managed [options] keys (custom-rendezvous-server, relay-server, key, etc.).
//
// The protection is active during the long idle window between agent heartbeats
// (up to HeartbeatSeconds).  Every write path in rustdesk_manage.go calls
// removeTomlReadOnly immediately before os.WriteFile and setTomlReadOnly
// immediately after, so the file is writable only for the instant the agent
// itself is patching it.
//
// Errors are logged but never propagated -- a chmod failure must not stop the
// repair or crash the heartbeat loop.
func setTomlReadOnly(path string) {
	if err := os.Chmod(path, 0444); err != nil {
		log.Printf("[rustdesk_manage] setReadOnly %s: %v", path, err)
	}
}

// removeTomlReadOnly clears the read-only attribute set by setTomlReadOnly so
// the agent can patch the file.  Must be called immediately before any
// os.WriteFile call on a managed TOML path; setTomlReadOnly must follow
// immediately after the write succeeds or fails.
func removeTomlReadOnly(path string) {
	if err := os.Chmod(path, 0644); err != nil {
		log.Printf("[rustdesk_manage] removeReadOnly %s: %v", path, err)
	}
}
