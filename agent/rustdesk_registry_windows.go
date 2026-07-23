//go:build windows

package main

// In-process uninstall-registry reads for Remote Support MSI discovery.
//
// These replace the cross-platform reg.exe implementations (queryUninstallDisplayVersion
// / scanARPForRemoteSupportRegistration in rustdesk.go) on Windows. reg.exe text
// parsing -- especially `reg query /s /f "TECHI Remote Support" /d` -- proved
// unreliable in the field (it returned nothing even though the registration
// existed). Reading the registry directly via the Windows API is deterministic:
// no child process, no output parsing, no locale dependence.
//
// The branded MSI is perMachine + x64, so it registers under the 64-bit hive
// (`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{ProductCode}`); the
// WOW6432Node path covers any 32-bit registration. The agent is a 64-bit process,
// so reading both explicit paths sees both views without WOW64 redirection flags.

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

var remoteSupportUninstallRoots = []string{
	`SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
	`SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
}

func init() {
	// Swap the reg.exe seams for the robust in-process readers on Windows.
	uninstallDisplayVersionLookup = winRegDisplayVersionForProductCode
	arpRemoteSupportRegistrationScan = winRegScanRemoteSupportByDisplayName
}

// winRegDisplayVersionForProductCode returns the DisplayVersion for an exact
// ProductCode subkey, or "" if that ProductCode is not registered.
func winRegDisplayVersionForProductCode(productCode string) string {
	productCode = strings.TrimSpace(productCode)
	if productCode == "" {
		return ""
	}
	for _, root := range remoteSupportUninstallRoots {
		key, err := registry.OpenKey(registry.LOCAL_MACHINE, root+`\`+productCode, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		version, _, verr := key.GetStringValue("DisplayVersion")
		key.Close()
		if verr == nil {
			if v := strings.TrimSpace(version); v != "" {
				return v
			}
		}
	}
	return ""
}

// winRegScanRemoteSupportByDisplayName enumerates the uninstall subkeys and
// returns the first entry whose DisplayName is exactly "TECHI Remote Support",
// reading its DisplayVersion and ProductCode directly. ProductCode-independent:
// it discovers whatever ProductCode the currently installed MSI registered under.
func winRegScanRemoteSupportByDisplayName() remoteSupportMSIRegistration {
	for _, root := range remoteSupportUninstallRoots {
		parent, err := registry.OpenKey(registry.LOCAL_MACHINE, root, registry.ENUMERATE_SUB_KEYS)
		if err != nil {
			continue
		}
		subkeys, err := parent.ReadSubKeyNames(-1)
		parent.Close()
		if err != nil {
			continue
		}
		for _, sub := range subkeys {
			key, err := registry.OpenKey(registry.LOCAL_MACHINE, root+`\`+sub, registry.QUERY_VALUE)
			if err != nil {
				continue
			}
			name, _, nerr := key.GetStringValue("DisplayName")
			if nerr != nil || !strings.EqualFold(strings.TrimSpace(name), "TECHI Remote Support") {
				key.Close()
				continue
			}
			version, _, verr := key.GetStringValue("DisplayVersion")
			key.Close()
			if verr != nil {
				continue
			}
			if v := strings.TrimSpace(version); v != "" {
				return remoteSupportMSIRegistration{ProductCode: sub, Version: v}
			}
		}
	}
	return remoteSupportMSIRegistration{}
}
