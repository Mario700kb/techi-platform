//go:build !windows && !linux

package main

import "log"

// performSelfUpdate is a no-op on platforms without an updater.
func performSelfUpdate(update *AgentUpdate, _ updateReporter) {
	if update != nil {
		log.Printf("[self_update] skipped (Windows-only): v%s", update.Version)
	}
}
