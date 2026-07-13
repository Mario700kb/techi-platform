//go:build windows

package native

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var requiredPreserveRoots = []string{
	`C:\ProgramData\TechiAgent\agent.config.json`,
	`C:\ProgramData\TECHI Remote Support`,
	`C:\Windows\System32\config\systemprofile\AppData\Roaming\TECHI Remote Support`,
	`C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\TECHI Remote Support`,
	`C:\Windows\ServiceProfiles\NetworkService\AppData\Roaming\TECHI Remote Support`,
	`C:\Users\*\AppData\Roaming\TECHI Remote Support`,
	`C:\Users\*\AppData\Local\TECHI Remote Support`,
}

// ResolveManifestConfigPaths validates and consumes the manifest preservation
// contract, expanding only the one approved user-profile wildcard.
func ResolveManifestConfigPaths(m *BundleManifest) ([]string, error) {
	if m == nil {
		return nil, fmt.Errorf("manifest is required for config path resolution")
	}
	declared := map[string]bool{}
	allowed := map[string]bool{}
	for _, required := range requiredPreserveRoots {
		allowed[normalizeWindowsPath(required)] = true
	}
	for _, root := range m.ConfigPathsToPreserve {
		normalized := normalizeWindowsPath(root)
		if !allowed[normalized] {
			return nil, fmt.Errorf("manifest contains unapproved preservation root: %s", root)
		}
		declared[normalized] = true
	}
	for _, required := range requiredPreserveRoots {
		if !declared[normalizeWindowsPath(required)] {
			return nil, fmt.Errorf("manifest omits required preservation root: %s", required)
		}
	}
	if !manifestProtectsTOML(m.NeverOverwrite) {
		return nil, fmt.Errorf("manifest never_overwrite_paths does not protect TOML files")
	}

	var roots []string
	for _, root := range requiredPreserveRoots {
		if strings.EqualFold(filepath.Base(root), "agent.config.json") {
			if info, err := os.Lstat(root); err == nil && info.Mode().IsRegular() {
				if err := validateApprovedConfigPath(root); err != nil {
					return nil, err
				}
				roots = append(roots, root)
			}
			continue
		}
		if !strings.Contains(root, `\*\`) {
			roots = append(roots, root)
			continue
		}
		entries, err := os.ReadDir(`C:\Users`)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || skippedWindowsProfile(entry.Name()) {
				continue
			}
			roots = append(roots, strings.Replace(root, `\*\`, `\`+entry.Name()+`\`, 1))
		}
	}

	var out []string
	seen := map[string]bool{}
	for _, root := range roots {
		if strings.EqualFold(filepath.Base(root), "agent.config.json") {
			key := normalizeWindowsPath(root)
			if !seen[key] {
				seen[key] = true
				out = append(out, root)
			}
			continue
		}
		for _, dir := range []string{root, filepath.Join(root, "config")} {
			for name := range approvedConfigNames {
				if name == "agent.config.json" {
					continue
				}
				candidate := filepath.Join(dir, name)
				info, err := os.Lstat(candidate)
				if err != nil {
					continue
				}
				if !info.Mode().IsRegular() {
					return nil, fmt.Errorf("preserve candidate is not regular: %s", candidate)
				}
				if err := validateApprovedConfigPath(candidate); err != nil {
					return nil, err
				}
				key := normalizeWindowsPath(candidate)
				if !seen[key] {
					seen[key] = true
					out = append(out, candidate)
				}
			}
		}
	}
	return out, nil
}

func manifestProtectsTOML(patterns []string) bool {
	for _, pattern := range patterns {
		if strings.EqualFold(strings.TrimSpace(pattern), "*.toml") {
			return true
		}
	}
	return false
}

func normalizeWindowsPath(value string) string {
	return strings.ToLower(strings.TrimRight(strings.ReplaceAll(strings.TrimSpace(value), "/", `\`), `\`))
}

func skippedWindowsProfile(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "public", "default", "default user", "all users":
		return true
	default:
		return false
	}
}
