package native

// AgentClassification is the state the Agent policy evaluator assigns. It
// encodes the incident's hard rule: a HEALTHY-but-old Agent must NEVER be
// touched by the MSI — only the native updater — and a single transient
// lifecycle read must not be mistaken for a damaged install.
type AgentClassification string

const (
	AgentAbsent         AgentClassification = "absent"          // A: not installed — MSI first-install
	AgentLifecycleFlap  AgentClassification = "lifecycle_flap"  // B: healthy but lifecycle file transiently missing — bounded retry
	AgentHealthyOld     AgentClassification = "healthy_old"     // C: healthy, older than target — native updater ONLY
	AgentHealthyCurrent AgentClassification = "healthy_current" // D: healthy, equals target — no-op
	AgentHealthyNewer   AgentClassification = "healthy_newer"   // E: healthy, newer than target — no downgrade
	AgentServiceMissing AgentClassification = "service_missing" // F: valid binary/config, service gone — recreate service
	AgentDamaged        AgentClassification = "damaged"         // G: binary missing/corrupt/irreparable — MSI repair
)

// AgentAction is the concrete step the evaluator prescribes. There is exactly
// one MSI path (first-install/repair) and exactly one native-update path.
type AgentAction string

const (
	AgentActNoop            AgentAction = "noop"
	AgentActMSIFirstInstall AgentAction = "msi_first_install" // A only
	AgentActNativeUpdate    AgentAction = "native_update"     // C only — the swapAgentBinary path
	AgentActRetryLifecycle  AgentAction = "retry_lifecycle"   // B — bounded re-read, no install
	AgentActRecreateService AgentAction = "recreate_service"  // F — recreate service, then validate
	AgentActMSIRepair       AgentAction = "msi_repair"        // G only
	AgentActRefuseDowngrade AgentAction = "refuse_downgrade"  // E
)

// AgentObservation is the reduced device state the evaluator reasons over.
type AgentObservation struct {
	BinaryExists     bool   `json:"binary_exists"`
	BinaryVersion    string `json:"binary_version"`
	ConfigValid      bool   `json:"config_valid"`
	ServiceExists    bool   `json:"service_exists"`
	ServiceRunning   bool   `json:"service_running"`
	ServicePIDMatch  bool   `json:"service_pid_match"` // SCM PID matches the running agent's lifecycle PID
	LifecyclePresent bool   `json:"lifecycle_present"` // lifecycle state file readable this cycle
	LifecycleRetries int    `json:"lifecycle_retries"` // how many bounded retries already spent this run
	BinaryCorrupt    bool   `json:"binary_corrupt"`    // binary present but failed integrity/exec probe
}

// AgentDecision is the evaluator's deterministic output.
type AgentDecision struct {
	Classification AgentClassification
	Action         AgentAction
	Note           string
}

// maxLifecycleRetries bounds the transient-lifecycle re-read so a genuinely
// broken install is eventually reclassified rather than looping forever.
const maxLifecycleRetries = 3

// EvaluateAgent is the pure Agent update decision (states A–H). It guarantees:
//   - a healthy Agent older than target is updated ONLY natively (never MSI),
//   - a transient missing lifecycle file gets a bounded retry, not a reinstall,
//   - a missing/damaged install keeps the MSI first-install/repair path,
//   - never a downgrade.
func EvaluateAgent(target string, obs AgentObservation) AgentDecision {
	// A: nothing installed → MSI first-install.
	if !obs.BinaryExists {
		return AgentDecision{AgentAbsent, AgentActMSIFirstInstall, "agent binary absent; MSI first-install"}
	}
	// G: binary present but corrupt/irreparable → MSI repair.
	if obs.BinaryCorrupt {
		return AgentDecision{AgentDamaged, AgentActMSIRepair, "agent binary corrupt; MSI repair"}
	}

	healthyRuntime := obs.ServiceExists && obs.ServiceRunning && obs.ServicePIDMatch

	// B: service is healthy and PID matches, but the lifecycle file was not
	// readable this cycle. This is the incident's false-damaged trap: retry a
	// bounded number of times; do NOT reinstall on one transient read.
	if healthyRuntime && !obs.LifecyclePresent {
		if obs.LifecycleRetries < maxLifecycleRetries {
			return AgentDecision{AgentLifecycleFlap, AgentActRetryLifecycle,
				"lifecycle file transiently missing on a healthy service; bounded retry"}
		}
		// Retries exhausted with a running, PID-matched service: still not a
		// reinstall candidate — recreate/validate rather than MSI.
		return AgentDecision{AgentServiceMissing, AgentActRecreateService,
			"lifecycle unreadable after bounded retries but service healthy; validate/recreate, no MSI"}
	}

	// F: valid binary + config but the service is gone → recreate service.
	if obs.ConfigValid && !obs.ServiceExists {
		return AgentDecision{AgentServiceMissing, AgentActRecreateService,
			"valid binary/config but service missing; recreate service"}
	}

	// From here the runtime is considered healthy enough to compare versions.
	cmp := CompareVersions(obs.BinaryVersion, target)
	switch {
	case cmp == 0:
		return AgentDecision{AgentHealthyCurrent, AgentActNoop, "agent at target; no-op"} // D
	case cmp > 0:
		return AgentDecision{AgentHealthyNewer, AgentActRefuseDowngrade, "installed agent newer than target; refuse downgrade"} // E
	default:
		// C: healthy and older than target → native updater ONLY. This is the
		// single most important rule from the incident.
		return AgentDecision{AgentHealthyOld, AgentActNativeUpdate,
			"healthy agent older than target; native self-update only (never MSI)"} // C
	}
}
