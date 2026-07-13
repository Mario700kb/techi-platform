package native

import (
	"fmt"
	"strings"
	"time"
)

// Executor is the side-effecting boundary the recovery/apply orchestrator
// drives. The pure planner (PlanRemoteSupportRecovery) decides WHAT to do; an
// Executor performs it. Splitting it this way keeps the decision logic
// unit-testable with a fake and confines every real Windows mutation to one
// build-tagged implementation. Every method must be exact and bounded: service
// operations by exact name, process termination by exact image path, file
// operations confined to the approved install directory.
type Executor interface {
	// VerifyPayload re-checks the payload SHA256 immediately before any
	// mutation (belt-and-suspenders with the planner's gate).
	VerifyPayload(payloadPath, expectedSHA string) error
	// PreserveConfig snapshots RS id/config/password so it survives promotion.
	PreserveConfig(installDir string) error
	// StopService stops the service by exact name; no-op if already stopped.
	StopService(name string) error
	// StopTray stops/disables the RS tray scheduled task by exact task name.
	StopTray(taskName string) error
	// StopProcessExact terminates ONLY processes whose image path equals
	// exePath exactly, then waits up to wait for exit. Never name-only.
	StopProcessExact(exePath string, wait time.Duration) error
	// RemoveStaleService deletes a service whose EXE is gone, by exact name.
	RemoveStaleService(name string) error
	// CleanupTmp removes leftover TBD*.tmp only within installDir.
	CleanupTmp(installDir string) error
	// StagePayload expands/copies the verified bundle into stagingDir.
	StagePayload(payloadPath, stagingDir string) error
	// PromoteFiles atomically moves staged files into installDir, taking a
	// backup first so Rollback can undo it.
	PromoteFiles(stagingDir, installDir string) error
	// RestoreConfig writes the preserved RS id/config back into installDir.
	RestoreConfig(installDir string) error
	// CreateService (re)creates the service pointing at the exact EXE path.
	CreateService(name, exePath string) error
	// StartService starts the service by exact name.
	StartService(name string) error
	// ScheduleBootRetry registers exactly ONE bounded retry at next boot.
	ScheduleBootRetry(command string) error
	// ValidateFinal proves EXE present, expected version, service RUNNING, and
	// exact image path. Returns an error to trigger rollback.
	ValidateFinal(p ExecuteParams) error
	// Rollback restores the pre-promotion backup after a failed validation.
	Rollback(installDir string) error
}

// ExecuteParams carries the concrete, already-validated targets a plan needs.
// The orchestrator refuses to run a mutating plan unless InstallDir is a safe,
// non-refused absolute target.
type ExecuteParams struct {
	Component       string
	ServiceName     string
	InstallDir      string
	ExpectedExePath string
	ExpectedVersion string
	PayloadPath     string
	PayloadSHA      string
	StagingRoot     string
	TrayTaskName    string
	BootRetryCmd    string
	ProcessWait     time.Duration
	// ConfigPaths are the exact RS identity/config files to preserve across a
	// promotion. Supplied by the wiring layer, never guessed by the executor.
	ConfigPaths []string
	// BackupRoot is where PromoteFiles stashes the pre-promotion install dir so
	// Rollback can restore it. Must be a safe, restricted directory.
	BackupRoot string
}

// ExecutePlan drives an ordered RecoveryPlan through an Executor. In dry-run it
// performs NO mutation and only records what it would do. In execute mode it
// runs each action in order, and on a failed ValidateFinal it rolls back. It
// returns a machine-readable OperationResult with the deterministic exit code.
//
// The plan is run exactly once — there is no internal retry loop; the only
// retry is the single boot retry scheduled by the pending-reboot plan.
func ExecutePlan(plan RecoveryPlan, p ExecuteParams, exec Executor, execute bool) OperationResult {
	r := NewResult("repair-remote-support", plan.FinalCode)
	r.Component = "remote_support"
	r.Classify = string(plan.Classification)
	r.Planned = actionNames(plan.Actions)
	r.DryRun = !execute
	r.Message = plan.Note

	// Non-mutating plans (noop / detect-only / refusals) never touch the device.
	if !plan.Mutating {
		return r
	}

	// Hard safety gate before ANY mutation: the install dir must be a real,
	// non-refused absolute path. This is the last line before destructive work.
	if IsRefusedInstallTarget(p.InstallDir) {
		out := NewResult("repair-remote-support", ExitUnsafeTarget)
		out.Component = "remote_support"
		out.Classify = string(plan.Classification)
		out.Planned = r.Planned
		out.DryRun = !execute
		out.Message = "refused unsafe install target: " + p.InstallDir
		return out
	}

	if !execute {
		// Dry-run: report the plan; make no changes.
		r.Message = "dry-run: " + plan.Note + " (pass --execute to mutate)"
		return r
	}

	stagingDir := p.StagingRoot
	if sd, err := StagingPath(p.StagingRoot, p.Component, p.ExpectedVersion); err == nil {
		stagingDir = sd
	}

	promoted := false
	fail := func(code ExitCode, action ActionType, err error) OperationResult {
		if promoted {
			_ = exec.Rollback(p.InstallDir) // best-effort restore
		}
		out := NewResult("repair-remote-support", code)
		out.Component = "remote_support"
		out.Classify = string(plan.Classification)
		out.Planned = r.Planned
		out.Performed = r.Performed
		out.DryRun = false
		out.Message = fmt.Sprintf("%s failed: %v", action, err)
		return out
	}

	for _, a := range plan.Actions {
		var err error
		switch a {
		case ActNoop:
		case ActVerifyPayload:
			if err = exec.VerifyPayload(p.PayloadPath, p.PayloadSHA); err != nil {
				return fail(ExitIdentityFailed, a, err)
			}
		case ActPreserveConfig:
			err = exec.PreserveConfig(p.InstallDir)
		case ActStopTray:
			err = exec.StopTray(p.TrayTaskName)
		case ActStopService:
			err = exec.StopService(p.ServiceName)
		case ActStopProcessExact:
			err = exec.StopProcessExact(p.ExpectedExePath, p.ProcessWait)
		case ActRemoveStaleService:
			err = exec.RemoveStaleService(p.ServiceName)
		case ActCleanupTmp:
			err = exec.CleanupTmp(p.InstallDir)
		case ActStagePayload:
			err = exec.StagePayload(p.PayloadPath, stagingDir)
		case ActPromoteFiles:
			if err = exec.PromoteFiles(stagingDir, p.InstallDir); err == nil {
				promoted = true
			}
		case ActRestoreConfig:
			err = exec.RestoreConfig(p.InstallDir)
		case ActCreateService:
			err = exec.CreateService(p.ServiceName, p.ExpectedExePath)
		case ActStartService:
			err = exec.StartService(p.ServiceName)
		case ActScheduleBootRetry:
			err = exec.ScheduleBootRetry(p.BootRetryCmd)
		case ActValidateFinal:
			if err = exec.ValidateFinal(p); err != nil {
				return fail(ExitValidationError, a, err)
			}
		default:
			return fail(ExitError, a, fmt.Errorf("unknown action"))
		}
		if err != nil {
			return fail(ExitError, a, err)
		}
		r.Performed = append(r.Performed, string(a))
	}

	r.OK = plan.FinalCode == ExitOK
	return r
}

func actionNames(actions []ActionType) []string {
	out := make([]string, len(actions))
	for i, a := range actions {
		out[i] = string(a)
	}
	return out
}

// ErrNotWindows is returned by the non-Windows executor stub for any mutating
// primitive: live recovery only runs on Windows.
var ErrNotWindows = fmt.Errorf("live Remote Support execution is only supported on Windows")

// NormalizeSubcommand lowercases and strips quotes/whitespace from a raw
// subcommand token so `apply-policy`, `Apply-Policy`, and `"apply-policy"` all
// dispatch identically.
func NormalizeSubcommand(token string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(token), `"'`))
}
