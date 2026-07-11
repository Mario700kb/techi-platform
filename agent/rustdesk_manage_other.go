//go:build !windows

package main

import "log"

// ensureRustDesk is a no-op on non-Windows platforms.
func ensureRustDesk(cfg *Config, _ string) {
	if cfg.RustDeskManageEnabled {
		log.Printf("[rustdesk_manage] Windows-only — no-op on this platform")
	}
}

func verifyRustDeskSync(_ *Config, info RustDeskInfo) string {
	if info.InstallStatus != "installed" {
		return "not_installed"
	}
	return "discovered"
}

// applyRemoteSupportPassword is a no-op on non-Windows platforms.
func applyRemoteSupportPassword(_ string) {}
