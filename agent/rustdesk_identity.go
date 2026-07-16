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

func rustDeskIdentityMatches(content []byte, canonical rustDeskCanonicalIdentity) bool {
	want := parseTOMLTopLevel(string(canonical.content))
	got := parseTOMLTopLevel(string(content))
	for _, key := range []string{"id", "enc_id", "password", "salt", "key_pair", "key_confirmed"} {
		expected := strings.TrimSpace(want[key])
		if expected != "" && strings.TrimSpace(got[key]) != expected {
			return false
		}
	}
	return true
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
