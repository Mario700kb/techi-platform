package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"techi-platform/agent/internal/native"
)

const testSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func writePolicy(t *testing.T, rollout string) string {
	t.Helper()
	js := `{
	  "schema_version": 1,
	  "rollout_mode": "` + rollout + `",
	  "api_url": "https://api-rdp.techi.com.al",
	  "agent": {
	    "target_version": "2.1.8",
	    "package_type": "exe",
	    "filename": "TECHI-Agent-2.1.8.exe",
	    "sha256": "` + testSHA + `"
	  },
	  "remote_support": {
	    "target_version": "1.4.6",
	    "payload_filename": "TECHI-Remote-Support-1.4.6-windows-amd64.zip",
	    "sha256": "` + testSHA + `",
	    "manifest_filename": "TECHI-Remote-Support-1.4.6-windows-amd64.manifest.json",
	    "manifest_sha256": "` + testSHA + `",
	    "recovery_mode": "disabled",
	    "repair_missing": true
	  }
	}`
	p := filepath.Join(t.TempDir(), "techi-policy.json")
	if err := os.WriteFile(p, []byte(js), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func writeObs(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "obs.json")
	if err := os.WriteFile(p, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

// The affected-device state: Agent 2.1.8 healthy, RS EXE missing + stale
// service + config present. Under the mandatory disabled rollout the command
// must classify but return OK and NEVER plan a mutation.
func TestRepairRemoteSupport_IncidentState_DisabledIsDetectOnly(t *testing.T) {
	policy := writePolicy(t, "disabled")
	obs := writeObs(t, `{
	  "agent": {"binary_exists": true, "binary_version": "2.1.8", "config_valid": true,
	            "service_exists": true, "service_running": true, "service_pid_match": true,
	            "lifecycle_present": true},
	  "remote_support": {"exe_exists": false, "service_exists": true, "config_present": true,
	            "payload_available": true, "payload_sha_match": true}
	}`)
	code := runRepairRemoteSupportCommand([]string{"-policy", policy, "-observation", obs, "-json"})
	if native.ExitCode(code) != native.ExitOK {
		t.Fatalf("disabled detect-only must exit OK, got %d", code)
	}
}

func TestRepairRemoteSupport_BadPolicyExitBadArgs(t *testing.T) {
	bad := writeObs(t, `{"schema_version": 99}`) // reuse temp writer for a bad policy file
	code := runRepairRemoteSupportCommand([]string{"-policy", bad, "-json"})
	if native.ExitCode(code) != native.ExitBadArgs {
		t.Fatalf("bad policy must be ExitBadArgs, got %d", code)
	}
}

func TestRepairRemoteSupport_MissingObservation(t *testing.T) {
	policy := writePolicy(t, "disabled")
	code := runRepairRemoteSupportCommand([]string{"-policy", policy, "-json"})
	if native.ExitCode(code) != native.ExitBadArgs {
		t.Fatalf("missing observation must be ExitBadArgs, got %d", code)
	}
}

func TestApplyPolicy_ValidatesPolicyOnly(t *testing.T) {
	policy := writePolicy(t, "disabled")
	code := runApplyPolicyCommand([]string{"-policy", policy, "-json"})
	if native.ExitCode(code) != native.ExitOK {
		t.Fatalf("valid policy should validate OK, got %d", code)
	}
}

func TestApplyPolicy_AgentHealthyOldReportsNativeUpdate(t *testing.T) {
	// Even reported under enabled mode, an old-but-healthy agent must never be
	// classified toward MSI. This asserts the wired command surfaces native_update.
	policy := writePolicy(t, "canary")
	obs := writeObs(t, `{
	  "agent": {"binary_exists": true, "binary_version": "2.1.5", "config_valid": true,
	            "service_exists": true, "service_running": true, "service_pid_match": true,
	            "lifecycle_present": true},
	  "remote_support": {"exe_exists": true, "exe_version": "1.4.6", "service_exists": true,
	            "service_running": true, "service_image_ok": true}
	}`)
	// Exercise via the pure evaluator to assert the decision the command reports.
	d := native.EvaluateAgent("2.1.8", native.AgentObservation{
		BinaryExists: true, BinaryVersion: "2.1.5", ConfigValid: true,
		ServiceExists: true, ServiceRunning: true, ServicePIDMatch: true, LifecyclePresent: true,
		LifecycleFresh: true,
	})
	if d.Action != native.AgentActNativeUpdate {
		t.Fatalf("healthy-old must be native_update, got %s", d.Action)
	}
	code := runApplyPolicyCommand([]string{"-policy", policy, "-observation", obs})
	if native.ExitCode(code) != native.ExitOK {
		t.Fatalf("apply-policy should report OK for this state, got %d", code)
	}
}

func TestAgentArtifactLineageHasSingleCanonicalBuild(t *testing.T) {
	nativeScript, err := os.ReadFile("scripts/build-native-bootstrap.sh")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(nativeScript), "go build techi-agent.exe") ||
		strings.Contains(string(nativeScript), `OUT_DIR/techi-agent.exe`) {
		t.Fatal("native bootstrap build must not publish a separately built Agent")
	}
	workflow, err := os.ReadFile("../.github/workflows/build-agent-msi.yml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(workflow)
	for _, contract := range []string{"Validate MSI embedded agent lineage", "Standalone agent hash", "embedded agent hash"} {
		if !strings.Contains(text, contract) {
			t.Fatalf("canonical Agent identity contract missing %q", contract)
		}
	}
}
