package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureEnrollmentAcceptsExistingIdentityWithoutCredential(t *testing.T) {
	cfg := &Config{AgentID: "existing-agent", DeviceID: 11}
	inv := &Inventory{Hostname: "DESKTOP-IM4V3G4", Domain: "WORKGROUP", Platform: "windows"}

	if err := ensureEnrollment(cfg, filepath.Join(t.TempDir(), "agent.config.json"), inv, RustDeskInfo{}); err != nil {
		t.Fatalf("existing identity should not require a heartbeat credential: %v", err)
	}
}

func TestEnsureEnrollmentAcceptsExistingLegacy216Config(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "agent.config.json")
	cfg := &Config{
		BackendURL:       "https://techi.example/api/v1/agent/heartbeat",
		APIURL:           "https://techi.example",
		WebSocketURL:     "wss://techi.example/ws",
		AgentID:          "agent-216",
		DeviceID:         216,
		RustDeskID:       "90498408",
		TimeoutSeconds:   30,
		HeartbeatSeconds: 60,
		Retries:          3,
		RetryDelaySecond: 5,
	}
	inv := &Inventory{Hostname: "DESKTOP-216", Domain: "WORKGROUP", Platform: "windows"}

	if err := ensureEnrollment(cfg, configPath, inv, RustDeskInfo{}); err != nil {
		t.Fatalf("2.1.6-style config should start without re-enrollment: %v", err)
	}
}

func TestEnsureEnrollmentEnrollsWithoutCredentialFromBackend(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "agent.config.json")
	var enrollCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/agent/enroll" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		enrollCalls++
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		text := string(body)
		if !strings.Contains(text, `"enrollment_token":"reenroll-token"`) {
			t.Fatalf("expected enrollment token in reenrollment payload: %s", text)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"agent_id":"new-agent",
			"device_id":11,
			"heartbeat_url":"` + serverURLForTest(r) + `/api/v1/agent/heartbeat",
			"websocket_url":"wss://example.test/ws",
			"enrollment_status":"enrolled"
		}`))
	}))
	defer server.Close()

	cfg := &Config{
		APIURL:           server.URL,
		BackendURL:       server.URL + heartbeatPath,
		EnrollmentToken:  "reenroll-token",
		TimeoutSeconds:   5,
		HeartbeatSeconds: 60,
		Retries:          1,
	}
	inv := &Inventory{
		Hostname:    "DESKTOP-IM4V3G4",
		CurrentUser: "operator",
		Domain:      "WORKGROUP",
		LocalIP:     "10.0.0.11",
		Platform:    "windows",
		OSName:      "Windows",
	}
	rustdesk := RustDeskInfo{ID: "90498408"}

	if err := ensureEnrollment(cfg, configPath, inv, rustdesk); err != nil {
		t.Fatal(err)
	}
	if enrollCalls != 1 {
		t.Fatalf("enroll calls = %d, want 1", enrollCalls)
	}
	if cfg.AgentID != "new-agent" || cfg.DeviceID != 11 {
		t.Fatalf("identity = (%q,%d), want (new-agent,11)", cfg.AgentID, cfg.DeviceID)
	}
	if cfg.EnrollmentToken != "" {
		t.Fatalf("enrollment token was not scrubbed")
	}

	saved, err := loadConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if saved.EnrollmentToken != "" {
		t.Fatalf("saved enrollment token was not scrubbed")
	}
}

func TestSendHeartbeatUsesLegacyUnsignedRequest(t *testing.T) {
	const agentID = "new-agent"
	var sawHeartbeat bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, name := range []string{"X-Techi-Agent-ID", "X-Techi-Agent-Timestamp", "X-Techi-Agent-Nonce", "X-Techi-Agent-Signature"} {
			if value := r.Header.Get(name); value != "" {
				t.Fatalf("legacy heartbeat must not send %s header, got %q", name, value)
			}
		}
		sawHeartbeat = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"pending_actions":[]}`))
	}))
	defer server.Close()

	cfg := &Config{
		BackendURL:     server.URL,
		AgentID:        agentID,
		DeviceID:       11,
		TimeoutSeconds: 5,
		Retries:        1,
	}
	payload := &HeartbeatPayload{AgentID: agentID, DeviceID: 11, Hostname: "DESKTOP-IM4V3G4", Platform: "windows"}
	if _, err := sendHeartbeat(cfg, payload); err != nil {
		t.Fatal(err)
	}
	if !sawHeartbeat {
		t.Fatal("server did not observe heartbeat")
	}
}

func TestSaveConfigWritesAtomicallyAndRestrictsMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.config.json")
	cfg := &Config{BackendURL: "https://example.test/api/v1/agent/heartbeat", AgentID: "agent-a", DeviceID: 11}

	if err := saveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	saved, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if saved.AgentID != "agent-a" || saved.DeviceID != 11 {
		t.Fatal("saved config lost identity")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %v, want 0600", info.Mode().Perm())
	}
}

func serverURLForTest(r *http.Request) string {
	if r.TLS != nil {
		return "https://" + r.Host
	}
	return "http://" + r.Host
}
