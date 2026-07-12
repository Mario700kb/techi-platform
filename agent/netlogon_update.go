package main

// NETLOGON-driven native Agent self-update.
//
// Domain-wide rollout for HEALTHY agents whose binary is older than the
// approved rollout target does NOT use MSI: the GPO/NETLOGON deploy script
// stages the approved standalone Agent EXE from NETLOGON and invokes this
// orchestration entry point, which reuses the exact native self-update path
// (swapAgentBinary -> one-shot SYSTEM swap task) that the UI/heartbeat
// self_update already uses. No service stop/start, binary-replace, backup, or
// rollback logic is duplicated here.
//
// The pieces in this file are platform-neutral (path + SHA256 identity gate)
// so they are unit-testable off Windows. The Windows-only orchestration lives
// in netlogon_update_windows.go; a stub lives in netlogon_update_other.go.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
)

// Bounded, stable exit codes. The NETLOGON deploy script maps each to a
// deterministic final_result, so these values must not be reordered.
const (
	netlogonUpdateOK               = 0 // staged binary verified; native swap scheduled
	netlogonUpdateError            = 1 // generic failure after the identity gate passed
	netlogonUpdateBadArgs          = 2 // missing/invalid arguments
	netlogonUpdateIdentityMismatch = 3 // path/SHA256 validation failed; NO swap attempted
	netlogonUpdateBusy             = 4 // another self-update is already in progress
)

// hashFileSHA256 returns the lowercase hex SHA256 of path.
func hashFileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// verifyStagedAgentBinary validates that source is a usable agent binary whose
// SHA256 matches expectedSHA (when expectedSHA is non-empty). It performs NO
// service mutation: it is the identity gate the NETLOGON self-update runs
// before any swap, so a mismatch can never stop the service. It returns a
// bounded exit code plus an error describing the failure.
func verifyStagedAgentBinary(source string, expectedSHA string) (int, error) {
	source = strings.TrimSpace(source)
	if source == "" {
		return netlogonUpdateBadArgs, fmt.Errorf("empty -source path")
	}
	info, err := os.Stat(source)
	if err != nil {
		return netlogonUpdateIdentityMismatch, fmt.Errorf("source not accessible: %w", err)
	}
	if info.IsDir() {
		return netlogonUpdateIdentityMismatch, fmt.Errorf("source is a directory, not a file: %s", source)
	}
	if info.Size() == 0 {
		return netlogonUpdateIdentityMismatch, fmt.Errorf("source is empty: %s", source)
	}
	expectedSHA = strings.ToLower(strings.TrimSpace(expectedSHA))
	if expectedSHA != "" {
		actual, err := hashFileSHA256(source)
		if err != nil {
			return netlogonUpdateIdentityMismatch, fmt.Errorf("cannot hash source: %w", err)
		}
		if actual != expectedSHA {
			return netlogonUpdateIdentityMismatch, fmt.Errorf("sha256 mismatch: expected %s got %s", expectedSHA, actual)
		}
	}
	return netlogonUpdateOK, nil
}
