package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigDerivesAPIURLFromBackendURL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.config.json")
	data := []byte(`{"backend_url":"https://techi.example.com","enrollment_token":"test-token-123456"}`)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}

	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.BackendURL != "https://techi.example.com/api/v1/agent/heartbeat" {
		t.Fatalf("unexpected backend_url: %s", cfg.BackendURL)
	}
	if cfg.APIURL != "https://techi.example.com" {
		t.Fatalf("unexpected api_url: %s", cfg.APIURL)
	}
}

func TestLoadConfigHandlesUTF8BOM(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.config.json")
	data := append([]byte{0xef, 0xbb, 0xbf}, []byte(`{"backend_url":"https://bom.example.com/api/v1/agent/heartbeat"}`)...)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}

	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.BackendURL != "https://bom.example.com/api/v1/agent/heartbeat" {
		t.Fatalf("unexpected backend_url: %s", cfg.BackendURL)
	}
	if cfg.APIURL != "https://bom.example.com" {
		t.Fatalf("unexpected api_url: %s", cfg.APIURL)
	}
}
