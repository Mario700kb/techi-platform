package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFindUtilityCommandHandlesDuplicateExePathBeforeHelper(t *testing.T) {
	argv := []string{
		`C:\ProgramData\TechiAgent\techi-agent.exe`,
		`C:\ProgramData\TechiAgent\techi-agent.exe`,
		"installer-marker",
		"create",
	}
	idx, command := findUtilityCommand(argv)
	if idx != 2 || command != "installer-marker" {
		t.Fatalf("findUtilityCommand = (%d, %q), want (2, installer-marker)", idx, command)
	}
}

func TestFindUtilityCommandSkipsEmptyArgumentBeforeHelper(t *testing.T) {
	for _, argv := range [][]string{
		{`C:\ProgramData\TechiAgent\techi-agent.exe`, "", "installer-marker", "create"},
		{`C:\ProgramData\TechiAgent\techi-agent.exe`, "", "installer-marker", "remove"},
	} {
		idx, command := findUtilityCommand(argv)
		if idx != 2 || command != "installer-marker" {
			t.Fatalf("findUtilityCommand(%q) = (%d, %q), want (2, installer-marker)", argv, idx, command)
		}
	}
}

func TestFindUtilityCommandNormalizesQuotesCaseAndPath(t *testing.T) {
	argv := []string{
		"techi-agent.exe",
		`"C:\ProgramData\TechiAgent\INSTALLER-START-SERVICE"`,
	}
	idx, command := findUtilityCommand(argv)
	if idx != 1 || command != "installer-start-service" {
		t.Fatalf("findUtilityCommand = (%d, %q), want (1, installer-start-service)", idx, command)
	}
}

func TestFindUtilityCommandIgnoresNormalRuntimeArgs(t *testing.T) {
	argv := []string{"techi-agent.exe", "-config", `C:\ProgramData\TechiAgent\agent.config.json`}
	idx, command := findUtilityCommand(argv)
	if idx != -1 || command != "" {
		t.Fatalf("findUtilityCommand = (%d, %q), want (-1, empty)", idx, command)
	}
}

func TestUtilityCommandSetIncludesInstallerHelpers(t *testing.T) {
	for _, command := range []string{
		"swap-binary",
		"watchdog-check",
		"bootstrap-config",
		"bootstrap-config-contract",
		"bootstrap-remote-support",
		"rs-tray-task",
		"remote-support-ui-session",
		"installer-marker",
		"installer-ensure-service",
		"installer-start-service",
		"installer-health-check",
	} {
		if !isUtilityCommand(command) {
			t.Fatalf("isUtilityCommand(%q) = false", command)
		}
	}
}

func TestBootstrapConfigContractMatchesParser(t *testing.T) {
	want := map[string]bool{
		"-api-url":                               true,
		"-enrollment-token":                      true,
		"-reenroll":                              true,
		"-rustdesk-server":                       true,
		"-rustdesk-relay":                        true,
		"-rustdesk-key":                          true,
		"-remote-support-auto-repair-mode":       true,
		"-remote-support-auto-repair-device-ids": true,
	}
	if bootstrapConfigContractVersion == "" {
		t.Fatal("bootstrap config contract version must not be empty")
	}
	if len(bootstrapConfigSupportedFlags) != len(want) {
		t.Fatalf("supported flags=%v want=%v", bootstrapConfigSupportedFlags, want)
	}
	for _, flag := range bootstrapConfigSupportedFlags {
		if !want[flag] {
			t.Fatalf("unexpected bootstrap config contract flag %q", flag)
		}
	}
}

func TestRemoteSupportDeliveryAppliesNewCredentialField(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "agent.config.json")
	var applied string
	origCredentialFn := applyRemoteSupportCredentialFn
	origPasswordFn := applyRemoteSupportPasswordFn
	applyRemoteSupportCredentialFn = func(password string) error {
		applied = password
		return nil
	}
	applyRemoteSupportPasswordFn = func(password string) {
		t.Fatalf("legacy password fallback must not run when remote_support_credential exists; got %q", password)
	}
	defer func() {
		applyRemoteSupportCredentialFn = origCredentialFn
		applyRemoteSupportPasswordFn = origPasswordFn
	}()

	cfg := &Config{DeviceID: 42, RustDeskCredentialGen: 1, RustDeskDefaultPassword: "old"}
	hbResp := &HeartbeatResponse{
		RemoteSupportCredential: &RemoteSupportCredentialDelivery{
			Generation:      2,
			Password:        "new-password",
			VerificationKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
		},
		RemoteSupportPassword: "legacy-password",
	}

	handleRemoteSupportDelivery(cfg, configPath, hbResp)

	if applied != "new-password" {
		t.Fatalf("new credential apply = %q, want new-password", applied)
	}
	if cfg.RustDeskDefaultPassword != "new-password" {
		t.Fatalf("default password = %q, want new-password", cfg.RustDeskDefaultPassword)
	}
	if cfg.RustDeskCredentialGen != 2 || cfg.RustDeskAckStatus != "applied" || cfg.RustDeskAckFingerprint == "" {
		t.Fatalf("credential ack not recorded correctly: gen=%d status=%q fp=%q", cfg.RustDeskCredentialGen, cfg.RustDeskAckStatus, cfg.RustDeskAckFingerprint)
	}
}

func TestRemoteSupportDeliveryFallsBackToLegacyPassword(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "agent.config.json")
	var applied string
	origCredentialFn := applyRemoteSupportCredentialFn
	origPasswordFn := applyRemoteSupportPasswordFn
	applyRemoteSupportCredentialFn = func(password string) error {
		t.Fatalf("new credential apply must not run for legacy-only response; got %q", password)
		return nil
	}
	applyRemoteSupportPasswordFn = func(password string) {
		applied = password
	}
	defer func() {
		applyRemoteSupportCredentialFn = origCredentialFn
		applyRemoteSupportPasswordFn = origPasswordFn
	}()

	cfg := &Config{RustDeskDefaultPassword: "old-password"}
	hbResp := &HeartbeatResponse{RemoteSupportPassword: " legacy-password "}

	handleRemoteSupportDelivery(cfg, configPath, hbResp)

	if applied != "legacy-password" {
		t.Fatalf("legacy password apply = %q, want legacy-password", applied)
	}
	if cfg.RustDeskDefaultPassword != "legacy-password" {
		t.Fatalf("default password = %q, want legacy-password", cfg.RustDeskDefaultPassword)
	}
	saved, err := loadConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if saved.RustDeskDefaultPassword != "legacy-password" {
		t.Fatalf("saved password = %q, want legacy-password", saved.RustDeskDefaultPassword)
	}
}

func TestRemoteSupportDeliverySkipsDuplicateLegacyPassword(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "agent.config.json")
	origPasswordFn := applyRemoteSupportPasswordFn
	applyRemoteSupportPasswordFn = func(password string) {
		t.Fatalf("duplicate legacy password must not be applied again; got %q", password)
	}
	defer func() { applyRemoteSupportPasswordFn = origPasswordFn }()

	cfg := &Config{RustDeskDefaultPassword: "same-password"}
	handleRemoteSupportDelivery(cfg, configPath, &HeartbeatResponse{RemoteSupportPassword: "same-password"})

	if _, err := os.Stat(configPath); !os.IsNotExist(err) {
		t.Fatalf("duplicate legacy password should not write config, stat err=%v", err)
	}
}
