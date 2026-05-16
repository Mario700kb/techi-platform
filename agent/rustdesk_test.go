package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfiguredRustDeskIDRejectsGeneratedAgentID(t *testing.T) {
	cfg := &Config{RustDeskID: "agent_Q79DLxgeFHnxlfTL5RxLWXmN"}

	if got := configuredRustDeskID(cfg); got != "" {
		t.Fatalf("expected generated agent id to be rejected, got %q", got)
	}
}

func TestBuildHeartbeatPayloadNeverFallsBackToAgentID(t *testing.T) {
	cfg := &Config{
		AgentID:    "agent_Q79DLxgeFHnxlfTL5RxLWXmN",
		RustDeskID: "agent_Q79DLxgeFHnxlfTL5RxLWXmN",
	}
	inv := &Inventory{Hostname: "win-test", Platform: "windows"}

	payload := buildHeartbeatPayload(cfg, inv, RustDeskInfo{}, nil, nil, nil, nil, nil)

	if payload.RustDeskID != "" {
		t.Fatalf("expected empty rustdesk_id when only agent id is available, got %q", payload.RustDeskID)
	}
}

func TestReadRustDeskFieldsFromFileParsesNumericID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "RustDesk2.toml")
	if err := os.WriteFile(path, []byte("\xef\xbb\xbf[options]\nid = \"123456789\" # current client id\n"), 0600); err != nil {
		t.Fatal(err)
	}

	id, _ := readRustDeskFieldsFromFile(path)
	if id != "123456789" {
		t.Fatalf("unexpected RustDesk ID: %q", id)
	}
}

func TestReadRustDeskFieldsFromFileCapturesEncID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "RustDesk2.toml")
	content := "[options]\nenc_id = \"AbCdEfGhIjKlMnOp\"\n"
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}

	id, encID := readRustDeskFieldsFromFile(path)
	if id != "" {
		t.Fatalf("expected empty numeric ID when only enc_id present, got %q", id)
	}
	if encID != "AbCdEfGhIjKlMnOp" {
		t.Fatalf("unexpected enc_id: %q", encID)
	}
}

func TestEncIDNotUsedAsRustDeskID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "RustDesk2.toml")
	content := "[options]\nenc_id = \"AbCdEfGhIjKlMnOp\"\n"
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}

	cfg := &Config{}
	info := discoverRustDeskPortable(RustDeskInfo{ID: configuredRustDeskID(cfg)})
	// enc_id must never surface as the numeric RustDesk ID
	if info.ID == "AbCdEfGhIjKlMnOp" {
		t.Fatal("enc_id must not be used as numeric RustDesk ID")
	}
}

func TestBuildHeartbeatPayloadIncludesEncID(t *testing.T) {
	cfg := &Config{}
	inv := &Inventory{Hostname: "win-test", Platform: "windows"}
	rdInfo := RustDeskInfo{ID: "", EncID: "AbCdEfGhIjKlMnOp"}

	payload := buildHeartbeatPayload(cfg, inv, rdInfo, nil, nil, nil, nil, nil)

	if payload.RustDeskID != "" {
		t.Fatalf("expected empty rustdesk_id when no numeric ID available, got %q", payload.RustDeskID)
	}
	if payload.RustDeskEncID != "AbCdEfGhIjKlMnOp" {
		t.Fatalf("expected enc_id to be forwarded, got %q", payload.RustDeskEncID)
	}
}
