//go:build windows

package main

import (
	"log"
	"path/filepath"
	"time"
)

// lockdownConfigACL restricts path to SYSTEM + Administrators only (by SID,
// locale-independent), since the config file contains plaintext secrets
// (agent_credential, enrollment_token, rustdesk_key,
// rustdesk_default_password) and Go's
// os.WriteFile permission bits are ignored entirely on Windows.
func lockdownConfigACL(path string) {
	out, err := runWithTimeout(10*time.Second, "icacls.exe", path,
		"/inheritance:r",
		"/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F",
	)
	if err != nil {
		log.Printf("[config] icacls lockdown failed for %s: %v (%s)", path, err, string(out))
	}
}

func repairCanonicalAgentACL(configPath string) {
	if configPath != windowsConfigPath {
		return
	}
	dir := filepath.Dir(configPath)
	out, err := runWithTimeout(15*time.Second, "icacls.exe", dir,
		"/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/T", "/C", "/Q")
	if err != nil {
		log.Printf("[config] canonical ACL self-heal failed: %v (%s)", err, string(out))
		return
	}
	log.Printf("[config] canonical ACL self-heal applied path=%s", dir)
}
