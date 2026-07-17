package main

import (
	"context"
	"strings"
	"testing"
)

func TestBootstrapLockedRuntimeUsesCurrentReinstallAndPreservesPlaintextIdentity(t *testing.T) {
	content := []byte("id = '90498408'\nenc_id = ''\npassword = 'encrypted-password'\nsalt = 'verified-salt'\n")
	materialized, id, err := materializeRustDeskRepairIdentity(content, "")
	if err != nil {
		t.Fatal(err)
	}
	fields := parseTOMLTopLevel(string(materialized))
	if id != "90498408" || fields["id"] != "90498408" || fields["enc_id"] != "" {
		t.Fatalf("plaintext identity changed: id=%q fields=%v", id, fields)
	}

	called := false
	result := executeBootstrapRemoteSupportRecovery(
		context.Background(),
		&Config{RustDeskID: "90498408"},
		"locked_runtime",
		map[string]interface{}{
			"remote_support_msi_version":  "1.4.8",
			"remote_support_msi_filename": "techi-remote-support-bootstrap.msi",
			"remote_support_msi_sha256":   strings.Repeat("a", 64),
		},
		func(_ context.Context, cfg *Config, params map[string]interface{}) actionResult {
			called = true
			if cfg.RustDeskID != "90498408" || params["remote_support_msi_version"] != "1.4.8" {
				t.Fatalf("handler received cfg=%+v params=%v", cfg, params)
			}
			return actionResult{message: "TECHI Remote Support reinstalled: id=90498408"}
		},
	)
	if !called || result.err != nil || !strings.Contains(result.message, "id=90498408") {
		t.Fatalf("called=%t result=%+v", called, result)
	}
}

func TestBootstrapRemoteSupportRefusesHealthyState(t *testing.T) {
	called := false
	result := executeBootstrapRemoteSupportRecovery(
		context.Background(), &Config{}, "healthy", nil,
		func(context.Context, *Config, map[string]interface{}) actionResult {
			called = true
			return actionResult{}
		},
	)
	if called || result.err == nil {
		t.Fatalf("called=%t result=%+v", called, result)
	}
}
