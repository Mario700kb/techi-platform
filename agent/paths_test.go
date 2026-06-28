package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func readConfigField(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var out map[string]interface{}
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal %s: %v", path, err)
	}
	return out
}

func TestMigrateConfigIfNeeded_CopiesWhenCanonicalMissing(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "agent.config.json")
	legacyPath := filepath.Join(dir, "legacy.config.json")

	if err := os.WriteFile(legacyPath, []byte(`{"enrollment_token":"tok-legacy"}`), 0600); err != nil {
		t.Fatal(err)
	}

	if err := migrateConfigIfNeeded(configPath, legacyPath, ""); err != nil {
		t.Fatalf("migrateConfigIfNeeded: %v", err)
	}

	got := readConfigField(t, configPath)
	if got["enrollment_token"] != "tok-legacy" {
		t.Fatalf("expected copied token, got %v", got["enrollment_token"])
	}
}

func TestMigrateConfigIfNeeded_NeverTouchesEnrolledDevice(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "agent.config.json")
	legacyPath := filepath.Join(dir, "legacy.config.json")

	if err := os.WriteFile(configPath, []byte(`{"device_id":42,"enrollment_token":""}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyPath, []byte(`{"enrollment_token":"tok-fresh"}`), 0600); err != nil {
		t.Fatal(err)
	}

	if err := migrateConfigIfNeeded(configPath, legacyPath, ""); err != nil {
		t.Fatalf("migrateConfigIfNeeded: %v", err)
	}

	got := readConfigField(t, configPath)
	if got["device_id"].(float64) != 42 {
		t.Fatalf("expected device_id to stay 42, got %v", got["device_id"])
	}
	if got["enrollment_token"] != "" {
		t.Fatalf("expected enrollment_token to stay untouched, got %v", got["enrollment_token"])
	}
}

func TestMigrateConfigIfNeeded_RefreshesTokenForStuckUnenrolledDevice(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "agent.config.json")
	legacyPath := filepath.Join(dir, "legacy.config.json")

	if err := os.WriteFile(configPath, []byte(`{"api_url":"https://api.example.com","enrollment_token":""}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyPath, []byte(`{"enrollment_token":"tok-fresh"}`), 0600); err != nil {
		t.Fatal(err)
	}

	if err := migrateConfigIfNeeded(configPath, legacyPath, ""); err != nil {
		t.Fatalf("migrateConfigIfNeeded: %v", err)
	}

	got := readConfigField(t, configPath)
	if got["enrollment_token"] != "tok-fresh" {
		t.Fatalf("expected refreshed token, got %v", got["enrollment_token"])
	}
	if got["api_url"] != "https://api.example.com" {
		t.Fatalf("expected other fields preserved, got %v", got["api_url"])
	}
}

func TestMigrateConfigIfNeeded_LeavesUnenrolledDeviceWithItsOwnToken(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "agent.config.json")
	legacyPath := filepath.Join(dir, "legacy.config.json")

	if err := os.WriteFile(configPath, []byte(`{"enrollment_token":"tok-already-set"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyPath, []byte(`{"enrollment_token":"tok-fresh"}`), 0600); err != nil {
		t.Fatal(err)
	}

	if err := migrateConfigIfNeeded(configPath, legacyPath, ""); err != nil {
		t.Fatalf("migrateConfigIfNeeded: %v", err)
	}

	got := readConfigField(t, configPath)
	if got["enrollment_token"] != "tok-already-set" {
		t.Fatalf("expected existing token to stay, got %v", got["enrollment_token"])
	}
}

func TestMigrateConfigIfNeeded_NoopWhenLegacyMissing(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "agent.config.json")
	legacyPath := filepath.Join(dir, "legacy.config.json")

	if err := migrateConfigIfNeeded(configPath, legacyPath, ""); err != nil {
		t.Fatalf("migrateConfigIfNeeded: %v", err)
	}
	if _, err := os.Stat(configPath); !os.IsNotExist(err) {
		t.Fatalf("expected configPath to remain absent, stat err=%v", err)
	}
}
