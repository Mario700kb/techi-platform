//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"techi-platform/agent/internal/native"
)

func executeNativeRemoteSupport(
	policy *native.Policy, policyPath, artifactDir, deviceID, retryOwner string, asJSON bool,
) int {
	deviceID = strings.TrimSpace(deviceID)
	if !policy.RemoteSupport.RemoteSupportEligible(deviceID) {
		r := native.NewResult("repair-remote-support", native.ExitBadArgs)
		r.Component = "remote_support"
		r.Message = "--execute refused: canary policy and explicit eligible device identity are required"
		return emitResult(r, asJSON)
	}
	artifactDir = strings.TrimSpace(artifactDir)
	retryOwner = strings.TrimSpace(retryOwner)
	if retryOwner != "" && retryOwner != "techi-bootstrap" {
		r := native.NewResult("repair-remote-support", native.ExitBadArgs)
		r.Component = "remote_support"
		r.Message = "invalid retry task owner"
		return emitResult(r, asJSON)
	}
	params := native.ExecuteParams{
		Component: "remote_support", ServiceName: "TECHI Remote Support",
		InstallDir:         `C:\Program Files\TECHI Remote Support`,
		ExpectedExePath:    `C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`,
		ExpectedVersion:    policy.RemoteSupport.TargetVersion,
		PayloadPath:        filepath.Join(artifactDir, policy.RemoteSupport.PayloadFilename),
		PayloadSHA:         policy.RemoteSupport.SHA256,
		BundleManifestPath: filepath.Join(artifactDir, policy.RemoteSupport.ManifestFilename),
		BundleManifestSHA:  policy.RemoteSupport.ManifestSHA256,
		StagingRoot:        native.StagingRootWindows,
		BackupRoot:         `C:\ProgramData\TechiAgent\backup`, LockRoot: remoteSupportRepairLockRoot,
		RetryRoot: remoteSupportRepairLockRoot, DeviceID: deviceID, PolicyPath: policyPath,
		ArtifactDir: artifactDir, RetryOwner: retryOwner, ProcessWait: 20 * time.Second,
	}
	params.BootRetryCmd = agentBootRetryCommand(params)
	lock, code, err := native.AcquireExecutionLock(params.LockRoot)
	if err != nil {
		r := native.NewResult("repair-remote-support", code)
		r.Component = "remote_support"
		r.Message = "cannot acquire shared repair lock before observation: " + err.Error()
		return emitResult(r, asJSON)
	}
	defer lock.Release()
	params.HeldLock = lock
	observation, err := native.ObserveRemoteSupport(params)
	if err != nil {
		r := native.NewResult("repair-remote-support", native.ExitValidationError)
		r.Component = "remote_support"
		r.Message = "live observation failed: " + err.Error()
		return emitResult(r, asJSON)
	}
	manifest, err := native.LoadBundleManifest(params.BundleManifestPath)
	if err != nil {
		r := native.NewResult("repair-remote-support", native.ExitValidationError)
		r.Component = "remote_support"
		r.Message = "manifest load failed: " + err.Error()
		return emitResult(r, asJSON)
	}
	params.ConfigPaths, err = native.ResolveManifestConfigPaths(manifest)
	if err != nil {
		r := native.NewResult("repair-remote-support", native.ExitValidationError)
		r.Component = "remote_support"
		r.Message = "config preservation contract failed: " + err.Error()
		return emitResult(r, asJSON)
	}
	plan := native.PlanRemoteSupportRecovery(policy.RemoteSupport.RecoveryMode, policy.RemoteSupport.TargetVersion, observation)
	return emitResult(native.ExecutePlan(plan, params, native.NewWindowsExecutor(), true), asJSON)
}

func agentBootRetryCommand(p native.ExecuteParams) string {
	self, err := os.Executable()
	if err != nil {
		return ""
	}
	quote := func(value string) string {
		return `"` + strings.ReplaceAll(value, `"`, "") + `"`
	}
	return strings.Join([]string{
		quote(self), "repair-remote-support",
		"--policy", quote(p.PolicyPath), "--artifact-dir", quote(p.ArtifactDir),
		"--device-id", quote(p.DeviceID), "--retry-owner", "techi-bootstrap",
		"--execute", "--json",
	}, " ")
}
