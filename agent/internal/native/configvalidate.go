package native

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

const maxPreservedConfigBytes = 2 << 20

type configRecoveryDecision struct {
	preserve bool
	identity string
	fresh    []byte
}

func validatePreservableConfig(path string, data []byte) (string, error) {
	if strings.EqualFold(filepathBase(path), "agent.config.json") {
		return "", validateAgentConfigJSON(data)
	}
	return validatePreservableTOML(data)
}

func filepathBase(path string) string {
	path = strings.ReplaceAll(path, `\`, "/")
	if index := strings.LastIndex(path, "/"); index >= 0 {
		return path[index+1:]
	}
	return path
}

func isRemoteSupportConfigPath(path string) bool {
	return !strings.EqualFold(filepathBase(path), "agent.config.json")
}

func validateAgentConfigJSON(data []byte) error {
	if len(data) == 0 || len(data) > maxPreservedConfigBytes || bytes.IndexByte(data, 0) >= 0 {
		return fmt.Errorf("agent config size/content outside allowed range")
	}
	var config map[string]interface{}
	if err := json.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("invalid agent config JSON: %w", err)
	}
	if config == nil {
		return fmt.Errorf("agent config must be an object")
	}
	return nil
}

// validatePreservableTOML is deliberately narrow: preserved files must look
// like data, never executable/script content. It returns the top-level Remote
// ID for cross-profile conflict detection without logging any credential.
func validatePreservableTOML(data []byte) (string, error) {
	if len(data) == 0 || len(data) > maxPreservedConfigBytes {
		return "", fmt.Errorf("config size outside allowed range")
	}
	if bytes.IndexByte(data, 0) >= 0 || bytes.HasPrefix(data, []byte("MZ")) || bytes.HasPrefix(data, []byte("#!")) {
		return "", fmt.Errorf("executable or script content rejected")
	}
	lower := strings.ToLower(string(data))
	for _, marker := range []string{"<script", "powershell.exe", "cmd.exe /c", "wscript.shell"} {
		if strings.Contains(lower, marker) {
			return "", fmt.Errorf("script marker rejected")
		}
	}

	inSection := false
	keys := 0
	identity := ""
	encodedIdentity := ""
	for _, line := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			inSection = true
			continue
		}
		idx := strings.IndexByte(trimmed, '=')
		if idx <= 0 {
			return "", fmt.Errorf("invalid TOML assignment")
		}
		value := tomlValueWithoutComment(strings.TrimSpace(trimmed[idx+1:]))
		if value == "" || !tomlAssignmentComplete(value) {
			return "", fmt.Errorf("invalid TOML value")
		}
		keys++
		if !inSection {
			key := strings.TrimSpace(trimmed[:idx])
			value := strings.Trim(value, `"'`)
			if key == "id" {
				identity = value
			} else if key == "enc_id" {
				encodedIdentity = value
			}
		}
	}
	if keys == 0 {
		return "", fmt.Errorf("config contains no assignments")
	}
	if identity == "" {
		identity = encodedIdentity
	}
	return identity, nil
}

func prepareConfigForRecovery(path string, data []byte) configRecoveryDecision {
	if identity, err := validatePreservableConfig(path, data); err == nil {
		return configRecoveryDecision{preserve: true, identity: identity}
	}
	return configRecoveryDecision{fresh: freshRemoteSupportConfig(path, data)}
}

func freshRemoteSupportConfig(path string, corrupt []byte) []byte {
	var lines []string
	if isRemoteSupportIdentityConfig(path) {
		for _, recovered := range recoverSafeIdentityAssignments(corrupt) {
			candidate := append(append([]string(nil), lines...), recovered, "serial = 0")
			if _, err := validatePreservableTOML([]byte(strings.Join(candidate, "\n") + "\n")); err == nil {
				lines = append(lines, recovered)
			}
		}
	}
	lines = append(lines, "serial = 0")
	return []byte(strings.Join(lines, "\n") + "\n")
}

func isRemoteSupportIdentityConfig(path string) bool {
	switch strings.ToLower(filepathBase(path)) {
	case "techi remote support.toml", "rustdesk.toml":
		return true
	default:
		return false
	}
}

func recoverSafeIdentityAssignments(data []byte) []string {
	wanted := []string{"id", "enc_id", "password", "salt", "key_pair", "key_confirmed"}
	allowed := make(map[string]bool, len(wanted))
	for _, key := range wanted {
		allowed[key] = true
	}
	found := map[string]string{}
	duplicate := map[string]bool{}
	for _, line := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			break
		}
		idx := strings.IndexByte(trimmed, '=')
		if idx <= 0 {
			continue
		}
		key := strings.TrimSpace(trimmed[:idx])
		value := tomlValueWithoutComment(strings.TrimSpace(trimmed[idx+1:]))
		if !allowed[key] || !safeIdentityValue(key, value) {
			continue
		}
		if _, exists := found[key]; exists {
			duplicate[key] = true
			continue
		}
		found[key] = key + " = " + value
	}
	result := make([]string, 0, len(found))
	for _, key := range wanted {
		if line := found[key]; line != "" && !duplicate[key] {
			result = append(result, line)
		}
	}
	return result
}

func safeIdentityValue(key, value string) bool {
	value = tomlValueWithoutComment(strings.TrimSpace(value))
	switch key {
	case "id", "enc_id", "password", "salt":
		return len(value) >= 2 && (value[0] == '\'' || value[0] == '"') &&
			value[len(value)-1] == value[0] && tomlAssignmentComplete(value)
	case "key_pair":
		return len(value) >= 2 && value[0] == '[' && value[len(value)-1] == ']' && tomlAssignmentComplete(value)
	case "key_confirmed":
		return value == "true" || value == "false"
	default:
		return false
	}
}

func tomlValueWithoutComment(value string) string {
	quote := byte(0)
	escaped := false
	for i := 0; i < len(value); i++ {
		c := value[i]
		if quote != 0 {
			if quote == '"' && c == '\\' && !escaped {
				escaped = true
				continue
			}
			if c == quote && !escaped {
				quote = 0
			}
			escaped = false
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			continue
		}
		if c == '#' {
			return strings.TrimSpace(value[:i])
		}
	}
	return strings.TrimSpace(value)
}

func tomlAssignmentComplete(value string) bool {
	value = tomlValueWithoutComment(value)
	if value == "" {
		return false
	}
	quote := byte(0)
	escaped := false
	squareDepth := 0
	curlyDepth := 0
	for i := 0; i < len(value); i++ {
		c := value[i]
		if quote != 0 {
			if quote == '"' && c == '\\' && !escaped {
				escaped = true
				continue
			}
			if c == quote && !escaped {
				quote = 0
			}
			escaped = false
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			continue
		}
		switch c {
		case '[':
			squareDepth++
		case ']':
			squareDepth--
		case '{':
			curlyDepth++
		case '}':
			curlyDepth--
		}
		if squareDepth < 0 || curlyDepth < 0 {
			return false
		}
	}
	return quote == 0 && squareDepth == 0 && curlyDepth == 0
}

func corruptConfigBackupPath(path string, now time.Time) string {
	return path + "." + now.UTC().Format("20060102T150405.000000000Z") + ".corrupt"
}

func quarantineCorruptConfig(path string, now time.Time) (string, error) {
	backup := corruptConfigBackupPath(path, now)
	if _, err := os.Lstat(backup); err == nil {
		return "", fmt.Errorf("corrupt config backup already exists: %s", backup)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.Rename(path, backup); err != nil {
		return "", err
	}
	return backup, nil
}
