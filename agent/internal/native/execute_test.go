package native

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeExecutor records the exact primitive calls (with key args) and can be
// told to fail a specific step, so the orchestrator's ordering, dry-run gating,
// rollback, and refusal behaviour are all testable off Windows.
type fakeExecutor struct {
	calls            []string
	failOn           map[string]error
	killExe          string // records the exact path passed to StopProcessExact
	completionStatus string
	completionDetail string
}

type malformedConfigExecutor struct {
	*fakeExecutor
	path    string
	corrupt []byte
	fresh   []byte
}

func (f *malformedConfigExecutor) PreserveConfig(ExecuteParams) (UndoFunc, error) {
	decision := prepareConfigForRecovery(f.path, f.corrupt)
	if decision.preserve {
		return nil, fmt.Errorf("malformed config was selected for preservation")
	}
	f.fresh = append([]byte(nil), decision.fresh...)
	return f.mutation("PreserveConfig")
}

func (f *malformedConfigExecutor) RestoreConfig(ExecuteParams) (UndoFunc, error) {
	if _, err := validatePreservableConfig(f.path, f.fresh); err != nil {
		return nil, err
	}
	return f.mutation("RestoreConfig")
}

func newFake() *fakeExecutor { return &fakeExecutor{failOn: map[string]error{}} }

func (f *fakeExecutor) note(name string) error {
	f.calls = append(f.calls, name)
	if err, ok := f.failOn[name]; ok {
		return err
	}
	return nil
}
func (f *fakeExecutor) mutation(name string) (UndoFunc, error) {
	err := f.note(name)
	// Model a primitive that prepared its undo before mutating and then failed
	// after a partial change: the orchestrator must retain this undo on error.
	return func() error { return f.note("Undo:" + name) }, err
}
func (f *fakeExecutor) CaptureState(ExecuteParams) (PriorState, error) {
	return PriorState{}, f.note("CaptureState")
}
func (f *fakeExecutor) VerifyPayload(string, string) error { return f.note("VerifyPayload") }
func (f *fakeExecutor) PreserveConfig(ExecuteParams) (UndoFunc, error) {
	return f.mutation("PreserveConfig")
}
func (f *fakeExecutor) StopService(ExecuteParams, PriorState) (UndoFunc, error) {
	return f.mutation("StopService")
}
func (f *fakeExecutor) StopTray(ExecuteParams, PriorState) (UndoFunc, error) {
	return f.mutation("StopTray")
}
func (f *fakeExecutor) StopProcessExact(exe string, _ time.Duration) (UndoFunc, error) {
	f.killExe = exe
	return f.mutation("StopProcessExact")
}
func (f *fakeExecutor) RemoveStaleService(ExecuteParams, PriorState) (UndoFunc, error) {
	return f.mutation("RemoveStaleService")
}
func (f *fakeExecutor) CleanupTmp(ExecuteParams) (UndoFunc, error) { return f.mutation("CleanupTmp") }
func (f *fakeExecutor) StagePayload(ExecuteParams, string, *BoundBundle) (UndoFunc, error) {
	return f.mutation("StagePayload")
}
func (f *fakeExecutor) PromoteFiles(ExecuteParams, string, *BundleManifest) (UndoFunc, error) {
	return f.mutation("PromoteFiles")
}
func (f *fakeExecutor) RestoreConfig(ExecuteParams) (UndoFunc, error) {
	return f.mutation("RestoreConfig")
}
func (f *fakeExecutor) CreateService(ExecuteParams, *BundleManifest, PriorState) (UndoFunc, error) {
	return f.mutation("CreateService")
}
func (f *fakeExecutor) StartService(ExecuteParams, PriorState) (UndoFunc, error) {
	return f.mutation("StartService")
}
func (f *fakeExecutor) StartUI(ExecuteParams) (UndoFunc, error) {
	return f.mutation("StartUI")
}
func (f *fakeExecutor) ScheduleBootRetry(ExecuteParams) (UndoFunc, error) {
	return f.mutation("ScheduleBootRetry")
}
func (f *fakeExecutor) ValidateFinal(ExecuteParams, *BundleManifest) error {
	return f.note("ValidateFinal")
}
func (f *fakeExecutor) Health(ExecuteParams) string { return "fake-health" }
func (f *fakeExecutor) CompletionStatus() string    { return f.completionStatus }
func (f *fakeExecutor) CompletionDetail() string    { return f.completionDetail }

func (f *fakeExecutor) called(name string) bool {
	for _, c := range f.calls {
		if c == name {
			return true
		}
	}
	return false
}
func (f *fakeExecutor) count(name string) int {
	n := 0
	for _, c := range f.calls {
		if c == name {
			n++
		}
	}
	return n
}

func safeParams(t *testing.T) ExecuteParams {
	t.Helper()
	zb, m := buildTestBundle(t, makeSource(t))
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "TECHI-Remote-Support-1.4.6-windows-amd64.zip")
	manifestPath := filepath.Join(dir, "TECHI-Remote-Support-1.4.6-windows-amd64.manifest.json")
	m.BundleSHA256 = HashBytesSHA256(zb)
	mb, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(zipPath, zb, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, mb, 0o600); err != nil {
		t.Fatal(err)
	}
	return ExecuteParams{
		Component:          "remote_support",
		ServiceName:        "TECHI Remote Support",
		InstallDir:         `C:\Program Files\TECHI Remote Support`,
		ExpectedExePath:    `C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`,
		ExpectedVersion:    "1.4.6",
		PayloadPath:        zipPath,
		PayloadSHA:         HashBytesSHA256(zb),
		BundleManifestPath: manifestPath,
		BundleManifestSHA:  HashBytesSHA256(mb),
		StagingRoot:        `C:\ProgramData\TechiAgent\staging`,
		BackupRoot:         t.TempDir(),
		LockRoot:           t.TempDir(),
		RetryRoot:          t.TempDir(),
		ProcessWait:        time.Second,
	}
}

func staleServiceObs() RSObservation {
	return withPayload(RSObservation{ServiceExists: true, ConfigPresent: true, StaleTmpFiles: true})
}

func TestExecute_DisabledNoMutation(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutDisabled, "1.4.6", staleServiceObs())
	f := newFake()
	r := ExecutePlan(plan, safeParams(t), f, true) // execute=true, but plan is detect-only
	if len(f.calls) != 0 {
		t.Fatalf("disabled plan must call NO executor primitives, got %v", f.calls)
	}
	if r.Code != ExitOK {
		t.Fatalf("want ExitOK, got %v", r.Code)
	}
}

func TestExecute_CanaryDryRunMakesNoChanges(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	f := newFake()
	r := ExecutePlan(plan, safeParams(t), f, false) // execute=false
	if len(f.calls) != 0 {
		t.Fatalf("dry-run must call NO executor primitives, got %v", f.calls)
	}
	if !r.DryRun {
		t.Fatalf("result must be marked dry-run")
	}
}

func TestExecute_CanaryExecuteRunsOrderedPlan(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	f := newFake()
	r := ExecutePlan(plan, safeParams(t), f, true)
	if r.Code != ExitOK {
		t.Fatalf("want ExitOK, got %v (%s)", r.Code, r.Message)
	}
	for _, want := range []string{"VerifyPayload", "PreserveConfig", "StopTray", "StopService",
		"StopProcessExact", "RemoveStaleService", "StagePayload", "PromoteFiles",
		"RestoreConfig", "CreateService", "StartService", "StartUI", "ValidateFinal"} {
		if !f.called(want) {
			t.Errorf("expected %s to be called; calls=%v", want, f.calls)
		}
	}
}

func TestExecute_ServiceMissingUsesFullReplacement(t *testing.T) {
	obs := withPayload(RSObservation{ExeExists: true, ExeVersion: "1.4.6"})
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", obs)
	f := newFake()
	ExecutePlan(plan, safeParams(t), f, true)
	for _, want := range []string{"StopTray", "StopService", "StopProcessExact", "StagePayload", "PromoteFiles", "CreateService", "StartService", "StartUI", "ValidateFinal"} {
		if !f.called(want) {
			t.Fatalf("service_missing full replacement omitted %s: %v", want, f.calls)
		}
	}
}

func TestExecute_LockedPendingRebootOneRetryNoPromote(t *testing.T) {
	obs := withPayload(RSObservation{
		ExeExists: true, ExeVersion: "1.4.5", ServiceExists: true,
		TrayRunning: true, FilesLocked: true, PendingReboot: true, ConfigPresent: true,
	})
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", obs)
	f := newFake()
	p := safeParams(t)
	r := ExecutePlan(plan, p, f, true)
	if r.Code != ExitPendingReboot {
		t.Fatalf("want ExitPendingReboot, got %v", r.Code)
	}
	if f.called("PromoteFiles") {
		t.Fatalf("must not promote files while reboot pending: %v", f.calls)
	}
	if f.count("ScheduleBootRetry") != 1 {
		t.Fatalf("exactly one boot retry expected, got %d", f.count("ScheduleBootRetry"))
	}
	for _, forbidden := range []string{"PreserveConfig", "StopTray", "StopService", "StopProcessExact"} {
		if f.called(forbidden) {
			t.Fatalf("pending-reboot deferral must leave the live installation untouched; calls=%v", f.calls)
		}
	}
}

func TestExecute_FailureAfterEveryMutatingStageRollsBack(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	for _, stage := range []string{
		"PreserveConfig", "StopTray", "StopService", "StopProcessExact", "RemoveStaleService",
		"StagePayload", "PromoteFiles", "RestoreConfig", "CreateService", "StartService", "StartUI",
	} {
		t.Run(stage, func(t *testing.T) {
			f := newFake()
			f.failOn[stage] = fmt.Errorf("injected failure after partial mutation")
			r := ExecutePlan(plan, safeParams(t), f, true)
			if r.OK || r.Rollback == nil || !r.Rollback.Attempted {
				t.Fatalf("%s failure must report rollback: result=%+v calls=%v", stage, r, f.calls)
			}
			if !f.called("Undo:" + stage) {
				t.Fatalf("failed stage undo was not retained: calls=%v", f.calls)
			}
		})
	}
}

func TestExecute_RollbackOnValidationFailure(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	f := newFake()
	f.failOn["ValidateFinal"] = fmt.Errorf("service not running")
	r := ExecutePlan(plan, safeParams(t), f, true)
	if r.Code != ExitValidationError {
		t.Fatalf("want ExitValidationError, got %v", r.Code)
	}
	if r.Rollback == nil || !r.Rollback.Attempted || !f.called("Undo:PromoteFiles") {
		t.Fatalf("failed validation after promote must roll back: result=%+v calls=%v", r.Rollback, f.calls)
	}
}

func TestExecute_PromotedRuntimeFailureStopsBeforeConfigServiceAndUI(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	f := newFake()
	want := `verify promoted runtime: required runtime file "TECHI Remote Support.exe": file does not exist`
	f.failOn["PromoteFiles"] = fmt.Errorf("%s", want)
	r := ExecutePlan(plan, safeParams(t), f, true)

	if r.OK || !strings.Contains(r.Message, want) {
		t.Fatalf("promotion verification error was not preserved: %+v", r)
	}
	if r.Rollback == nil || !r.Rollback.Attempted || !f.called("Undo:PromoteFiles") {
		t.Fatalf("failed promoted runtime must roll back: result=%+v calls=%v", r, f.calls)
	}
	for _, forbidden := range []string{"RestoreConfig", "CreateService", "StartService", "StartUI", "ValidateFinal"} {
		if f.called(forbidden) {
			t.Fatalf("%s ran after promoted runtime verification failed: %v", forbidden, f.calls)
		}
	}
}

func TestExecute_BadSHARefusesEarly(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	f := newFake()
	f.failOn["VerifyPayload"] = fmt.Errorf("sha mismatch")
	r := ExecutePlan(plan, safeParams(t), f, true)
	if r.Code != ExitIdentityFailed {
		t.Fatalf("want ExitIdentityFailed, got %v", r.Code)
	}
	if f.called("StopService") || f.called("PromoteFiles") {
		t.Fatalf("no mutation may follow a failed payload verify: %v", f.calls)
	}
}

func TestExecute_RefusesUnsafeInstallTarget(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	p := safeParams(t)
	p.InstallDir = `C:\Windows\System32`
	f := newFake()
	r := ExecutePlan(plan, p, f, true)
	if r.Code != ExitUnsafeTarget {
		t.Fatalf("want ExitUnsafeTarget, got %v", r.Code)
	}
	if len(f.calls) != 0 {
		t.Fatalf("unsafe target must abort before any primitive: %v", f.calls)
	}
}

func TestExecute_RefusesMSIPayload(t *testing.T) {
	// The native recovery must never accept the MSI as its payload.
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	p := safeParams(t)
	p.PayloadPath = `C:\ProgramData\TechiAgent\payloads\TECHI-Remote-Support-1.4.6.msi`
	f := newFake()
	r := ExecutePlan(plan, p, f, true)
	if r.Code != ExitBadArgs {
		t.Fatalf("MSI payload must be refused (ExitBadArgs), got %v", r.Code)
	}
	if len(f.calls) != 0 {
		t.Fatalf("MSI refusal must abort before any primitive: %v", f.calls)
	}
}

func TestExecute_ConfigPreservedAndRestored(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	f := newFake()
	ExecutePlan(plan, safeParams(t), f, true)
	if !f.called("PreserveConfig") || !f.called("RestoreConfig") {
		t.Fatalf("config must be preserved+restored: %v", f.calls)
	}
}

func TestExecute_InvalidConfigQuarantineContinuesFullReinstall(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	f := &malformedConfigExecutor{
		fakeExecutor: newFake(),
		path:         `C:\Users\USER\AppData\Roaming\TECHI Remote Support\config\TECHI Remote Support.toml`,
		corrupt:      []byte("id = '123456789'\ninvalid assignment\n"),
	}
	r := ExecutePlan(plan, safeParams(t), f, true)
	if !r.OK {
		t.Fatalf("invalid config must not block full reinstall: code=%v message=%s", r.Code, r.Message)
	}
	for _, action := range []string{"PromoteFiles", "RestoreConfig", "CreateService", "StartService", "StartUI", "ValidateFinal"} {
		if !f.called(action) {
			t.Fatalf("full reinstall stopped before %s: %v", action, f.calls)
		}
	}
	if string(f.fresh) == string(f.corrupt) || strings.Contains(string(f.fresh), "invalid assignment") {
		t.Fatalf("corrupt config was restored: %q", f.fresh)
	}
}

func TestExecute_NoLoggedInUserKeepsValidReinstall(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	f := newFake()
	f.completionStatus = remoteSupportUIPendingLoginStatus
	r := ExecutePlan(plan, safeParams(t), f, true)
	if !r.OK || r.Message != remoteSupportUIPendingLoginStatus {
		t.Fatalf("pending-login repair must succeed: %+v", r)
	}
	if r.Rollback != nil || f.called("Undo:PromoteFiles") {
		t.Fatalf("valid reinstall rolled back without a desktop session: result=%+v calls=%v", r, f.calls)
	}
	if !f.called("ValidateFinal") {
		t.Fatalf("runtime/service/config validation did not finish: %v", f.calls)
	}
}

func TestExecute_UILaunchFailureDoesNotRollbackValidReinstall(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	f := newFake()
	f.completionStatus = remoteSupportUILaunchFailedStatus
	r := ExecutePlan(plan, safeParams(t), f, true)
	if r.OK || r.Code != ExitValidationError || r.Message != remoteSupportUILaunchFailedStatus {
		t.Fatalf("UI launch failure status is incorrect: %+v", r)
	}
	if r.Rollback != nil || f.called("Undo:PromoteFiles") {
		t.Fatalf("UI-only failure rolled back valid runtime: result=%+v calls=%v", r, f.calls)
	}
}

func TestExecute_UILaunchFailureIncludesDiagnosticWithoutRollback(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	f := newFake()
	f.completionStatus = remoteSupportUILaunchFailedStatus
	f.completionDetail = `agent_session_id=0 active_interactive_session_id=7 failure_reason="no usable main window"`
	r := ExecutePlan(plan, safeParams(t), f, true)
	if r.OK || r.Code != ExitValidationError {
		t.Fatalf("UI launch failure status is incorrect: %+v", r)
	}
	if !strings.Contains(r.Message, f.completionDetail) {
		t.Fatalf("UI launch diagnostic was lost: %q", r.Message)
	}
	if r.Rollback != nil || f.called("Undo:PromoteFiles") {
		t.Fatalf("diagnostic-only change triggered rollback: result=%+v calls=%v", r, f.calls)
	}
}

func TestCrossCheckManifestRefusesNoncanonicalServiceAndEntrypoint(t *testing.T) {
	p := safeParams(t)
	payload, err := os.ReadFile(p.PayloadPath)
	if err != nil {
		t.Fatal(err)
	}
	manifestBytes, err := os.ReadFile(p.BundleManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := ParseBundleManifest(manifestBytes)
	if err != nil {
		t.Fatal(err)
	}

	for name, mutate := range map[string]func(*BundleManifest, *ExecuteParams){
		"service args": func(m *BundleManifest, _ *ExecuteParams) { m.ServiceArguments = []string{"--anything"} },
		"nested entrypoint": func(m *BundleManifest, _ *ExecuteParams) {
			m.Entrypoint = "TECHI Remote Support/nested/TECHI Remote Support.exe"
			m.ExpectedRelativeFiles[0].Path = m.Entrypoint
		},
		"exe target": func(_ *BundleManifest, p *ExecuteParams) { p.ExpectedExePath = `C:\Other\TECHI Remote Support.exe` },
	} {
		t.Run(name, func(t *testing.T) {
			copyManifest := *manifest
			copyManifest.ExpectedRelativeFiles = append([]BundleFile(nil), manifest.ExpectedRelativeFiles...)
			copyParams := p
			mutate(&copyManifest, &copyParams)
			if err := CrossCheckManifest(copyParams, &copyManifest, payload, manifestBytes); err == nil {
				t.Fatal("expected canonical identity refusal")
			}
		})
	}
}
