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

func TestLoadConfigNormalizesProductionURLs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.config.json")
	data := []byte(`{
		"api_url":"http://api-rdp.techi.com.al",
		"backend_url":"http://api-rdp.techi.com.al/api/v1/agent/heartbeat",
		"websocket_url":"ws://api-rdp.techi.com.al/ws/devices?tenant_id=default"
	}`)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}

	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.APIURL != "https://api-rdp.techi.com.al" {
		t.Fatalf("unexpected api_url: %s", cfg.APIURL)
	}
	if cfg.BackendURL != "https://api-rdp.techi.com.al/api/v1/agent/heartbeat" {
		t.Fatalf("unexpected backend_url: %s", cfg.BackendURL)
	}
	if cfg.WebSocketURL != "wss://api-rdp.techi.com.al/ws/devices?tenant_id=default" {
		t.Fatalf("unexpected websocket_url: %s", cfg.WebSocketURL)
	}
}

func TestAgentWatchdogIsOptInAndReleaseDefaultHasNoDevVersion(t *testing.T) {
	if defaultConfig().AgentWatchdogEnabled {
		t.Fatal("agent watchdog must be disabled unless explicitly configured")
	}
	if AgentVersion == "0.0.0-dev" {
		t.Fatal("release binary must not retain the legacy development version marker")
	}

	path := filepath.Join(t.TempDir(), "agent.config.json")
	if err := os.WriteFile(path, []byte(`{"agent_watchdog_enabled":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.AgentWatchdogEnabled {
		t.Fatal("explicit agent_watchdog_enabled=true was not preserved")
	}
}

func TestWindowsDefaultPathsUseTechiAgentProgramData(t *testing.T) {
	if windowsConfigPath != `C:\ProgramData\TechiAgent\agent.config.json` {
		t.Fatalf("unexpected windows config path: %s", windowsConfigPath)
	}
	if windowsLegacyConfigPath != `C:\ProgramData\TECHI\agent.config.json` {
		t.Fatalf("unexpected windows legacy config path: %s", windowsLegacyConfigPath)
	}
	if windowsLogPath != `C:\ProgramData\TechiAgent\logs\agent.log` {
		t.Fatalf("unexpected windows log path: %s", windowsLogPath)
	}
}

func TestMigrateConfigIfNeededCopiesLegacyConfig(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "TechiAgent", "agent.config.json")
	legacyPath := filepath.Join(dir, "TECHI", "agent.config.json")
	logPath := filepath.Join(dir, "TechiAgent", "logs", "agent.log")

	if err := os.MkdirAll(filepath.Dir(legacyPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyPath, []byte(`{"enrollment_token":"secret-token"}`), 0600); err != nil {
		t.Fatal(err)
	}

	if err := migrateConfigIfNeeded(configPath, legacyPath, logPath); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"enrollment_token":"secret-token"}` {
		t.Fatalf("unexpected migrated config: %s", data)
	}
	if _, err := os.Stat(filepath.Dir(logPath)); err != nil {
		t.Fatalf("expected log directory to be created: %v", err)
	}
}
