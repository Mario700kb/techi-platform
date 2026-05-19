//go:build !windows

package main

import "log"

// ensureRustDesk is a no-op on non-Windows platforms.
func ensureRustDesk(cfg *Config, _ string) {
	if cfg.RustDeskManageEnabled {
		log.Printf("[rustdesk_manage] Windows-only — no-op on this platform")
	}
}
