package main

import (
	"fmt"
	"log"
	"strings"
)

// stripTOMLQuotes removes surrounding single or double quotes from a TOML value
// and trims whitespace. "value" and 'value' both become value.
func stripTOMLQuotes(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 {
		if (s[0] == '\'' && s[len(s)-1] == '\'') || (s[0] == '"' && s[len(s)-1] == '"') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// parseTOMLOptions extracts key→value pairs from the [options] section of a
// TOML string. Returned values have surrounding quotes stripped and whitespace
// trimmed so comparisons are quote-style and whitespace agnostic.
func parseTOMLOptions(content string) map[string]string {
	result := make(map[string]string)
	content = strings.ReplaceAll(content, "\r\n", "\n")
	inOptions := false
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			inOptions = trimmed == "[options]"
			continue
		}
		if !inOptions {
			continue
		}
		idx := strings.IndexByte(trimmed, '=')
		if idx < 0 {
			continue
		}
		k := strings.TrimSpace(trimmed[:idx])
		v := stripTOMLQuotes(strings.TrimSpace(trimmed[idx+1:]))
		result[k] = v
	}
	return result
}

// managedRustDeskOptions returns the non-empty managed key→value pairs from
// cfg. Only these keys are ever written or compared during config repair.
func managedRustDeskOptions(cfg *Config) map[string]string {
	m := make(map[string]string)
	if cfg.RustDeskRendezvousServer != "" {
		m["custom-rendezvous-server"] = cfg.RustDeskRendezvousServer
	}
	if cfg.RustDeskRelayServer != "" {
		m["relay-server"] = cfg.RustDeskRelayServer
	}
	if cfg.RustDeskAPIServer != "" {
		m["api-server"] = cfg.RustDeskAPIServer
	}
	if cfg.RustDeskKey != "" {
		m["key"] = cfg.RustDeskKey
	}
	// Always-on permission: lets operators connecting from our platform
	// adjust this device's Remote Support settings remotely, instead of
	// needing someone physically at the PC to flip it on first.
	m["enable-remote-config-modification"] = "Y"
	return m
}

// rustDeskConfigNeedsRepair returns true when the [options] section of content
// is missing a managed key or has an incorrect value. The comparison is
// quote-agnostic and whitespace-insensitive — only semantic value differences
// trigger a repair. Extra keys and all non-managed fields are ignored.
func rustDeskConfigNeedsRepair(content string, cfg *Config) bool {
	managed := managedRustDeskOptions(cfg)
	if len(managed) == 0 {
		return false
	}
	current := parseTOMLOptions(content)
	for key, want := range managed {
		got, exists := current[key]
		if !exists {
			log.Printf("[rustdesk_manage] needs repair: %s missing (want %q)", key, want)
			return true
		}
		if got != want {
			log.Printf("[rustdesk_manage] needs repair: %s current=%q want=%q", key, got, want)
			return true
		}
	}
	return false
}

// applyTOMLOptionPatch updates only managed keys in the [options] section of
// an existing TOML string. All other content — including identity fields such
// as enc_id, key_pair, key_confirmed, password, salt — is preserved verbatim.
//
// If managed keys are missing from the [options] section they are appended
// right after the section header. If there is no [options] section at all one
// is appended at the end of the file.
//
// Returns the updated content and whether any value was actually changed or
// added. Returns (content, false) when every managed key already matches.
func applyTOMLOptionPatch(content string, managed map[string]string) (string, bool) {
	if len(managed) == 0 {
		return content, false
	}
	content = strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Split(content, "\n")

	inOptions := false
	applied := make(map[string]bool)
	changed := false
	optionsSectionIdx := -1

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			inOptions = trimmed == "[options]"
			if inOptions {
				optionsSectionIdx = i
			}
			continue
		}
		if !inOptions || trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		idx := strings.IndexByte(trimmed, '=')
		if idx < 0 {
			continue
		}
		key := strings.TrimSpace(trimmed[:idx])
		newVal, isManaged := managed[key]
		if !isManaged {
			continue
		}
		oldVal := stripTOMLQuotes(strings.TrimSpace(trimmed[idx+1:]))
		applied[key] = true
		if oldVal == newVal {
			continue
		}
		log.Printf("[rustdesk_manage] patch [options] %s: %q → %q", key, oldVal, newVal)
		lines[i] = key + " = '" + newVal + "'"
		changed = true
	}

	// Append any managed keys absent from the existing [options] section.
	var toInsert []string
	for k, v := range managed {
		if !applied[k] && v != "" {
			log.Printf("[rustdesk_manage] patch [options] %s: adding %q", k, v)
			toInsert = append(toInsert, fmt.Sprintf("%s = '%s'", k, v))
			changed = true
		}
	}

	if len(toInsert) > 0 {
		if optionsSectionIdx >= 0 {
			// Insert right after the [options] header line.
			insertAt := optionsSectionIdx + 1
			updated := make([]string, 0, len(lines)+len(toInsert))
			updated = append(updated, lines[:insertAt]...)
			updated = append(updated, toInsert...)
			updated = append(updated, lines[insertAt:]...)
			lines = updated
		} else {
			// No [options] section found — append one.
			lines = append(lines, "", "[options]")
			lines = append(lines, toInsert...)
		}
	}

	return strings.Join(lines, "\n"), changed
}
