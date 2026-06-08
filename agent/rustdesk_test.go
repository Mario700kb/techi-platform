package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeRustDeskIDStripsSpaces(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"1 235 009 710", "1235009710"},
		{"123456789", "123456789"},
		{"1 234 567 890", "1234567890"},
		{"  9 876 543 210  ", "9876543210"},
		{"AbCdEfGh", ""},
		{"enc_id_base64==", "64"}, // digits extracted; "64" is too short → rejected by isNumericRustDeskID
		{"", ""},
	}
	for _, c := range cases {
		got := normalizeRustDeskID(c.input)
		if got != c.want {
			t.Errorf("normalizeRustDeskID(%q) = %q, want %q", c.input, got, c.want)
		}
	}
}

func TestIsNumericRustDeskIDValidation(t *testing.T) {
	accept := []string{"12345", "123456789", "1235009710", "12345678901234567890"}
	for _, id := range accept {
		if !isNumericRustDeskID(id) {
			t.Errorf("expected %q to be accepted", id)
		}
	}
	reject := []string{"", "1234", "123456789012345678901", "AbCdEfGh", "agent_foo", "123abc456"}
	for _, id := range reject {
		if isNumericRustDeskID(id) {
			t.Errorf("expected %q to be rejected", id)
		}
	}
}

func TestIsUsableRustDeskIDRejectsNonNumeric(t *testing.T) {
	// base64 / enc_id strings must be rejected
	reject := []string{"AbCdEfGhIjKlMnOp", "enc_AbCd123=", "agent_foo", "pending_bar", ""}
	for _, id := range reject {
		if isUsableRustDeskID(id) {
			t.Errorf("expected %q to be rejected by isUsableRustDeskID", id)
		}
	}
	// plain numeric IDs must be accepted
	if !isUsableRustDeskID("1235009710") {
		t.Error("expected numeric ID 1235009710 to be accepted")
	}
}

func TestLocalRustDeskIDNormalizesUIFormat(t *testing.T) {
	// Simulates what --get-id outputs and verifies the full normalization pipeline.
	raw := "1 235 009 710"
	id := normalizeRustDeskID(raw)
	if id != "1235009710" {
		t.Fatalf("expected 1235009710, got %q", id)
	}
	if !isNumericRustDeskID(id) {
		t.Fatal("1235009710 should be a valid numeric RustDesk ID")
	}
}

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

func TestRustDeskConfigCandidatesIncludesTECHIProgramDataPath(t *testing.T) {
	// Production device #289 stores its config at:
	// C:\ProgramData\TECHI Remote Support\config\TECHI Remote Support.toml
	// Verify this path is always included in the candidates list.
	const fakeRoot = "/fake/ProgramData"
	t.Setenv("PROGRAMDATA", fakeRoot)

	candidates := rustDeskConfigCandidates()

	want := filepath.Join(fakeRoot, "TECHI Remote Support", "config", "TECHI Remote Support.toml")
	for _, c := range candidates {
		if c == want {
			return
		}
	}
	t.Errorf("config candidates do not include TECHI ProgramData path %q\ngot: %v", want, candidates)
}

func TestReadRustDeskFieldsFromTECHIProgramDataPath(t *testing.T) {
	// Verify that the TOML reader correctly parses an ID from the TECHI
	// Remote Support ProgramData config format found on production devices.
	dir := t.TempDir()
	configPath := filepath.Join(dir, "TECHI Remote Support.toml")
	content := "id = '1234567890'\n[options]\ncustom-rendezvous-server = 'relay.techi.example'\n"
	if err := os.WriteFile(configPath, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}

	id, _ := readRustDeskFieldsFromFile(configPath)
	if id != "1234567890" {
		t.Errorf("expected ID '1234567890' from TECHI ProgramData config, got %q", id)
	}
}
