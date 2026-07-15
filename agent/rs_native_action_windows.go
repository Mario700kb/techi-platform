//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"techi-platform/agent/internal/native"
)

func handleNativeRemoteSupportRepair(ctx context.Context, cfg *Config, values map[string]interface{}) actionResult {
	if err := ctx.Err(); err != nil {
		return actionResult{err: fmt.Errorf("native Remote Support repair cancelled before start: %w", err)}
	}
	version := stringParam(values, "native_bundle_version")
	payloadName := stringParam(values, "native_bundle_filename")
	payloadSHA := strings.ToLower(stringParam(values, "native_bundle_sha256"))
	manifestName := stringParam(values, "native_manifest_filename")
	manifestSHA := strings.ToLower(stringParam(values, "native_manifest_sha256"))
	baseURL := strings.TrimRight(backendBaseURL(cfg.BackendURL), "/")
	if !strings.HasPrefix(baseURL, "https://") || cfg.DeviceID <= 0 {
		return actionResult{err: fmt.Errorf("native Remote Support repair requires HTTPS backend and enrolled device identity")}
	}

	self, err := os.Executable()
	if err != nil {
		return actionResult{err: fmt.Errorf("resolve Agent executable: %w", err)}
	}
	selfSHA, err := native.HashFileSHA256(self)
	if err != nil {
		return actionResult{err: fmt.Errorf("hash Agent executable: %w", err)}
	}
	policy := native.Policy{
		SchemaVersion: native.PolicySchemaVersion,
		RolloutMode:   native.RolloutDisabled,
		APIURL:        baseURL,
		Agent: native.AgentPolicy{
			TargetVersion: AgentVersion, PackageType: "exe",
			Filename: filepath.Base(self), SHA256: selfSHA,
		},
		RemoteSupport: native.RemoteSupportPolic{
			TargetVersion: version, PayloadFilename: payloadName, SHA256: payloadSHA,
			ManifestFilename: manifestName, ManifestSHA256: manifestSHA,
			RecoveryMode: native.RolloutCanary, EligibleDeviceIDs: []string{fmt.Sprint(cfg.DeviceID)},
		},
	}
	if _, err := policy.Validate(); err != nil {
		return actionResult{err: fmt.Errorf("invalid native Remote Support action contract: %w", err)}
	}

	artifactDir := filepath.Join(remoteSupportRepairLockRoot, "recovery", manifestSHA[:16])
	if err := os.MkdirAll(artifactDir, 0o700); err != nil {
		return actionResult{err: fmt.Errorf("create native recovery directory: %w", err)}
	}
	payloadPath := filepath.Join(artifactDir, payloadName)
	manifestPath := filepath.Join(artifactDir, manifestName)
	if err := downloadVerifiedRecoveryFile(
		baseURL+"/api/v1/agent-packages/remote-support-bundle/download", payloadPath, payloadSHA, cfg,
	); err != nil {
		return actionResult{err: fmt.Errorf("download native Remote Support bundle: %w", err)}
	}
	if err := downloadVerifiedRecoveryFile(
		baseURL+"/api/v1/agent-packages/remote-support-bundle/manifest", manifestPath, manifestSHA, cfg,
	); err != nil {
		return actionResult{err: fmt.Errorf("download native Remote Support manifest: %w", err)}
	}
	policyPath := filepath.Join(artifactDir, "techi-policy.json")
	policyBytes, _ := json.Marshal(policy)
	if err := os.WriteFile(policyPath, policyBytes, 0o600); err != nil {
		return actionResult{err: fmt.Errorf("write native recovery policy: %w", err)}
	}

	cmd := exec.Command(
		self, "repair-remote-support", "--policy", policyPath,
		"--artifact-dir", artifactDir, "--device-id", fmt.Sprint(cfg.DeviceID),
		"--execute", "--json",
	)
	output, runErr := cmd.CombinedOutput()
	var result native.OperationResult
	if err := json.Unmarshal(output, &result); err != nil {
		return actionResult{err: fmt.Errorf("native Remote Support repair returned invalid result: %w", runErr)}
	}
	if runErr != nil || !result.OK {
		return actionResult{
			err:    fmt.Errorf("native Remote Support repair failed: %s", result.CodeName),
			output: result.JSON(),
		}
	}
	return actionResult{message: result.Message, output: result.JSON()}
}

func downloadVerifiedRecoveryFile(url, destination, expectedSHA string, cfg *Config) error {
	partial := destination + ".partial"
	_ = os.Remove(partial)
	if err := downloadFile(url, partial, cfg.TimeoutSeconds*10); err != nil {
		return err
	}
	defer os.Remove(partial)
	if _, err := native.VerifyPayload(partial, expectedSHA); err != nil {
		return err
	}
	return os.Rename(partial, destination)
}
