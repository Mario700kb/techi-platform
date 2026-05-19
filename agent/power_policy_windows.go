//go:build windows

package main

import (
	"log"
	"time"
)

// applyPowerPolicy configures Windows power settings based on the availability profile.
//
// SAFETY INVARIANTS (never violated regardless of profile):
//   - Lock screen is NEVER disabled.
//   - User credentials are NEVER stored or cached by this function.
//   - Only powercfg AC power settings are modified.
//
// Profile behaviour:
//
//	server     — prevent AC sleep + disable hibernate (forced regardless of explicit flags)
//	workstation — respect explicit prevent_sleep_on_ac / prevent_hibernate flags
//	custom     — same as workstation; caller controls everything via flags
func applyPowerPolicy(cfg *Config) {
	if !cfg.ManagePowerPolicy {
		log.Printf("[power_policy] manage_power_policy=false — skipping")
		return
	}

	preventSleep := cfg.PreventSleepOnAC
	preventHibernate := cfg.PreventHibernate

	if cfg.AvailabilityProfile == "server" {
		preventSleep = true
		preventHibernate = true
	}

	log.Printf("[power_policy] profile=%q prevent_sleep_on_ac=%v prevent_hibernate=%v",
		cfg.AvailabilityProfile, preventSleep, preventHibernate)

	if preventSleep {
		if _, err := runWithTimeout(10*time.Second, "powercfg", "/change", "standby-timeout-ac", "0"); err != nil {
			log.Printf("[power_policy] disable AC sleep failed: %v", err)
		} else {
			log.Printf("[power_policy] AC standby disabled (timeout=0)")
		}
	}

	if preventHibernate {
		if _, err := runWithTimeout(10*time.Second, "powercfg", "/hibernate", "off"); err != nil {
			log.Printf("[power_policy] disable hibernate failed: %v", err)
		} else {
			log.Printf("[power_policy] hibernate disabled")
		}
	}
}
