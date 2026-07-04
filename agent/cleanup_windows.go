//go:build windows

package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// cacheCleanupMinAge protects anything recent: an MSI downloaded for an
// in-flight deploy or an exe waiting on a scheduled swap is always newer
// than this. Only stale leftovers from previous versions are removed.
const cacheCleanupMinAge = 24 * time.Hour

// cleanupAgentCaches removes stale downloaded artifacts from
// %ProgramData%\TechiAgent\cache:
//   - TECHI-Remote-Support-*.msi from package versions other than the one
//     currently configured (~25 MB each, one left behind per RS release)
//   - techi-agent-*.exe self-update downloads for versions other than the
//     running one (~10 MB each, left behind after every successful swap)
//   - *.download partials from interrupted downloads
//
// Runs once at service start; failures are logged and never block the agent.
func cleanupAgentCaches(cfg *Config) {
	cachePath, err := cachedMSIPath(cfg)
	if err != nil {
		log.Printf("[cache_cleanup] cache dir unavailable: %v", err)
		return
	}
	cacheDir := filepath.Dir(cachePath)
	keepMSI := strings.ToLower(filepath.Base(cachePath))
	keepExe := strings.ToLower(filepath.Base(agentBinaryCachePath(AgentVersion)))

	entries, err := os.ReadDir(cacheDir)
	if err != nil {
		return
	}
	now := time.Now()
	removed := 0
	var freed int64
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := strings.ToLower(entry.Name())
		var stale bool
		switch {
		case strings.HasSuffix(name, ".download"):
			stale = true
		case strings.HasPrefix(name, "techi-remote-support-") && strings.HasSuffix(name, ".msi"):
			stale = name != keepMSI
		case strings.HasPrefix(name, "techi-agent-") && strings.HasSuffix(name, ".exe"):
			stale = name != keepExe
		}
		if !stale {
			continue
		}
		info, err := entry.Info()
		if err != nil || now.Sub(info.ModTime()) < cacheCleanupMinAge {
			continue
		}
		path := filepath.Join(cacheDir, entry.Name())
		if err := os.Remove(path); err != nil {
			// A locked file (e.g. an exe mid-swap) simply stays for next time.
			log.Printf("[cache_cleanup] could not remove %s: %v", path, err)
			continue
		}
		removed++
		freed += info.Size()
	}
	if removed > 0 {
		log.Printf("[cache_cleanup] removed %d stale cache file(s), freed %.1f MB", removed, float64(freed)/(1024*1024))
	}
}
