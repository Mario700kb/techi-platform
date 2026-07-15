package native

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

const maxPreservedConfigBytes = 2 << 20

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
		keys++
		if !inSection {
			key := strings.TrimSpace(trimmed[:idx])
			value := strings.Trim(strings.TrimSpace(trimmed[idx+1:]), `"'`)
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
