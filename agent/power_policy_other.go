//go:build !windows

package main

import "log"

// applyPowerPolicy is a no-op on non-Windows platforms.
func applyPowerPolicy(cfg *Config) {
	if cfg.ManagePowerPolicy {
		log.Printf("[power_policy] Windows-only — no-op on this platform")
	}
}
