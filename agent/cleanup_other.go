//go:build !windows

package main

// cleanupAgentCaches is a no-op on non-Windows platforms — the download
// caches it prunes only exist on Windows installs.
func cleanupAgentCaches(_ *Config) {}
