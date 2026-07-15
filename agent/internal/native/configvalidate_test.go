package native

import "testing"

func TestValidatePreservableTOMLExtractsIdentity(t *testing.T) {
	id, err := validatePreservableTOML([]byte("id = '12345'\npassword = 'opaque'\n[options]\nkey = 'public'\n"))
	if err != nil || id != "12345" {
		t.Fatalf("id=%q err=%v", id, err)
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
