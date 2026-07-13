package native

import (
	"fmt"
	"testing"
	"time"
)

// fakeExecutor records the exact primitive calls (with key args) and can be
// told to fail a specific step, so the orchestrator's ordering, dry-run gating,
// rollback, and refusal behaviour are all testable off Windows.
type fakeExecutor struct {
	calls   []string
	failOn  map[string]error
	killExe string // records the exact path passed to StopProcessExact
}

func newFake() *fakeExecutor { return &fakeExecutor{failOn: map[string]error{}} }

func (f *fakeExecutor) note(name string) error {
	f.calls = append(f.calls, name)
	if err, ok := f.failOn[name]; ok {
		return err
	}
	return nil
}
func (f *fakeExecutor) VerifyPayload(string, string) error { return f.note("VerifyPayload") }
func (f *fakeExecutor) PreserveConfig(string) error        { return f.note("PreserveConfig") }
func (f *fakeExecutor) StopService(string) error           { return f.note("StopService") }
func (f *fakeExecutor) StopTray(string) error              { return f.note("StopTray") }
func (f *fakeExecutor) StopProcessExact(exe string, _ time.Duration) error {
	f.killExe = exe
	return f.note("StopProcessExact")
}
func (f *fakeExecutor) RemoveStaleService(string) error { return f.note("RemoveStaleService") }
func (f *fakeExecutor) CleanupTmp(string) error         { return f.note("CleanupTmp") }
func (f *fakeExecutor) StagePayload(string, string, string) error {
	return f.note("StagePayload")
}
func (f *fakeExecutor) PromoteFiles(string, string) error { return f.note("PromoteFiles") }
func (f *fakeExecutor) RestoreConfig(string) error        { return f.note("RestoreConfig") }
func (f *fakeExecutor) CreateService(string, string) error {
	return f.note("CreateService")
}
func (f *fakeExecutor) StartService(string) error      { return f.note("StartService") }
func (f *fakeExecutor) ScheduleBootRetry(string) error { return f.note("ScheduleBootRetry") }
func (f *fakeExecutor) ValidateFinal(ExecuteParams) error {
	return f.note("ValidateFinal")
}
func (f *fakeExecutor) Rollback(string) error { return f.note("Rollback") }

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

func safeParams() ExecuteParams {
	return ExecuteParams{
		Component:       "remote_support",
		ServiceName:     "RustDesk",
		InstallDir:      `C:\Program Files\TECHI Remote Support`,
		ExpectedExePath: `C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`,
		ExpectedVersion: "1.4.6",
		PayloadPath:     `C:\ProgramData\TechiAgent\payloads\rs.zip`,
		PayloadSHA:      goodSHA,
		StagingRoot:     `C:\ProgramData\TechiAgent\staging`,
		ProcessWait:     time.Second,
	}
}

func staleServiceObs() RSObservation {
	return withPayload(RSObservation{ServiceExists: true, ConfigPresent: true, StaleTmpFiles: true})
}

func TestExecute_DisabledNoMutation(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutDisabled, "1.4.6", staleServiceObs())
	f := newFake()
	r := ExecutePlan(plan, safeParams(), f, true) // execute=true, but plan is detect-only
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
	r := ExecutePlan(plan, safeParams(), f, false) // execute=false
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
	r := ExecutePlan(plan, safeParams(), f, true)
	if r.Code != ExitOK {
		t.Fatalf("want ExitOK, got %v (%s)", r.Code, r.Message)
	}
	for _, want := range []string{"VerifyPayload", "PreserveConfig", "StopService",
		"RemoveStaleService", "CleanupTmp", "StagePayload", "PromoteFiles",
		"RestoreConfig", "CreateService", "StartService", "ValidateFinal"} {
		if !f.called(want) {
			t.Errorf("expected %s to be called; calls=%v", want, f.calls)
		}
	}
}

func TestExecute_ServiceMissingRecreateOnly(t *testing.T) {
	obs := withPayload(RSObservation{ExeExists: true, ExeVersion: "1.4.6"})
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", obs)
	f := newFake()
	ExecutePlan(plan, safeParams(), f, true)
	if f.called("PromoteFiles") {
		t.Fatalf("service_missing must not touch files: %v", f.calls)
	}
	if !f.called("CreateService") || !f.called("StartService") {
		t.Fatalf("must recreate+start service: %v", f.calls)
	}
}

func TestExecute_LockedPendingRebootOneRetryNoPromote(t *testing.T) {
	obs := withPayload(RSObservation{
		ExeExists: true, ExeVersion: "1.4.5", ServiceExists: true,
		TrayRunning: true, FilesLocked: true, PendingReboot: true, ConfigPresent: true,
	})
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", obs)
	f := newFake()
	r := ExecutePlan(plan, safeParams(), f, true)
	if r.Code != ExitPendingReboot {
		t.Fatalf("want ExitPendingReboot, got %v", r.Code)
	}
	if f.called("PromoteFiles") {
		t.Fatalf("must not promote files while reboot pending: %v", f.calls)
	}
	if f.count("ScheduleBootRetry") != 1 {
		t.Fatalf("exactly one boot retry expected, got %d", f.count("ScheduleBootRetry"))
	}
	if f.killExe != safeParams().ExpectedExePath {
		t.Fatalf("process kill must use exact expected exe path, got %q", f.killExe)
	}
}

func TestExecute_RollbackOnValidationFailure(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	f := newFake()
	f.failOn["ValidateFinal"] = fmt.Errorf("service not running")
	r := ExecutePlan(plan, safeParams(), f, true)
	if r.Code != ExitValidationError {
		t.Fatalf("want ExitValidationError, got %v", r.Code)
	}
	if !f.called("Rollback") {
		t.Fatalf("failed validation after promote must roll back: %v", f.calls)
	}
}

func TestExecute_BadSHARefusesEarly(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	f := newFake()
	f.failOn["VerifyPayload"] = fmt.Errorf("sha mismatch")
	r := ExecutePlan(plan, safeParams(), f, true)
	if r.Code != ExitIdentityFailed {
		t.Fatalf("want ExitIdentityFailed, got %v", r.Code)
	}
	if f.called("StopService") || f.called("PromoteFiles") || f.called("Rollback") {
		t.Fatalf("no mutation may follow a failed payload verify: %v", f.calls)
	}
}

func TestExecute_RefusesUnsafeInstallTarget(t *testing.T) {
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", staleServiceObs())
	p := safeParams()
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
	p := safeParams()
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
	ExecutePlan(plan, safeParams(), f, true)
	if !f.called("PreserveConfig") || !f.called("RestoreConfig") {
		t.Fatalf("config must be preserved+restored: %v", f.calls)
	}
}
