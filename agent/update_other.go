//go:build !windows

package main

import "log"

// performSelfUpdate is a no-op on non-Windows platforms.
func performSelfUpdate(update *AgentUpdate) {
	if update != nil {
		log.Printf("[self_update] skipped (Windows-only): v%s", update.Version)
	}
}
