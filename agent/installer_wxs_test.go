package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestInstallerLockdownGrantIsFileSafe asserts that the MSI's recursive icacls
// lockdown never reintroduces container-only inheritance flags on the leaf
// config file. Applying (OI)(CI) to agent.config.json via /T is exactly what
// produced the empty deny-all DACL that stranded fresh installs before 2.1.20;
// the corrected form grants plain `F` (icacls applies (OI)(CI) to directories
// and `F` to files on its own).
func TestInstallerLockdownGrantIsFileSafe(t *testing.T) {
	data, err := os.ReadFile("installer/installer.wxs")
	if err != nil {
		t.Fatalf("read installer.wxs: %v", err)
	}
	wxs := string(data)

	// Isolate the LockdownTechiDataDir custom action's ExeCommand.
	re := regexp.MustCompile(`(?s)Id="LockdownTechiDataDir".*?ExeCommand="([^"]*)"`)
	m := re.FindStringSubmatch(wxs)
	if m == nil {
		t.Fatal("LockdownTechiDataDir custom action or its ExeCommand not found")
	}
	cmd := m[1]

	if strings.Contains(cmd, "(OI)") || strings.Contains(cmd, "(CI)") {
		t.Fatalf("LockdownTechiDataDir must not use container inheritance flags on a recursive leaf-file grant: %q", cmd)
	}
	for _, want := range []string{
		"/inheritance:r",
		"*S-1-5-18:F",
		"*S-1-5-32-544:F",
		"/T",
	} {
		if !strings.Contains(cmd, want) {
			t.Fatalf("LockdownTechiDataDir command %q missing %q", cmd, want)
		}
	}

	// Guard against broad principals anywhere in the lockdown command.
	for _, forbidden := range []string{"Everyone", "Users", "Authenticated", "*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"} {
		if strings.Contains(cmd, forbidden) {
			t.Fatalf("LockdownTechiDataDir command must not grant broad principal %q: %q", forbidden, cmd)
		}
	}
}
