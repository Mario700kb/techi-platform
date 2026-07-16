package main

import (
	"bytes"
	"fmt"
	"path/filepath"
	"strings"
)

const (
	rustDeskProfileUser         = "user"
	rustDeskProfileLocalService = "local_service"
	rustDeskProfileSystem       = "system"
)

type rustDeskIdentityCandidate struct {
	path        string
	profileRoot string
	content     []byte
	valid       bool
	userProfile bool
	activeUser  bool
}

type rustDeskCanonicalIdentity struct {
	sourcePath string
	sourceRoot string
	content    []byte
	id         string
	encID      string
}

type rustDeskSyncProfile struct {
	root   string
	role   string
	active bool
}

func selectCanonicalRustDeskIdentity(candidates []rustDeskIdentityCandidate) (rustDeskCanonicalIdentity, error) {
	bestScore := -1
	var selected rustDeskCanonicalIdentity
	for _, candidate := range candidates {
		if !candidate.valid || !candidate.userProfile {
			continue
		}
		fields := parseTOMLTopLevel(string(candidate.content))
		id := normalizeRustDeskID(fields["id"])
		encID := strings.TrimSpace(fields["enc_id"])
		if (!isNumericRustDeskID(id) && encID == "") || strings.TrimSpace(fields["password"]) == "" || strings.TrimSpace(fields["salt"]) == "" {
			continue
		}
		score := 0
		if candidate.activeUser {
			score += 100
		}
		candidatePath := strings.ReplaceAll(candidate.path, `\`, "/")
		if strings.EqualFold(filepath.Base(filepath.Dir(candidatePath)), "config") {
			score += 10
		}
		if strings.TrimSpace(fields["enc_id"]) != "" {
			score++
		}
		if score < bestScore {
			continue
		}
		identityKey := id
		if identityKey == "" {
			identityKey = encID
		}
		selectedKey := selected.id
		if selectedKey == "" {
			selectedKey = selected.encID
		}
		if score == bestScore && selectedKey != "" && selectedKey != identityKey {
			return rustDeskCanonicalIdentity{}, fmt.Errorf("conflicting verified user identities")
		}
		bestScore = score
		selected = rustDeskCanonicalIdentity{
			sourcePath: candidate.path,
			sourceRoot: candidate.profileRoot,
			content:    bytes.Clone(candidate.content),
			id:         id,
			encID:      encID,
		}
	}
	if bestScore < 0 {
		return rustDeskCanonicalIdentity{}, fmt.Errorf("no verified user Remote Support identity with ID/enc_id, password, and salt")
	}
	return selected, nil
}

func hasProtectedRustDeskCredential(content string) bool {
	fields := parseTOMLTopLevel(content)
	return strings.TrimSpace(fields["password"]) != "" && strings.TrimSpace(fields["salt"]) != ""
}

func materializeRustDeskRepairIdentity(content []byte, configuredID string) ([]byte, string, error) {
	fields := parseTOMLTopLevel(string(content))
	id := normalizeRustDeskID(fields["id"])
	plaintextID := isNumericRustDeskID(id)
	cryptoComplete := hasUsableRustDeskKeyMaterial(fields)
	if !plaintextID {
		if strings.TrimSpace(fields["enc_id"]) == "" {
			return nil, "", fmt.Errorf("required identity field mismatch: field=id/enc_id")
		}
		if !cryptoComplete {
			return nil, "", fmt.Errorf("encrypted identity requires complete key_pair/key_confirmed material")
		}
		id = normalizeRustDeskID(configuredID)
		if !isNumericRustDeskID(id) {
			return nil, "", fmt.Errorf("canonical UI ID unavailable for encrypted identity")
		}
	}
	for _, field := range []string{"password", "salt"} {
		if strings.TrimSpace(fields[field]) == "" {
			return nil, "", fmt.Errorf("required identity field mismatch: field=%s", field)
		}
	}
	patched, _ := applyTOMLTopLevelPatch(string(content), "id", id)
	patched, _ = applyTOMLTopLevelPatch(patched, "enc_id", "")
	if !cryptoComplete {
		patched = removeRustDeskKeyMaterial(patched)
	}
	return []byte(patched), id, nil
}

func hasUsableRustDeskKeyMaterial(fields map[string]string) bool {
	keyPair := strings.TrimSpace(fields["key_pair"])
	keyConfirmed := strings.TrimSpace(fields["key_confirmed"])
	return len(keyPair) > 2 && strings.HasPrefix(keyPair, "[") && strings.HasSuffix(keyPair, "]") &&
		(keyConfirmed == "true" || keyConfirmed == "false")
}

func removeRustDeskKeyMaterial(content string) string {
	remove := map[string]bool{"key_pair": true, "key_confirmed": true, "keys_confirmed": true}
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	kept := lines[:0]
	inSection := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			inSection = true
		}
		if !inSection {
			if idx := strings.IndexByte(trimmed, '='); idx > 0 && remove[strings.TrimSpace(trimmed[:idx])] {
				continue
			}
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

func rustDeskRepairRuntimeIdentityMismatchField(content []byte, canonical rustDeskCanonicalIdentity) string {
	want := parseTOMLTopLevel(string(canonical.content))
	got := parseTOMLTopLevel(string(content))
	for _, key := range []string{"password", "salt", "key_pair", "key_confirmed", "keys_confirmed"} {
		expected := strings.TrimSpace(want[key])
		if expected != "" && strings.TrimSpace(got[key]) != expected {
			return key
		}
	}
	if id := normalizeRustDeskID(got["id"]); isNumericRustDeskID(id) {
		if id != canonical.id {
			return "id"
		}
		return ""
	}
	if strings.TrimSpace(got["enc_id"]) == "" {
		return "id/enc_id"
	}
	return ""
}

func requiredRustDeskSyncRoots(profiles []rustDeskSyncProfile, sourceRoot string, systemUsed bool) []string {
	seen := map[string]bool{}
	var roots []string
	for _, profile := range profiles {
		required := profile.role == rustDeskProfileLocalService || profile.active ||
			strings.EqualFold(filepath.Clean(profile.root), filepath.Clean(sourceRoot)) ||
			(profile.role == rustDeskProfileSystem && systemUsed)
		if !required {
			continue
		}
		key := strings.ToLower(filepath.Clean(profile.root))
		if !seen[key] {
			seen[key] = true
			roots = append(roots, profile.root)
		}
	}
	return roots
}

func requiredRustDeskRepairSyncRoots(profiles []rustDeskSyncProfile) ([]string, error) {
	seen := map[string]bool{}
	var roots []string
	hasActiveUserRoaming := false
	hasLocalServiceRoaming := false
	for _, profile := range profiles {
		required := false
		switch {
		case profile.role == rustDeskProfileUser && profile.active && isRustDeskRoamingProfileRoot(profile.root):
			hasActiveUserRoaming = true
			required = true
		case profile.role == rustDeskProfileLocalService && isRustDeskRoamingProfileRoot(profile.root):
			hasLocalServiceRoaming = true
			required = true
		}
		if !required {
			continue
		}
		key := strings.ToLower(filepath.Clean(profile.root))
		if !seen[key] {
			seen[key] = true
			roots = append(roots, profile.root)
		}
	}
	if !hasActiveUserRoaming {
		return nil, fmt.Errorf("required profile missing: active-user Roaming")
	}
	if !hasLocalServiceRoaming {
		return nil, fmt.Errorf("required profile missing: LocalService Roaming")
	}
	return roots, nil
}

func isRustDeskRoamingProfileRoot(root string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(filepath.ToSlash(strings.TrimSpace(root)), `\`, "/"))
	return strings.Contains(normalized, "/appdata/roaming/")
}

func rustDeskIdentityMatches(content []byte, canonical rustDeskCanonicalIdentity) bool {
	return rustDeskIdentityMismatchField(content, canonical) == ""
}

func rustDeskIdentityMismatchField(content []byte, canonical rustDeskCanonicalIdentity) string {
	want := parseTOMLTopLevel(string(canonical.content))
	got := parseTOMLTopLevel(string(content))
	for _, key := range []string{"id", "enc_id", "password", "salt", "key_pair", "key_confirmed"} {
		expected := strings.TrimSpace(want[key])
		if expected != "" && strings.TrimSpace(got[key]) != expected {
			return key
		}
	}
	return ""
}

func validateRustDeskIdentityIDs(uiID, serviceID string) error {
	uiID = normalizeRustDeskID(uiID)
	serviceID = normalizeRustDeskID(serviceID)
	if !isNumericRustDeskID(uiID) {
		return fmt.Errorf("identity_mismatch: canonical UI ID is unavailable")
	}
	if !isNumericRustDeskID(serviceID) {
		return fmt.Errorf("identity_mismatch: service-reported ID is unavailable")
	}
	if uiID != serviceID {
		return fmt.Errorf("identity_mismatch: UI ID %s differs from service ID %s", uiID, serviceID)
	}
	return nil
}
