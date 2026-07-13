package main

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"techi-platform/agent/internal/native"
)

func TestResolveObservation_Fixture(t *testing.T) {
	p := filepath.Join(t.TempDir(), "obs.json")
	if err := os.WriteFile(p, []byte(`{
	  "agent": {"binary_exists": true, "binary_version": "2.1.8"},
	  "remote_support": {"exe_exists": false, "service_exists": true, "config_present": true}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	obs, err := resolveObservation(p, native.ExecuteParams{})
	if err != nil {
		t.Fatalf("fixture load failed: %v", err)
	}
	if obs.ExeExists || !obs.ServiceExists || !obs.ConfigPresent {
		t.Fatalf("fixture not parsed into RS observation: %+v", obs)
	}
}

func TestResolveObservation_RejectsUnknownFields(t *testing.T) {
	p := filepath.Join(t.TempDir(), "obs.json")
	// A secret-looking unknown field must be rejected, not silently ignored.
	_ = os.WriteFile(p, []byte(`{"remote_support": {}, "enrollment_token": "x"}`), 0o600)
	if _, err := resolveObservation(p, native.ExecuteParams{}); err == nil {
		t.Fatalf("expected rejection of unknown field")
	}
}

func TestParamsBuilder_DefaultsExeUnderInstallDir(t *testing.T) {
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	rf := addRSFlags(fs)
	_ = fs.Parse(nil)
	policy := &native.Policy{
		RemoteSupport: native.RemoteSupportPolic{
			TargetVersion: "1.4.6", PayloadFilename: "rs.zip",
			SHA256:           "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			ManifestFilename: "rs.manifest.json",
			ManifestSHA256:   "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		},
	}
	p := rf.params(policy, `C:\ProgramData\TechiAgent\bootstrap\techi-policy.json`)
	p.BootRetryCmd = selfBootRetryCommand(p)
	if filepath.Base(p.ExpectedExePath) != "TECHI Remote Support.exe" {
		t.Fatalf("exe should default under install dir, got %q", p.ExpectedExePath)
	}
	if p.ServiceName != "TECHI Remote Support" {
		t.Fatalf("service default wrong: %q", p.ServiceName)
	}
	if p.BootRetryCmd == "" {
		t.Fatalf("boot retry command should be populated")
	}
	for _, required := range []string{"--policy", "--artifact-dir", "--device-id", "--rs-service", "--rs-install-dir", "--rs-exe", "--rs-tray-task", "--staging-root", "--backup-root", "--retry-owner techi-bootstrap", "--execute", "--json"} {
		if !strings.Contains(p.BootRetryCmd, required) {
			t.Errorf("retry command missing %q: %s", required, p.BootRetryCmd)
		}
	}
}
