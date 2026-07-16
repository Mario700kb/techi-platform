package native

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// UndoFunc reverses a single mutating step. Every mutating Executor primitive
// returns one (possibly nil) so the orchestrator can build a strict-reverse
// undo stack for transactional rollback (#3).
type UndoFunc func() error

// ServiceSnapshot is the exact captured configuration + state of a service, so
// rollback can restore it and final validation can compare against the target.
type ServiceSnapshot struct {
	Exists     bool     `json:"exists"`
	BinaryPath string   `json:"binary_path"`
	Arguments  []string `json:"arguments"`
	StartType  string   `json:"start_type"`
	Account    string   `json:"account"`
	Running    bool     `json:"running"`
	ProcessID  uint32   `json:"process_id"`
}

// PriorState is everything captured BEFORE any mutation so rollback can restore
// the device to how it was found (#3).
type PriorState struct {
	Service          ServiceSnapshot
	InstallDirExists bool
	TrayExists       bool
	TrayEnabled      bool
	TrayRunning      bool
	RetryTaskExists  bool
}

// RollbackResult is the honest record of a rollback attempt. Success is NEVER
// reported unless every recorded undo completed.
type RollbackResult struct {
	Attempted   bool     `json:"attempted"`
	Completed   bool     `json:"completed"`
	FailedSteps []string `json:"failed_steps,omitempty"`
	FinalHealth string   `json:"final_health"`
}

// Executor is the side-effecting boundary. Each mutating primitive returns an
// UndoFunc recorded on the transaction's undo stack. Everything is exact and
// bounded: services by exact name, processes by exact image path/handle, files
// confined to the approved install directory.
type Executor interface {
	// CaptureState snapshots service/tray/dir/retry state before any mutation.
	CaptureState(p ExecuteParams) (PriorState, error)
	// VerifyPayload hashes the exact staged payload file and compares to expected.
	VerifyPayload(payloadPath, expectedSHA string) error
	PreserveConfig(p ExecuteParams) (UndoFunc, error)
	StopTray(p ExecuteParams, prior PriorState) (UndoFunc, error)
	StopService(p ExecuteParams, prior PriorState) (UndoFunc, error)
	StopProcessExact(exePath string, wait time.Duration) (UndoFunc, error)
	RemoveStaleService(p ExecuteParams, prior PriorState) (UndoFunc, error)
	CleanupTmp(p ExecuteParams) (UndoFunc, error)
	StagePayload(p ExecuteParams, stagingDir string, bundle *BoundBundle) (UndoFunc, error)
	PromoteFiles(p ExecuteParams, stagingDir string, m *BundleManifest) (UndoFunc, error)
	RestoreConfig(p ExecuteParams) (UndoFunc, error)
	CreateService(p ExecuteParams, m *BundleManifest, prior PriorState) (UndoFunc, error)
	StartService(p ExecuteParams, prior PriorState) (UndoFunc, error)
	StartUI(p ExecuteParams) (UndoFunc, error)
	ScheduleBootRetry(p ExecuteParams) (UndoFunc, error)
	// ValidateFinal proves the exact final contract (EXE hash/version, service
	// config+state+args, exact image path, no stale helper, config restored).
	ValidateFinal(p ExecuteParams, m *BundleManifest) error
	// Health returns a short health string for rollback reporting.
	Health(p ExecuteParams) string
}

// ExecuteParams carries the concrete, already-validated targets a plan needs.
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
	ConfigPaths     []string
	BackupRoot      string
	// BundleManifestPath is the manifest sidecar bound to the .zip payload.
	BundleManifestPath string
	// BundleManifestSHA binds the sidecar bytes to the activated package record.
	BundleManifestSHA string
	// LockRoot is the machine-wide execution-lock root (…/locks live under it).
	LockRoot string
	// RetryRoot holds the TECHI-owned bounded retry-state file.
	RetryRoot   string
	DeviceID    string
	PolicyPath  string
	ArtifactDir string
	RetryOwner  string
	// HeldLock is set by the CLI when it acquired the execution lock before live
	// observation. Direct callers leave it nil and ExecutePlan acquires the lock.
	HeldLock *ExecutionLock
}

// BoundBundle contains the exact immutable bytes validated under the execution
// lock. Extraction consumes PayloadBytes directly, eliminating a verify/open
// TOCTOU window between package identity checks and staging.
type BoundBundle struct {
	Manifest      *BundleManifest
	PayloadBytes  []byte
	ManifestBytes []byte
}

// CrossCheckManifest binds policy/params to the manifest before any mutation
// (#5): version, platform, arch, product_root, entrypoint, service identity and
// arguments must all agree, and the manifest's bundle_sha256 must equal the
// hash of the exact payload file on disk. Any mismatch is a hard refusal.
func CrossCheckManifest(p ExecuteParams, m *BundleManifest, payloadBytes, manifestBytes []byte) error {
	if m == nil {
		return fmt.Errorf("no bound manifest")
	}
	if err := m.Validate(); err != nil {
		return err
	}
	if m.Version != p.ExpectedVersion {
		return fmt.Errorf("manifest version %s != policy target %s", m.Version, p.ExpectedVersion)
	}
	if m.Platform != "windows" || m.Architecture != "amd64" {
		return fmt.Errorf("manifest platform/arch %s/%s unsupported", m.Platform, m.Architecture)
	}
	if m.Product != "TECHI Remote Support" || m.ProductRoot != "TECHI Remote Support" {
		return fmt.Errorf("manifest product/root %q/%q is not canonical", m.Product, m.ProductRoot)
	}
	if m.Entrypoint != "TECHI Remote Support/TECHI Remote Support.exe" {
		return fmt.Errorf("manifest entrypoint %q is not canonical", m.Entrypoint)
	}
	if m.ServiceName != "TECHI Remote Support" || len(m.ServiceArguments) != 1 || m.ServiceArguments[0] != "--service" {
		return fmt.Errorf("manifest service identity/arguments are not canonical")
	}
	if m.TrayTaskName != "TECHI Remote Support Tray" || len(m.TrayArguments) != 1 || m.TrayArguments[0] != "--tray" {
		return fmt.Errorf("manifest tray identity/arguments are not canonical")
	}
	if !strings.EqualFold(m.ServiceName, p.ServiceName) {
		return fmt.Errorf("manifest service_name %q != params %q", m.ServiceName, p.ServiceName)
	}
	epBase := m.Entrypoint[strings.LastIndex(m.Entrypoint, "/")+1:]
	expectedBase := filepath.Base(strings.ReplaceAll(p.ExpectedExePath, `\`, "/"))
	if !strings.EqualFold(epBase, expectedBase) {
		return fmt.Errorf("manifest entrypoint %q != expected exe %q", epBase, expectedBase)
	}
	canonicalExe := strings.TrimRight(p.InstallDir, `\/`) + `\TECHI Remote Support.exe`
	if !equalWindowsPath(p.ExpectedExePath, canonicalExe) {
		return fmt.Errorf("expected exe path %q is not canonical %q", p.ExpectedExePath, canonicalExe)
	}
	for _, file := range m.ExpectedRelativeFiles {
		if manifestPathIsNeverOverwrite(file.Path, m.NeverOverwrite) {
			return fmt.Errorf("bundle payload attempts to overwrite protected config path: %s", file.Path)
		}
	}
	wantBundle := fmt.Sprintf("TECHI-Remote-Support-%s-windows-amd64.zip", p.ExpectedVersion)
	if !strings.EqualFold(filepath.Base(p.PayloadPath), wantBundle) {
		return fmt.Errorf("payload filename must be %q", wantBundle)
	}
	wantManifest := strings.TrimSuffix(wantBundle, ".zip") + ".manifest.json"
	if !strings.EqualFold(filepath.Base(p.BundleManifestPath), wantManifest) {
		return fmt.Errorf("manifest filename must be %q", wantManifest)
	}
	// Bind the manifest to the exact payload bytes on disk.
	got := HashBytesSHA256(payloadBytes)
	if !strings.EqualFold(got, m.BundleSHA256) {
		return fmt.Errorf("payload sha256 != manifest bundle_sha256")
	}
	if !strings.EqualFold(got, p.PayloadSHA) {
		return fmt.Errorf("payload sha256 != policy sha256")
	}
	if !sha256Re.MatchString(p.BundleManifestSHA) {
		return fmt.Errorf("policy manifest_sha256 is invalid")
	}
	if !strings.EqualFold(HashBytesSHA256(manifestBytes), p.BundleManifestSHA) {
		return fmt.Errorf("manifest bytes sha256 != policy manifest_sha256")
	}
	return nil
}

func manifestPathIsNeverOverwrite(filePath string, patterns []string) bool {
	base := filepath.Base(strings.ReplaceAll(filePath, `\`, "/"))
	for _, pattern := range patterns {
		patternBase := filepath.Base(strings.ReplaceAll(strings.TrimSpace(pattern), `\`, "/"))
		if matched, err := filepath.Match(strings.ToLower(patternBase), strings.ToLower(base)); err == nil && matched {
			return true
		}
	}
	return false
}

func equalWindowsPath(a, b string) bool {
	normalize := func(value string) string {
		return strings.ToLower(strings.TrimRight(strings.ReplaceAll(strings.TrimSpace(value), "/", `\`), `\`))
	}
	return normalize(a) == normalize(b)
}

type txStep struct {
	name string
	undo UndoFunc
}

type transaction struct{ steps []txStep }

func (t *transaction) push(name string, u UndoFunc) {
	if u != nil {
		t.steps = append(t.steps, txStep{name, u})
	}
}

// rollback runs every recorded undo in strict reverse order and reports honestly.
func (t *transaction) rollback(health func() string) RollbackResult {
	res := RollbackResult{Attempted: true, Completed: true}
	for i := len(t.steps) - 1; i >= 0; i-- {
		if err := t.steps[i].undo(); err != nil {
			res.Completed = false
			res.FailedSteps = append(res.FailedSteps, t.steps[i].name+": "+err.Error())
		}
	}
	if health != nil {
		res.FinalHealth = health()
	}
	return res
}

// ExecutePlan drives an ordered RecoveryPlan through an Executor transactionally.
// In dry-run it makes NO change. In execute mode it holds the machine-wide lock,
// binds+cross-checks the manifest, records an undo for every mutation, and on
// ANY failure rolls back in strict reverse order — reporting a RollbackResult
// and never a false success.
func ExecutePlan(plan RecoveryPlan, p ExecuteParams, exec Executor, execute bool) OperationResult {
	r := NewResult("repair-remote-support", plan.FinalCode)
	r.Component = "remote_support"
	r.Classify = string(plan.Classification)
	r.Planned = actionNames(plan.Actions)
	r.DryRun = !execute
	r.Message = plan.Note

	if !plan.Mutating {
		return r
	}

	// Static safety gates (apply in dry-run and execute).
	if IsRefusedInstallTarget(p.InstallDir) {
		return failStatic(plan, execute, ExitUnsafeTarget, "refused unsafe install target: "+p.InstallDir)
	}
	staging := anyAction(plan.Actions, ActStagePayload)
	requiresManifest := plan.Mutating
	if staging && !IsNativeBundleFilename(p.PayloadPath) {
		return failStatic(plan, execute, ExitBadArgs, "native recovery payload must be a .zip bundle, not "+p.PayloadPath)
	}
	if requiresManifest && strings.TrimSpace(p.BundleManifestPath) == "" {
		return failStatic(plan, execute, ExitBadArgs, "bundle recovery requires a bound manifest")
	}
	if requiresManifest && strings.TrimSpace(p.BundleManifestSHA) == "" {
		return failStatic(plan, execute, ExitBadArgs, "bundle recovery requires a bound manifest sha256")
	}

	if !execute {
		r.Message = "dry-run: " + plan.Note + " (pass --execute to mutate)"
		return r
	}

	// Machine-wide lock over the whole observation→mutation→rollback sequence.
	lockRoot := p.LockRoot
	if strings.TrimSpace(lockRoot) == "" {
		lockRoot = p.BackupRoot
	}
	lock := p.HeldLock
	ownedLock := false
	if lock == nil || !lock.acquired {
		var code ExitCode
		var err error
		lock, code, err = AcquireExecutionLock(lockRoot)
		if err != nil {
			return failStatic(plan, true, code, "cannot acquire execution lock: "+err.Error())
		}
		ownedLock = true
	}
	if ownedLock {
		defer lock.Release()
	}

	// Read and bind the exact ZIP + sidecar bytes once under the lock. Staging
	// extracts these bytes rather than reopening a replaceable path.
	var manifest *BundleManifest
	var bound *BoundBundle
	if requiresManifest {
		manifestBytes, rerr := os.ReadFile(p.BundleManifestPath)
		if rerr != nil {
			return failStatic(plan, true, ExitValidationError, "manifest read failed: "+rerr.Error())
		}
		m, lerr := ParseBundleManifest(manifestBytes)
		if lerr != nil {
			return failStatic(plan, true, ExitValidationError, "manifest load failed: "+lerr.Error())
		}
		payloadBytes, rerr := os.ReadFile(p.PayloadPath)
		if rerr != nil {
			return failStatic(plan, true, ExitPayloadMissing, "payload read failed: "+rerr.Error())
		}
		if cerr := CrossCheckManifest(p, m, payloadBytes, manifestBytes); cerr != nil {
			return failStatic(plan, true, ExitValidationError, "manifest cross-check failed: "+cerr.Error())
		}
		manifest = m
		bound = &BoundBundle{Manifest: m, PayloadBytes: payloadBytes, ManifestBytes: manifestBytes}
	}

	stagingDir := p.StagingRoot
	if sd, serr := StagingPath(p.StagingRoot, "remote-support", p.ExpectedVersion); serr == nil {
		stagingDir = sd
	}

	prior, perr := exec.CaptureState(p)
	if perr != nil {
		return failStatic(plan, true, ExitError, "capture state failed: "+perr.Error())
	}

	tx := &transaction{}
	health := func() string { return exec.Health(p) }

	fail := func(code ExitCode, action ActionType, err error) OperationResult {
		rb := tx.rollback(health)
		out := NewResult("repair-remote-support", code)
		out.Component = "remote_support"
		out.Classify = string(plan.Classification)
		out.Planned = r.Planned
		out.Performed = r.Performed
		out.Rollback = &rb
		out.Message = fmt.Sprintf("%s failed: %v", action, err)
		if code == ExitOK { // a failure must never carry ExitOK
			out.Code = ExitError
			out.CodeName = ExitError.String()
			out.OK = false
		}
		return out
	}

	for _, a := range plan.Actions {
		var undo UndoFunc
		var aerr error
		switch a {
		case ActNoop:
		case ActVerifyPayload:
			if aerr = exec.VerifyPayload(p.PayloadPath, p.PayloadSHA); aerr != nil {
				return fail(ExitIdentityFailed, a, aerr)
			}
		case ActPreserveConfig:
			undo, aerr = exec.PreserveConfig(p)
		case ActStopTray:
			undo, aerr = exec.StopTray(p, prior)
		case ActStopService:
			undo, aerr = exec.StopService(p, prior)
		case ActStopProcessExact:
			undo, aerr = exec.StopProcessExact(p.ExpectedExePath, p.ProcessWait)
		case ActRemoveStaleService:
			undo, aerr = exec.RemoveStaleService(p, prior)
		case ActCleanupTmp:
			undo, aerr = exec.CleanupTmp(p)
		case ActStagePayload:
			undo, aerr = exec.StagePayload(p, stagingDir, bound)
		case ActPromoteFiles:
			undo, aerr = exec.PromoteFiles(p, stagingDir, manifest)
		case ActRestoreConfig:
			undo, aerr = exec.RestoreConfig(p)
		case ActCreateService:
			undo, aerr = exec.CreateService(p, manifest, prior)
		case ActStartService:
			undo, aerr = exec.StartService(p, prior)
		case ActStartUI:
			undo, aerr = exec.StartUI(p)
		case ActScheduleBootRetry:
			undo, aerr = exec.ScheduleBootRetry(p)
		case ActValidateFinal:
			if aerr = exec.ValidateFinal(p, manifest); aerr != nil {
				return fail(ExitValidationError, a, aerr)
			}
		default:
			return fail(ExitError, a, fmt.Errorf("unknown action"))
		}
		// A primitive can fail after a partial mutation. Record any undo it
		// returns before handling the error so that partial state is not lost.
		tx.push(string(a), undo)
		if aerr != nil {
			return fail(ExitError, a, aerr)
		}
		r.Performed = append(r.Performed, string(a))
	}

	r.OK = plan.FinalCode == ExitOK
	if provider, ok := exec.(interface{ CompletionStatus() string }); ok {
		status := provider.CompletionStatus()
		message := status
		if detailProvider, ok := exec.(interface{ CompletionDetail() string }); ok {
			if detail := strings.TrimSpace(detailProvider.CompletionDetail()); detail != "" {
				message += ": " + detail
			}
		}
		switch status {
		case remoteSupportUIPendingLoginStatus:
			r.Message = message
		case remoteSupportUILaunchFailedStatus:
			r.Code = ExitValidationError
			r.CodeName = ExitValidationError.String()
			r.OK = false
			r.Message = message
		}
	}
	return r
}

func failStatic(plan RecoveryPlan, execute bool, code ExitCode, msg string) OperationResult {
	out := NewResult("repair-remote-support", code)
	out.Component = "remote_support"
	out.Classify = string(plan.Classification)
	out.Planned = actionNames(plan.Actions)
	out.DryRun = !execute
	out.Message = msg
	return out
}

func anyAction(actions []ActionType, want ActionType) bool {
	for _, a := range actions {
		if a == want {
			return true
		}
	}
	return false
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
