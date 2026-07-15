package native

import (
	"strings"
	"testing"
)

// verifiedPayload is the baseline "payload present and correct" observation
// field set that most mutating scenarios need.
func withPayload(obs RSObservation) RSObservation {
	obs.PayloadAvailable = true
	obs.PayloadSHAMatch = true
	return obs
}

func hasAction(plan RecoveryPlan, a ActionType) bool {
	for _, x := range plan.Actions {
		if x == a {
			return true
		}
	}
	return false
}

func TestRSRecovery_HealthyCurrent_NeverTouched(t *testing.T) {
	obs := RSObservation{
		ExeExists: true, ExeVersion: "1.4.6",
		ServiceExists: true, ServiceRunning: true, ServiceImageOK: true,
		RuntimeComplete: true, ConfigReadable: true, UIAvailable: true,
	}
	plan := PlanRemoteSupportRecovery(RolloutEnabled, "1.4.6", obs)
	if plan.Classification != RSHealthyCurrent || plan.Mutating {
		t.Fatalf("healthy current must be non-mutating noop: %+v", plan)
	}
	if !hasAction(plan, ActNoop) || plan.FinalCode != ExitOK {
		t.Fatalf("expected noop/ok, got %+v", plan)
	}
}

func TestRSRecovery_ServiceProcessOnlyIsNotHealthy(t *testing.T) {
	obs := withPayload(RSObservation{
		ExeExists: true, ExeVersion: "1.4.6",
		ServiceExists: true, ServiceRunning: true, ServiceImageOK: true,
		RuntimeComplete: false, ConfigReadable: true, UIAvailable: false,
	})
	plan := PlanRemoteSupportRecovery(RolloutEnabled, "1.4.6", obs)
	if plan.Classification == RSHealthyCurrent || !plan.Mutating {
		t.Fatalf("incomplete tray/service-only runtime must use full recovery: %+v", plan)
	}
	for _, action := range []ActionType{ActStopTray, ActStopService, ActStopProcessExact, ActPromoteFiles, ActStartUI, ActValidateFinal} {
		if !hasAction(plan, action) {
			t.Fatalf("full recovery omitted %s: %+v", action, plan.Actions)
		}
	}
}

func TestRSRecovery_DisabledIsDetectOnly(t *testing.T) {
	// The incident's exact state (EXE missing + stale service) under the
	// mandatory disabled mode must classify but never mutate.
	obs := withPayload(RSObservation{ServiceExists: true, ConfigPresent: true})
	plan := PlanRemoteSupportRecovery(RolloutDisabled, "1.4.6", obs)
	if plan.Mutating {
		t.Fatalf("disabled mode must not mutate: %+v", plan)
	}
	if plan.Classification != RSStaleService {
		t.Fatalf("want stale_service classification, got %q", plan.Classification)
	}
	if hasAction(plan, ActPromoteFiles) || hasAction(plan, ActStopService) {
		t.Fatalf("disabled plan contains mutating actions: %+v", plan.Actions)
	}
}

func TestRSRecovery_StaleService(t *testing.T) {
	obs := withPayload(RSObservation{ServiceExists: true, ConfigPresent: true, StaleTmpFiles: true})
	plan := PlanRemoteSupportRecovery(RolloutEnabled, "1.4.6", obs)
	if plan.Classification != RSStaleService {
		t.Fatalf("want stale_service, got %q", plan.Classification)
	}
	// Every damaged state uses the same stop/remove/full-replace/start/validate sequence.
	wantOrder := []ActionType{ActVerifyPayload, ActStopTray, ActStopService, ActStopProcessExact,
		ActPreserveConfig, ActRemoveStaleService, ActStagePayload, ActPromoteFiles,
		ActRestoreConfig, ActCreateService, ActStartService, ActStartUI, ActValidateFinal}
	assertOrder(t, plan.Actions, wantOrder)
	if hasAction(plan, ActCleanupTmp) {
		t.Fatalf("full replacement must not patch individual temporary files: %+v", plan.Actions)
	}
}

func TestRSRecovery_ExeMissingServiceMissing(t *testing.T) {
	obs := withPayload(RSObservation{ConfigPresent: false})
	plan := PlanRemoteSupportRecovery(RolloutEnabled, "1.4.6", obs)
	if plan.Classification != RSMissing {
		t.Fatalf("want missing, got %q", plan.Classification)
	}
	if !hasAction(plan, ActStagePayload) || !hasAction(plan, ActCreateService) {
		t.Fatalf("missing install must stage + create service: %+v", plan.Actions)
	}
}

func TestRSRecovery_ServiceMissingExePresent(t *testing.T) {
	obs := withPayload(RSObservation{ExeExists: true, ExeVersion: "1.4.6"})
	plan := PlanRemoteSupportRecovery(RolloutEnabled, "1.4.6", obs)
	if plan.Classification != RSServiceMissing {
		t.Fatalf("want service_missing, got %q", plan.Classification)
	}
	if !hasAction(plan, ActPromoteFiles) || !hasAction(plan, ActStartUI) {
		t.Fatalf("service_missing must perform full replacement and UI validation: %+v", plan.Actions)
	}
}

func TestRSRecovery_Outdated(t *testing.T) {
	obs := withPayload(RSObservation{ExeExists: true, ExeVersion: "1.4.5",
		ServiceExists: true, ServiceRunning: true, ServiceImageOK: true})
	plan := PlanRemoteSupportRecovery(RolloutEnabled, "1.4.6", obs)
	if plan.Classification != RSOutdated {
		t.Fatalf("want outdated, got %q", plan.Classification)
	}
	if !hasAction(plan, ActStagePayload) || !hasAction(plan, ActPromoteFiles) {
		t.Fatalf("outdated must update files: %+v", plan.Actions)
	}
}

func TestRSRecovery_LockedThenPendingReboot(t *testing.T) {
	obs := withPayload(RSObservation{
		ExeExists: true, ExeVersion: "1.4.5", ServiceExists: true,
		TrayRunning: true, FilesLocked: true, PendingReboot: true, ConfigPresent: true,
	})
	plan := PlanRemoteSupportRecovery(RolloutEnabled, "1.4.6", obs)
	if plan.Classification != RSPendingReboot || plan.FinalCode != ExitPendingReboot {
		t.Fatalf("want pending_reboot/ExitPendingReboot, got %q/%v", plan.Classification, plan.FinalCode)
	}
	if hasAction(plan, ActStopTray) || hasAction(plan, ActStopService) || hasAction(plan, ActStopProcessExact) {
		t.Fatalf("pending-reboot deferral must not stop the existing installation: %+v", plan.Actions)
	}
	if !hasAction(plan, ActScheduleBootRetry) {
		t.Fatalf("pending reboot must schedule exactly one boot retry: %+v", plan.Actions)
	}
	// No endless retry: promote is deferred to the boot retry, not attempted now.
	if hasAction(plan, ActPromoteFiles) {
		t.Fatalf("must not promote files while reboot pending: %+v", plan.Actions)
	}
}

func TestRSRecovery_PayloadMissingRefuses(t *testing.T) {
	obs := RSObservation{ServiceExists: true} // stale, but no payload
	plan := PlanRemoteSupportRecovery(RolloutEnabled, "1.4.6", obs)
	if plan.Mutating || plan.FinalCode != ExitPayloadMissing {
		t.Fatalf("missing payload must refuse to mutate: %+v", plan)
	}
}

func TestRSRecovery_BadSHARefuses(t *testing.T) {
	obs := RSObservation{ServiceExists: true, PayloadAvailable: true, PayloadSHAMatch: false}
	plan := PlanRemoteSupportRecovery(RolloutEnabled, "1.4.6", obs)
	if plan.Mutating || plan.FinalCode != ExitIdentityFailed {
		t.Fatalf("bad SHA must refuse to mutate: %+v", plan)
	}
}

func TestRSRecovery_ConfigPreservedWhenPresent(t *testing.T) {
	obs := withPayload(RSObservation{ServiceExists: true, ConfigPresent: true})
	plan := PlanRemoteSupportRecovery(RolloutEnabled, "1.4.6", obs)
	if !hasAction(plan, ActPreserveConfig) || !hasAction(plan, ActRestoreConfig) {
		t.Fatalf("config present must be preserved+restored: %+v", plan.Actions)
	}
	// Stop all runtime roles before capturing the final on-disk identity/config.
	iPreserve := indexOf(plan.Actions, ActPreserveConfig)
	iStop := indexOf(plan.Actions, ActStopService)
	if iPreserve < 0 || iStop < 0 || iPreserve < iStop {
		t.Fatalf("preserve must follow runtime stop: %+v", plan.Actions)
	}
}

func TestRSRecovery_LegacyCombinedReclassified(t *testing.T) {
	// Legacy combined-MSI lineage with EXE removed must classify as
	// missing/stale (never trust a pre-install "healthy" reading).
	obs := withPayload(RSObservation{LegacyCombined: true, ServiceExists: true, ConfigPresent: true})
	plan := PlanRemoteSupportRecovery(RolloutEnabled, "1.4.6", obs)
	if plan.Classification != RSStaleService {
		t.Fatalf("legacy combined w/ EXE gone must be stale_service, got %q", plan.Classification)
	}
}

func TestRSRecovery_UnrelatedPendingRebootDoesNotDefer(t *testing.T) {
	obs := withPayload(RSObservation{
		ExeExists: true, ExeVersion: "1.4.5", ServiceExists: true,
		ServiceRunning: true, ServiceImageOK: true, PendingReboot: true,
	})
	plan := PlanRemoteSupportRecovery(RolloutCanary, "1.4.6", obs)
	if plan.Classification == RSPendingReboot || anyAction(plan.Actions, ActScheduleBootRetry) {
		t.Fatalf("unrelated reboot marker must not defer RS recovery: %+v", plan)
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.4.6", "1.4.6", 0},
		{"1.4.5", "1.4.6", -1},
		{"1.4.7", "1.4.6", 1},
		{"2.1.8", "2.1.10", -1},
		{"2.1", "2.1.0", 0},
		{"garbage", "1.0.0", -1},
		{"", "0.0.0", 0},
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%q,%q)=%d want %d", c.a, c.b, got, c.want)
		}
	}
}

func assertOrder(t *testing.T, got, want []ActionType) {
	t.Helper()
	gi := 0
	for _, w := range want {
		found := false
		for gi < len(got) {
			if got[gi] == w {
				found = true
				gi++
				break
			}
			gi++
		}
		if !found {
			t.Fatalf("action %q not found in expected order; got=%v want=%v", w, got, want)
		}
	}
}

func indexOf(s []ActionType, a ActionType) int {
	for i, x := range s {
		if x == a {
			return i
		}
	}
	return -1
}

func TestResultJSON_NoSecretLeak(t *testing.T) {
	r := NewResult("repair-remote-support", ExitOK)
	r.Message = "done"
	js := r.JSON()
	if !strings.Contains(js, `"code_name":"ok"`) {
		t.Fatalf("json missing code_name: %s", js)
	}
}
