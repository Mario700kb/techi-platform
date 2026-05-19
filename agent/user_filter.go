package main

import "strings"

// isMachineAccount reports whether name is a Windows machine or built-in service
// account that should never be shown as the interactive user.
// Machine accounts end with '$'; NT AUTHORITY / BUILTIN prefixes are service identities.
func isMachineAccount(name string) bool {
	if name == "" {
		return true
	}
	if strings.HasSuffix(name, "$") {
		return true
	}
	upper := strings.ToUpper(name)
	if strings.HasPrefix(upper, "NT AUTHORITY\\") {
		return true
	}
	if strings.HasPrefix(upper, "BUILTIN\\") {
		return true
	}
	return false
}

// normalizeLogonUIValue cleans a raw value from the Windows LogonUI registry key.
// Returns "" when the value represents a machine or service account.
// Strips the ".\" prefix that Windows stores for local (non-domain) accounts.
func normalizeLogonUIValue(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, `.\`) {
		raw = raw[2:]
	}
	raw = strings.TrimSpace(raw)
	if isMachineAccount(raw) {
		return ""
	}
	return raw
}
