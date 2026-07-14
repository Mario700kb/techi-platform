package main

import "testing"

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
		"rs-tray-task",
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
