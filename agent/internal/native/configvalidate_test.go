package native

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestValidatePreservableTOMLExtractsIdentity(t *testing.T) {
	id, err := validatePreservableTOML([]byte("id = '12345'\npassword = 'opaque'\n[options]\nkey = 'public'\n"))
	if err != nil || id != "12345" {
		t.Fatalf("id=%q err=%v", id, err)
	}
}

func TestValidTOMLIsPreserved(t *testing.T) {
	data := []byte("id = '123456789' # identity\npassword = 'opaque'\nkey_pair = ['pub', 'private']\n[options]\nkey = 'public'\n")
	decision := prepareConfigForRecovery(`C:\Users\USER\AppData\Roaming\TECHI Remote Support\config\TECHI Remote Support.toml`, data)
	if !decision.preserve || len(decision.fresh) != 0 {
		t.Fatalf("valid TOML must be preserved exactly: %+v", decision)
	}
}

func TestInvalidAssignmentIsQuarantinedAndIdentityRecovered(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "TECHI Remote Support.toml")
	corrupt := []byte("id = '123456789'\npassword = 'opaque'\nbroken assignment\n")
	if err := os.WriteFile(path, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}

	decision := prepareConfigForRecovery(path, corrupt)
	if decision.preserve {
		t.Fatal("invalid assignment must not be preserved")
	}
	if _, err := validatePreservableConfig(path, decision.fresh); err != nil {
		t.Fatalf("fresh config is invalid: %v", err)
	}
	for _, value := range []string{"id = '123456789'", "password = 'opaque'"} {
		if !strings.Contains(string(decision.fresh), value) {
			t.Fatalf("safe identity value %q was not recovered: %q", value, decision.fresh)
		}
	}
	if strings.Contains(string(decision.fresh), "broken assignment") {
		t.Fatalf("corrupt content leaked into fresh config: %q", decision.fresh)
	}

	backup, err := quarantineCorruptConfig(path, time.Date(2026, 7, 16, 12, 30, 0, 123, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(backup, ".20260716T123000.000000123Z.corrupt") {
		t.Fatalf("backup is not timestamped .corrupt: %s", backup)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("corrupt source still exists: %v", err)
	}
	got, err := os.ReadFile(backup)
	if err != nil || string(got) != string(corrupt) {
		t.Fatalf("quarantine did not retain exact corrupt bytes: got=%q err=%v", got, err)
	}
}

func TestEmptyAndTruncatedTOMLProduceFreshConfig(t *testing.T) {
	for name, data := range map[string][]byte{
		"empty":     {},
		"truncated": []byte("id = '123456789"),
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "TECHI Remote Support.toml")
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			decision := prepareConfigForRecovery(path, data)
			if decision.preserve {
				t.Fatal("malformed TOML must be quarantined")
			}
			if _, err := validatePreservableConfig(path, decision.fresh); err != nil {
				t.Fatalf("fresh config is invalid: %v", err)
			}
			if len(data) > 0 && strings.Contains(string(decision.fresh), string(data)) {
				t.Fatalf("truncated TOML was restored: %q", decision.fresh)
			}
			backup, err := quarantineCorruptConfig(path, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasSuffix(backup, ".corrupt") {
				t.Fatalf("malformed TOML was not quarantined: %s", backup)
			}
		})
	}
}

func TestValidatePreservableTOMLRejectsExecutableAndScriptContent(t *testing.T) {
	for _, data := range [][]byte{
		[]byte("MZbinary"),
		[]byte("#!/bin/sh\nid = '123'\n"),
		[]byte("id = '123'\x00"),
		[]byte("id = '123'\ncommand = 'powershell.exe -enc bad'\n"),
	} {
		if _, err := validatePreservableTOML(data); err == nil {
			t.Fatalf("expected content rejection for %q", data)
		}
	}
}

func TestValidatePreservableAgentConfigJSON(t *testing.T) {
	data := []byte(`{"rustdesk_credential_generation":7,"rustdesk_ack_fingerprint":"opaque"}`)
	if _, err := validatePreservableConfig(`C:\ProgramData\TechiAgent\agent.config.json`, data); err != nil {
		t.Fatal(err)
	}
	if _, err := validatePreservableConfig(`C:\ProgramData\TechiAgent\agent.config.json`, []byte("not-json")); err == nil {
		t.Fatal("expected malformed Agent config to be rejected")
	}
}

func TestRemoteSupportConfigScopeExcludesAgentState(t *testing.T) {
	if isRemoteSupportConfigPath(`C:\ProgramData\TechiAgent\agent.config.json`) {
		t.Fatal("Remote Support recovery must not preserve or restore Agent config")
	}
	if !isRemoteSupportConfigPath(`C:\Users\USER\AppData\Roaming\TECHI Remote Support\config\TECHI Remote Support2.toml`) {
		t.Fatal("Remote Support TOML must remain in the preservation scope")
	}
}
