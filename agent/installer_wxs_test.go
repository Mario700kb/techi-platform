package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

var installerSources = []string{"installer/installer.wxs", "installer/remote-support.wxs", "installer/agent-update.wxs"}

func readWxs(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

// TestInstallerLockdownGrantIsFileSafe asserts that the MSI's recursive icacls
// lockdown never reintroduces container-only inheritance flags on the leaf
// config file. Applying (OI)(CI) to agent.config.json via /T is exactly what
// produced the empty deny-all DACL that stranded fresh installs before 2.1.20;
// the corrected form grants plain `F` (icacls applies (OI)(CI) to directories
// and `F` to files on its own).
func TestInstallerLockdownGrantIsFileSafe(t *testing.T) {
	wxs := readWxs(t, "installer/installer.wxs")

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

// TestCustomActionsReferenceOnlyDefinedProperties guards RISK-MSI-002. Custom
// action commands are MSI Formatted strings, where [Name] is a property
// reference and a {...} group holding an undefined one is dropped whole. A
// literal log tag like '[KillTechiRSBeforeInstall]' inside a PowerShell
// function body removed that body, so the script failed to parse and Remote
// Support was never stopped before InstallFiles, from 2.1.19 on.
func TestCustomActionsReferenceOnlyDefinedProperties(t *testing.T) {
	standard := map[string]bool{"AppDataFolder": true}
	definedRe := regexp.MustCompile(`<(?:Property|Directory|StandardDirectory|SetProperty|SetDirectory)\s[^>]*?Id="([^"]+)"`)
	attrRe := regexp.MustCompile(`(?:ExeCommand|Value)="([^"]*)"`)
	defineRe := regexp.MustCompile(`<\?define\s+\w+="([^"]*)"\?>`)
	refRe := regexp.MustCompile(`\[([^\[\]]+)\]`)
	for _, path := range installerSources {
		wxs := readWxs(t, path)
		defined := map[string]bool{}
		for _, m := range definedRe.FindAllStringSubmatch(wxs, -1) {
			defined[m[1]] = true
		}
		formatted := append(attrRe.FindAllStringSubmatch(wxs, -1), defineRe.FindAllStringSubmatch(wxs, -1)...)
		for _, attr := range formatted {
			for _, ref := range refRe.FindAllStringSubmatch(attr[1], -1) {
				name := ref[1]
				if strings.ContainsAny(name[:1], `\#!%~$`) || defined[name] || standard[name] {
					continue
				}
				t.Errorf("%s: [%s] is not a defined property; MSI formatting will blank it (and drop any {...} group around it)", path, name)
			}
		}
	}
}

// TestImmediateActionsRunFromAFolderThatExists: an immediate action runs
// before InstallFiles has created anything, so a working directory inside the
// product fails to launch with 1721. BackupAgentConfigBeforeLegacyRemove sat
// in TECHIDATADIR and never ran, which lost device_id on 1.0.4 migrations.
func TestImmediateActionsRunFromAFolderThatExists(t *testing.T) {
	actionRe := regexp.MustCompile(`(?s)<CustomAction\s[^>]*?/>`)
	dirRe := regexp.MustCompile(`Directory="([^"]+)"`)
	for _, path := range installerSources {
		for _, action := range actionRe.FindAllString(readWxs(t, path), -1) {
			dir := dirRe.FindStringSubmatch(action)
			if dir == nil || !strings.Contains(action, `Execute="immediate"`) {
				continue
			}
			if dir[1] != "SystemFolder" && dir[1] != "WindowsFolder" {
				t.Errorf("%s: immediate action runs in %s, which may not exist yet: %s", path, dir[1], strings.SplitN(action, "\n", 2)[0])
			}
		}
	}
}

// TestRemoteSupportReportsToThePlatformAPI: the fourth field of the
// EpCustomActDll parameters becomes the client's api-server. It is API_URL, so
// Remote Support reports every connection to /api/audit/conn (owner's decision
// 2026-10-16). Its own heartbeat and sysinfo to the same server, every ~15 s
// (RISK-SUPPLY-002), are answered by NPM and never reach the backend.
func TestRemoteSupportReportsToThePlatformAPI(t *testing.T) {
	paramRe := regexp.MustCompile(`(?s)Id="(WriteTechiConfigs|ApplyTechiRemoteSupportConfigFinal)\.SetParam".*?Value="([^"]*)"`)
	for _, path := range []string{"installer/installer.wxs", "installer/remote-support.wxs"} {
		matches := paramRe.FindAllStringSubmatch(readWxs(t, path), -1)
		if len(matches) != 2 {
			t.Fatalf("%s: want both EpCustomActDll parameter actions, found %d", path, len(matches))
		}
		for _, m := range matches {
			fields := strings.Split(m[2], "|")
			if len(fields) != 5 {
				t.Fatalf("%s %s: want 5 fields, got %q", path, m[1], m[2])
			}
			if fields[3] != "[API_URL]" {
				t.Errorf("%s %s: api-server field must be [API_URL], got %q", path, m[1], fields[3])
			}
		}
	}
}

// TestRemoteSupportStopsBeforeTheOldProductIsRemoved: the major upgrade removes
// the previous product right after InstallInitialize, and the previous
// product's own stop (KillTechiRS, 2.1.19-2.1.22) does nothing, so Remote
// Support must already be stopped by then. Nothing may sit between
// InstallInitialize and RemoveExistingProducts: Windows Installer refuses the
// package with 2613, which is how the first attempt at this failed in CI.
func TestRemoteSupportStopsBeforeTheOldProductIsRemoved(t *testing.T) {
	wxs := readWxs(t, "installer/installer.wxs")
	if !strings.Contains(wxs, `Schedule="afterInstallInitialize"`) {
		t.Fatal("MajorUpgrade schedule changed; revisit where Remote Support must stop")
	}
	if regexp.MustCompile(`<Custom [^>]*(Before="RemoveExistingProducts"|After="InstallInitialize")`).MatchString(wxs) {
		t.Fatal("no action may be sequenced between InstallInitialize and RemoveExistingProducts (Error 2613)")
	}
	if !regexp.MustCompile(`(?s)<CustomAction Id="StopTechiRSBeforeUpgrade"[^>]*Execute="immediate"`).MatchString(wxs) {
		t.Fatal("StopTechiRSBeforeUpgrade must be an immediate action")
	}
	if !strings.Contains(wxs, `<Custom Action="StopTechiRSBeforeUpgrade" After="CleanupLegacyEndpointInstallerRegistry" Condition="NOT REMOVE AND WIX_UPGRADE_DETECTED"/>`) {
		t.Fatal("StopTechiRSBeforeUpgrade must run before InstallValidate, after the legacy cleanup, and only when an older product is there")
	}
	for _, id := range []string{"KillTechiRS", "KillTechiRSBeforeInstall", "StopTechiRSBeforeUpgrade"} {
		re := regexp.MustCompile(`(?s)<CustomAction Id="` + id + `"[^>]*ExeCommand="[^"]*\$\(var\.StopRemoteSupportScript\)`)
		if !re.MatchString(wxs) {
			t.Errorf("%s must run the shared StopRemoteSupportScript", id)
		}
	}
}
