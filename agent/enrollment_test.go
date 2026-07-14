package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureEnrollmentReenrollsExistingIdentityMissingCredential(t *testing.T) {
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
		if !strings.Contains(text, `"agent_id":"old-agent"`) {
			t.Fatalf("expected old agent identity in reenrollment payload: %s", text)
		}
		if !strings.Contains(text, `"enrollment_token":"reenroll-token"`) {
			t.Fatalf("expected enrollment token in reenrollment payload: %s", text)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"agent_id":"new-agent",
			"device_id":11,
			"heartbeat_url":"` + serverURLForTest(r) + `/api/v1/agent/heartbeat",
			"websocket_url":"wss://example.test/ws",
			"enrollment_status":"enrolled",
			"agent_credential":"credential-after-reenroll"
		}`))
	}))
	defer server.Close()

	cfg := &Config{
		APIURL:           server.URL,
		BackendURL:       server.URL + heartbeatPath,
		AgentID:          "old-agent",
		DeviceID:         11,
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
	if cfg.AgentCredential != "credential-after-reenroll" {
		t.Fatalf("credential was not persisted in memory")
	}
	if cfg.EnrollmentToken != "" {
		t.Fatalf("enrollment token was not scrubbed")
	}

	saved, err := loadConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if saved.AgentCredential != "credential-after-reenroll" {
		t.Fatalf("saved credential missing")
	}
	if saved.EnrollmentToken != "" {
		t.Fatalf("saved enrollment token was not scrubbed")
	}
}

func TestEnsureEnrollmentRejectsCredentiallessIdentityWithoutReenrollmentPath(t *testing.T) {
	cfg := &Config{AgentID: "old-agent", DeviceID: 11}
	inv := &Inventory{Hostname: "DESKTOP-IM4V3G4", Domain: "WORKGROUP", Platform: "windows"}

	err := ensureEnrollment(cfg, filepath.Join(t.TempDir(), "agent.config.json"), inv, RustDeskInfo{})
	if err == nil {
		t.Fatal("expected credentialless identity to require re-enrollment")
	}
	if !strings.Contains(err.Error(), "missing heartbeat credential") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSendHeartbeatSignsWithPersistedEnrollmentCredential(t *testing.T) {
	const credential = "credential-after-reenroll"
	const agentID = "new-agent"
	var sawSigned bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		timestamp := r.Header.Get("X-Techi-Agent-Timestamp")
		nonce := r.Header.Get("X-Techi-Agent-Nonce")
		signature := r.Header.Get("X-Techi-Agent-Signature")
		if r.Header.Get("X-Techi-Agent-ID") != agentID || timestamp == "" || nonce == "" || signature == "" {
			t.Fatalf("heartbeat missing auth headers: %#v", r.Header)
		}
		bodyHash := sha256.Sum256(body)
		message := fmt.Sprintf("v1\n%s\n%s\n%s\n%s", agentID, timestamp, nonce, hex.EncodeToString(bodyHash[:]))
		mac := hmac.New(sha256.New, []byte(credential))
		_, _ = mac.Write([]byte(message))
		if signature != hex.EncodeToString(mac.Sum(nil)) {
			t.Fatalf("invalid heartbeat signature")
		}
		sawSigned = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"pending_actions":[]}`))
	}))
	defer server.Close()

	cfg := &Config{
		BackendURL:      server.URL,
		AgentID:         agentID,
		AgentCredential: credential,
		DeviceID:        11,
		TimeoutSeconds:  5,
		Retries:         1,
	}
	payload := &HeartbeatPayload{AgentID: agentID, DeviceID: 11, Hostname: "DESKTOP-IM4V3G4", Platform: "windows"}
	if _, err := sendHeartbeat(cfg, payload); err != nil {
		t.Fatal(err)
	}
	if !sawSigned {
		t.Fatal("server did not observe signed heartbeat")
	}
}

func TestSaveConfigWritesCredentialAtomicallyAndRestrictsMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.config.json")
	cfg := &Config{BackendURL: "https://example.test/api/v1/agent/heartbeat", AgentID: "agent-a", DeviceID: 11, AgentCredential: "credential"}

	if err := saveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	saved, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if saved.AgentCredential != "credential" {
		t.Fatal("saved config lost credential")
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
