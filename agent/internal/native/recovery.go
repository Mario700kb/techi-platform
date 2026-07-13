package native

import "strings"

// RSClassification is the state the Remote Support recovery planner assigns to
// an observed device. It mirrors the incident state machine (spec states A–I).
type RSClassification string

const (
	RSHealthyCurrent RSClassification = "healthy_current"  // A: correct version, service RUNNING, exact path — never touch
	RSMissing        RSClassification = "missing"          // B: EXE absent — install native payload
	RSStaleService   RSClassification = "stale_service"    // C: service exists but EXE missing — remove+recreate service, install
	RSServiceMissing RSClassification = "service_missing"  // D: EXE present but service absent — recreate service
	RSOutdated       RSClassification = "outdated"         // E: healthy but older than target — native update
	RSLocked         RSClassification = "locked"           // F: tray/process holds files — stop then retry
	RSPendingReboot  RSClassification = "pending_reboot"   // F': still locked after stop — one boot retry
	RSLegacyMigrate  RSClassification = "legacy_migration" // G: legacy combined-MSI lineage — reclassify after Agent ops
)

// ActionType is a single explicit, bounded recovery step. There is no generic
// "run script" step: every action names exactly what it does.
type ActionType string

const (
	ActPreserveConfig     ActionType = "preserve_config"      // capture RS id/config/password before any mutation
	ActVerifyPayload      ActionType = "verify_payload"       // SHA256 gate before touching disk
	ActStopService        ActionType = "stop_service"         // stop RS service by exact name
	ActStopTray           ActionType = "stop_tray"            // stop RS tray scheduled task
	ActStopProcessExact   ActionType = "stop_process_exact"   // terminate only processes whose image path is exact
	ActRemoveStaleService ActionType = "remove_stale_service" // delete a service whose EXE is gone
	ActStagePayload       ActionType = "stage_payload"        // expand verified bundle into staging/<component>/<version>
	ActPromoteFiles       ActionType = "promote_files"        // atomically move staged files into install dir
	ActCleanupTmp         ActionType = "cleanup_tmp"          // remove leftover TBD*.tmp from the failed MSI
	ActCreateService      ActionType = "create_service"       // (re)create the RS service pointing at exact EXE
	ActStartService       ActionType = "start_service"        // start the RS service
	ActRestoreConfig      ActionType = "restore_config"       // write preserved RS id/config back
	ActScheduleBootRetry  ActionType = "schedule_boot_retry"  // one bounded retry at next boot
	ActValidateFinal      ActionType = "validate_final"       // EXE+version+service RUNNING+exact path
	ActNoop               ActionType = "noop"                 // nothing to do
)

// RSObservation is the fully-materialised device state the planner reasons
// over. All Windows-specific probing happens in the wiring layer and is
// reduced to these plain fields so the decision logic is unit-testable.
type RSObservation struct {
	ExeExists       bool   `json:"exe_exists"`
	ExeVersion      string `json:"exe_version"` // parsed version of the installed EXE, if any
	ServiceExists   bool   `json:"service_exists"`
	ServiceRunning  bool   `json:"service_running"`
	ServiceImageOK  bool   `json:"service_image_ok"` // service image path matches the expected EXE exactly
	TrayRunning     bool   `json:"tray_running"`
	FilesLocked     bool   `json:"files_locked"`    // an install-dir file is held open (by tray/runtime)
	PendingReboot   bool   `json:"pending_reboot"`  // OS reports a pending reboot / rename operations queued
	StaleTmpFiles   bool   `json:"stale_tmp_files"` // TBD*.tmp remnants from the failed MSI transaction
	LegacyCombined  bool   `json:"legacy_combined"` // legacy combined-MSI product lineage detected
	OldUninstallReg bool   `json:"old_uninstall_reg"`
	ConfigPresent   bool   `json:"config_present"` // RS id/config exists and should be preserved

	// Payload availability is materialised so "payload missing" / "bad SHA"
	// are decision outcomes, not runtime surprises. The planner refuses any
	// mutation unless the payload is present AND verified.
	PayloadAvailable bool `json:"payload_available"`
	PayloadSHAMatch  bool `json:"payload_sha_match"`
}

// RecoveryPlan is the planner's deterministic output: a classification, an
// ordered action list, the final exit code the operation will return if the
// plan runs cleanly, and a human note. Actions are always ordered
// verify → preserve → stop → stage → promote → recreate → validate.
type RecoveryPlan struct {
	Classification RSClassification
	Actions        []ActionType
	FinalCode      ExitCode
	Note           string
	Mutating       bool // true when the plan changes device state
}

// PlanRemoteSupportRecovery is the pure Remote Support recovery decision. It
// never performs I/O. Given the policy target and an observation it returns the
// exact ordered plan, honouring rollout mode: when mode is disabled the plan is
// detect-and-report only (no mutating actions), matching the "rollout must stay
// disabled" constraint while still surfacing the classification.
func PlanRemoteSupportRecovery(mode RolloutMode, target string, obs RSObservation) RecoveryPlan {
	class := classifyRemoteSupport(target, obs)

	// A: healthy & current — never touch it.
	if class == RSHealthyCurrent {
		return RecoveryPlan{
			Classification: class,
			Actions:        []ActionType{ActNoop},
			FinalCode:      ExitOK,
			Note:           "Remote Support healthy and current; no action",
		}
	}

	// Detect-only when rollout is disabled: report the classification but never
	// mutate. This is the safe default and what the ~30 affected devices get
	// until a canary flips the mode.
	if mode == RolloutDisabled {
		return RecoveryPlan{
			Classification: class,
			Actions:        []ActionType{ActValidateFinal},
			FinalCode:      ExitOK,
			Note:           "rollout_mode=disabled: classified only, no mutation performed",
		}
	}

	// Any mutation requires a present, verified payload. This turns "payload
	// missing" and "bad SHA" into deterministic refusals BEFORE stopping any
	// service or touching any file — the opposite of the MSI repair loop.
	if !obs.PayloadAvailable {
		return RecoveryPlan{
			Classification: class,
			Actions:        []ActionType{ActVerifyPayload},
			FinalCode:      ExitPayloadMissing,
			Note:           "required Remote Support payload is missing; refusing to mutate",
		}
	}
	if !obs.PayloadSHAMatch {
		return RecoveryPlan{
			Classification: class,
			Actions:        []ActionType{ActVerifyPayload},
			FinalCode:      ExitIdentityFailed,
			Note:           "Remote Support payload SHA256 mismatch; refusing to mutate",
		}
	}

	plan := RecoveryPlan{Classification: class, Mutating: true, FinalCode: ExitOK}
	add := func(a ...ActionType) { plan.Actions = append(plan.Actions, a...) }

	// Identity gate + config preservation always come first.
	add(ActVerifyPayload)
	if obs.ConfigPresent {
		add(ActPreserveConfig)
	}

	// F: files locked by the tray/runtime. Stop exact-path processes and the
	// tray task first, never a name-only taskkill. If the OS still reports a
	// pending reboot, we do not fight locked files — we stage what we can,
	// schedule ONE boot retry, and return pending_reboot.
	if obs.TrayRunning {
		add(ActStopTray)
	}
	if obs.ServiceExists {
		add(ActStopService)
	}
	if obs.FilesLocked || class == RSLocked {
		add(ActStopProcessExact)
	}

	if obs.PendingReboot {
		add(ActStagePayload, ActScheduleBootRetry)
		plan.Classification = RSPendingReboot
		plan.FinalCode = ExitPendingReboot
		plan.Note = "files locked and reboot pending; staged payload and scheduled one boot retry"
		return plan
	}

	// C: stale service (service present, EXE gone). Remove the stale service
	// through the native manager before reinstalling — never leave a stale
	// service pointing at a missing EXE.
	if class == RSStaleService {
		add(ActRemoveStaleService)
	}
	if obs.StaleTmpFiles {
		add(ActCleanupTmp)
	}

	switch class {
	case RSServiceMissing:
		// D: EXE is fine; only the service is gone. Recreate + start, no file work.
		add(ActCreateService, ActStartService)
	default:
		// B/C/E/G: (re)stage and promote the native bundle, then (re)create the
		// service. Promotion is atomic; the wiring layer backs up + rolls back.
		add(ActStagePayload, ActPromoteFiles)
		if obs.ConfigPresent {
			add(ActRestoreConfig)
		}
		add(ActCreateService, ActStartService)
	}

	add(ActValidateFinal)
	plan.Note = "native Remote Support recovery: " + string(class)
	return plan
}

// classifyRemoteSupport maps an observation to a classification. Order matters:
// legacy-combined lineage is reclassified honestly (the pre-Agent-install
// classification is never trusted), and stale-service is distinguished from a
// plain missing install.
func classifyRemoteSupport(target string, obs RSObservation) RSClassification {
	switch {
	case !obs.ExeExists && obs.ServiceExists:
		// C: service entry survives but the EXE was removed (the incident's
		// exact state after the legacy combined-MSI uninstall took RS files).
		return RSStaleService
	case !obs.ExeExists:
		// B: nothing installed (or files fully gone). Legacy lineage is a hint
		// that RS ownership moved, but the concrete action is the same: install.
		return RSMissing
	case obs.ExeExists && !obs.ServiceExists:
		return RSServiceMissing // D
	case obs.FilesLocked || obs.TrayRunning && !obs.ServiceImageOK:
		return RSLocked // F
	case CompareVersions(obs.ExeVersion, target) < 0:
		return RSOutdated // E
	case obs.ServiceRunning && obs.ServiceImageOK && CompareVersions(obs.ExeVersion, target) >= 0:
		return RSHealthyCurrent // A
	default:
		// EXE present, version current, but service not cleanly RUNNING or image
		// path not exact: treat as service repair.
		return RSServiceMissing
	}
}

// CompareVersions compares two dotted X.Y.Z versions numerically. Returns -1,
// 0, or 1. Missing/short components are treated as 0; non-numeric components
// sort as 0 so a garbage version never accidentally reads as "newer".
func CompareVersions(a, b string) int {
	pa := parseVersion(a)
	pb := parseVersion(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x < y {
			return -1
		}
		if x > y {
			return 1
		}
	}
	return 0
}

func parseVersion(v string) []int {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ".")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		n := 0
		ok := len(p) > 0
		for _, r := range p {
			if r < '0' || r > '9' {
				ok = false
				break
			}
			n = n*10 + int(r-'0')
		}
		if !ok {
			n = 0
		}
		out = append(out, n)
	}
	return out
}
