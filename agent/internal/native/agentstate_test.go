package native

import "testing"

func healthyRuntime() AgentObservation {
	return AgentObservation{
		BinaryExists: true, ConfigValid: true,
		ServiceExists: true, ServiceRunning: true, ServicePIDMatch: true,
		LifecyclePresent: true, LifecycleFresh: true,
	}
}

func TestAgent_A_Absent_UsesMSIFirstInstall(t *testing.T) {
	d := EvaluateAgent("2.1.8", AgentObservation{})
	if d.Classification != AgentAbsent || d.Action != AgentActMSIFirstInstall {
		t.Fatalf("absent must be MSI first-install: %+v", d)
	}
}

func TestAgent_B_LifecycleFlap_BoundedRetryNotMSI(t *testing.T) {
	obs := healthyRuntime()
	obs.LifecyclePresent = false
	obs.LifecycleRetries = 0
	d := EvaluateAgent("2.1.8", obs)
	if d.Action != AgentActRetryLifecycle {
		t.Fatalf("transient lifecycle miss on healthy service must retry, not reinstall: %+v", d)
	}
	if d.Action == AgentActMSIRepair || d.Action == AgentActMSIFirstInstall {
		t.Fatalf("MUST NOT use MSI on a transient lifecycle read: %+v", d)
	}
}

func TestAgent_B_RetriesExhausted_NoMSI(t *testing.T) {
	obs := healthyRuntime()
	obs.LifecyclePresent = false
	obs.LifecycleRetries = maxLifecycleRetries
	d := EvaluateAgent("2.1.8", obs)
	if d.Action == AgentActMSIRepair || d.Action == AgentActMSIFirstInstall {
		t.Fatalf("even after retries a running PID-matched service must not use MSI: %+v", d)
	}
	if d.Action != AgentActRecreateService {
		t.Fatalf("want recreate_service, got %+v", d)
	}
}

func TestAgent_C_HealthyOld_NativeOnly(t *testing.T) {
	obs := healthyRuntime()
	obs.BinaryVersion = "2.1.5"
	d := EvaluateAgent("2.1.8", obs)
	if d.Classification != AgentHealthyOld || d.Action != AgentActNativeUpdate {
		t.Fatalf("healthy-old must be native update: %+v", d)
	}
	if d.Action == AgentActMSIRepair || d.Action == AgentActMSIFirstInstall {
		t.Fatalf("CRITICAL: healthy-old agent must NEVER use MSI: %+v", d)
	}
}

func TestAgent_D_Current_Noop(t *testing.T) {
	obs := healthyRuntime()
	obs.BinaryVersion = "2.1.8"
	d := EvaluateAgent("2.1.8", obs)
	if d.Classification != AgentHealthyCurrent || d.Action != AgentActNoop {
		t.Fatalf("current must be noop: %+v", d)
	}
}

func TestAgent_E_Newer_NoDowngrade(t *testing.T) {
	obs := healthyRuntime()
	obs.BinaryVersion = "2.2.0"
	d := EvaluateAgent("2.1.8", obs)
	if d.Classification != AgentHealthyNewer || d.Action != AgentActRefuseDowngrade {
		t.Fatalf("newer must refuse downgrade: %+v", d)
	}
}

func TestAgent_F_ServiceMissing_Recreate(t *testing.T) {
	obs := AgentObservation{BinaryExists: true, ConfigValid: true, BinaryVersion: "2.1.8", LifecyclePresent: true}
	d := EvaluateAgent("2.1.8", obs)
	if d.Classification != AgentServiceMissing || d.Action != AgentActRecreateService {
		t.Fatalf("valid binary but no service must recreate: %+v", d)
	}
}

func TestAgent_G_Corrupt_MSIRepair(t *testing.T) {
	obs := AgentObservation{BinaryExists: true, BinaryCorrupt: true}
	d := EvaluateAgent("2.1.8", obs)
	if d.Classification != AgentDamaged || d.Action != AgentActMSIRepair {
		t.Fatalf("corrupt binary must MSI-repair: %+v", d)
	}
}

func TestAgent_VersionCannotMaskUnhealthyRuntime(t *testing.T) {
	for name, mutate := range map[string]func(*AgentObservation){
		"stopped":         func(o *AgentObservation) { o.ServiceRunning = false },
		"pid mismatch":    func(o *AgentObservation) { o.ServicePIDMatch = false },
		"invalid config":  func(o *AgentObservation) { o.ConfigValid = false },
		"stale lifecycle": func(o *AgentObservation) { o.LifecycleFresh = false },
	} {
		t.Run(name, func(t *testing.T) {
			obs := healthyRuntime()
			obs.BinaryVersion = "2.1.8"
			mutate(&obs)
			d := EvaluateAgent("2.1.8", obs)
			if d.Classification == AgentHealthyCurrent || d.Action == AgentActNoop {
				t.Fatalf("unhealthy runtime reported current/noop: %+v", d)
			}
		})
	}
}
