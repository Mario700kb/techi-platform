//go:build windows

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"

	"techi-platform/agent/internal/native"
)

func loadCanonicalRustDeskIdentity() (rustDeskCanonicalIdentity, error) {
	var candidates []rustDeskIdentityCandidate
	for _, profile := range rustDeskProfiles() {
		if profile.role != rustDeskProfileUser {
			continue
		}
		for _, path := range []string{
			filepath.Join(profile.root, rustDeskIdentityFile),
			filepath.Join(profile.root, "config", rustDeskIdentityFile),
		} {
			data, err := os.ReadFile(path)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return rustDeskCanonicalIdentity{}, fmt.Errorf("read user identity %s: %w", path, err)
			}
			prepared, err := native.PrepareMinimalRemoteSupportConfig(path, data)
			if err != nil {
				return rustDeskCanonicalIdentity{}, fmt.Errorf("prepare user identity %s: %w", path, err)
			}
			candidates = append(candidates, rustDeskIdentityCandidate{
				path: path, profileRoot: profile.root, content: prepared.Content,
				valid: prepared.OriginalValid, userProfile: true, activeUser: profile.active,
			})
		}
	}
	canonical, err := selectCanonicalRustDeskIdentity(candidates)
	if err != nil {
		return rustDeskCanonicalIdentity{}, err
	}
	return canonical, nil
}

func remoteSupportUsesSystemProfile() (bool, error) {
	manager, err := mgr.Connect()
	if err != nil {
		return false, fmt.Errorf("connect to Service Control Manager: %w", err)
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(rustdeskServiceName)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("open service %q: %w", rustdeskServiceName, err)
	}
	defer service.Close()
	config, err := service.Config()
	if err != nil {
		return false, fmt.Errorf("query service %q config: %w", rustdeskServiceName, err)
	}
	account := strings.ToLower(strings.TrimSpace(config.ServiceStartName))
	return account == "" || account == "localsystem" || account == `nt authority\system` || account == `.\localsystem`, nil
}

func requiredRustDeskProfiles(canonical rustDeskCanonicalIdentity) ([]rustDeskProfile, error) {
	profiles := rustDeskProfiles()
	systemUsed, err := remoteSupportUsesSystemProfile()
	if err != nil {
		return nil, err
	}
	contracts := make([]rustDeskSyncProfile, 0, len(profiles))
	byRoot := make(map[string]rustDeskProfile, len(profiles))
	for _, profile := range profiles {
		contracts = append(contracts, rustDeskSyncProfile{root: profile.root, role: profile.role, active: profile.active})
		byRoot[strings.ToLower(filepath.Clean(profile.root))] = profile
	}
	roots := requiredRustDeskSyncRoots(contracts, canonical.sourceRoot, systemUsed)
	required := make([]rustDeskProfile, 0, len(roots))
	for _, root := range roots {
		profile, exists := byRoot[strings.ToLower(filepath.Clean(root))]
		if !exists {
			return nil, fmt.Errorf("required Remote Support profile disappeared: %s", root)
		}
		required = append(required, profile)
	}
	return required, nil
}

func rustDeskProfileTargets(root, name string) []string {
	targets := []string{filepath.Join(root, "config", name)}
	rootPath := filepath.Join(root, name)
	if _, err := os.Stat(rootPath); err == nil {
		targets = append(targets, rootPath)
	}
	return targets
}

func synchronizeCanonicalRustDeskConfig(cfg *Config, canonical rustDeskCanonicalIdentity, freshOptions bool) (bool, error) {
	profiles, err := requiredRustDeskProfiles(canonical)
	if err != nil {
		return false, err
	}
	updates := []rustDeskFileUpdate{}
	seen := map[string]bool{}
	appendUpdate := func(path string, content []byte, defaultMode os.FileMode) error {
		key := strings.ToLower(filepath.Clean(path))
		if seen[key] {
			return nil
		}
		seen[key] = true
		before, readErr := os.ReadFile(path)
		existed := readErr == nil
		if readErr != nil && !os.IsNotExist(readErr) {
			return fmt.Errorf("read config %s: %w", path, readErr)
		}
		if existed && bytes.Equal(before, content) {
			return nil
		}
		mode := defaultMode
		if info, statErr := os.Stat(path); statErr == nil {
			mode = info.Mode().Perm()
		}
		updates = append(updates, rustDeskFileUpdate{
			path: path, before: before, after: bytes.Clone(content), mode: mode, existed: existed, protect: true,
		})
		return nil
	}

	for _, profile := range profiles {
		for _, path := range rustDeskProfileTargets(profile.root, rustDeskIdentityFile) {
			if err := appendUpdate(path, canonical.content, 0o600); err != nil {
				return false, err
			}
		}
		for _, path := range rustDeskProfileTargets(profile.root, rustDeskOptionsFile) {
			options := []byte(buildRustDeskTOML(cfg))
			if !freshOptions {
				if existing, readErr := os.ReadFile(path); readErr == nil {
					patched, _ := applyTOMLOptionPatch(string(existing), managedRustDeskOptions(cfg))
					options = []byte(patched)
				} else if !os.IsNotExist(readErr) {
					return false, fmt.Errorf("read options %s: %w", path, readErr)
				}
			}
			if err := appendUpdate(path, options, 0o644); err != nil {
				return false, err
			}
		}
	}
	if len(updates) == 0 {
		return false, nil
	}
	if err := applyRustDeskFileUpdates(updates); err != nil {
		return false, err
	}
	for _, update := range updates {
		written, readErr := os.ReadFile(update.path)
		if readErr != nil {
			rollbackRustDeskFileUpdates(updates)
			return false, fmt.Errorf("verify config %s: %w", update.path, readErr)
		}
		if strings.EqualFold(filepath.Base(update.path), rustDeskIdentityFile) && !rustDeskIdentityMatches(written, canonical) {
			rollbackRustDeskFileUpdates(updates)
			return false, fmt.Errorf("identity verification failed for %s", update.path)
		}
		if strings.EqualFold(filepath.Base(update.path), rustDeskOptionsFile) && rustDeskConfigNeedsRepair(string(written), cfg) {
			rollbackRustDeskFileUpdates(updates)
			return false, fmt.Errorf("options verification failed for %s", update.path)
		}
	}
	return true, nil
}

func validateCanonicalRustDeskIdentity(cfg *Config, canonical rustDeskCanonicalIdentity) error {
	profiles, err := requiredRustDeskProfiles(canonical)
	if err != nil {
		return err
	}
	for _, profile := range profiles {
		for _, path := range rustDeskProfileTargets(profile.root, rustDeskIdentityFile) {
			content, readErr := os.ReadFile(path)
			if readErr != nil {
				return fmt.Errorf("identity_mismatch: read synchronized identity %s: %w", path, readErr)
			}
			if !rustDeskIdentityMatches(content, canonical) {
				return fmt.Errorf("identity_mismatch: profile identity differs at %s", path)
			}
		}
	}
	uiID := canonical.id
	if uiID == "" {
		uiID = configuredRustDeskID(cfg)
	}
	return validateRustDeskIdentityIDs(uiID, localRustDeskIDFromCLI(rustdeskDefaultInstallPath))
}
