//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
)

const (
	rustDeskIdentityFile = "TECHI Remote Support.toml"
	rustDeskOptionsFile  = "TECHI Remote Support2.toml"
)

type rustDeskProfile struct {
	root    string
	service bool
}

// LocalSystem's systemprofile is authoritative for the SCM service. Existing
// ProgramData and interactive-user profiles are synchronized as mirrors so the
// service and every tray session resolve the same endpoint and credential.
func rustDeskProfiles() []rustDeskProfile {
	systemDrive := strings.TrimSpace(os.Getenv("SystemDrive"))
	if systemDrive == "" {
		systemDrive = `C:`
	}
	programData := strings.TrimSpace(os.Getenv("ProgramData"))
	if programData == "" {
		programData = systemDrive + `\ProgramData`
	}
	profiles := []rustDeskProfile{
		{root: filepath.Join(systemDrive+`\Windows\System32\config\systemprofile\AppData\Roaming`, "TECHI Remote Support"), service: true},
		{root: filepath.Join(programData, "TECHI Remote Support")},
		{root: filepath.Join(systemDrive+`\Windows\ServiceProfiles\LocalService\AppData\Roaming`, "TECHI Remote Support")},
		{root: filepath.Join(systemDrive+`\Windows\ServiceProfiles\NetworkService\AppData\Roaming`, "TECHI Remote Support")},
	}
	usersRoot := filepath.Join(systemDrive+`\`, "Users")
	if entries, err := os.ReadDir(usersRoot); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() || isSkippedWindowsProfile(entry.Name()) {
				continue
			}
			base := filepath.Join(usersRoot, entry.Name(), "AppData")
			profiles = append(profiles,
				rustDeskProfile{root: filepath.Join(base, "Roaming", "TECHI Remote Support")},
				rustDeskProfile{root: filepath.Join(base, "Local", "TECHI Remote Support")},
			)
		}
	}
	return profiles
}

func isSkippedWindowsProfile(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "public", "default", "default user", "all users":
		return true
	default:
		return false
	}
}

func rustDeskIdentityPaths() []string { return rustDeskProfileFilePaths(rustDeskIdentityFile) }
func rustDeskOptionsPaths() []string  { return rustDeskProfileFilePaths(rustDeskOptionsFile) }

func rustDeskProfileFilePaths(name string) []string {
	var paths []string
	seen := map[string]bool{}
	for _, profile := range rustDeskProfiles() {
		for _, path := range []string{
			filepath.Join(profile.root, name),
			filepath.Join(profile.root, "config", name),
		} {
			key := strings.ToLower(filepath.Clean(path))
			if !seen[key] {
				seen[key] = true
				paths = append(paths, path)
			}
		}
	}
	return paths
}

func authoritativeRustDeskOptionsPath() string {
	for _, profile := range rustDeskProfiles() {
		if profile.service {
			return filepath.Join(profile.root, "config", rustDeskOptionsFile)
		}
	}
	return ""
}
