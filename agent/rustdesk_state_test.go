package main

import "testing"

func TestClassifyRustDeskObservedStateKeepsLegacyTrayOnlyInstalled(t *testing.T) {
	installStatus, runtimeStatus := classifyRustDeskObservedState(
		"installed",
		"not_running",
		`C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`,
		"1.4.6+64",
		false,
		"",
		false,
		false,
	)

	if installStatus != "installed" {
		t.Fatalf("valid legacy executable must remain installed, got %q", installStatus)
	}
	if runtimeStatus != rustDeskStatusTrayOnly {
		t.Fatalf("legacy install without service must report tray_only, got %q", runtimeStatus)
	}
}

func TestClassifyRustDeskObservedStateValidExecutableWinsOverStaleTmp(t *testing.T) {
	installStatus, runtimeStatus := classifyRustDeskObservedState(
		"installed",
		"running",
		`C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`,
		"1.4.6",
		false,
		"",
		true,
		true,
	)

	if installStatus != "installed" || runtimeStatus != rustDeskStatusTrayOnly {
		t.Fatalf("valid legacy executable must not become damaged; got install=%q status=%q", installStatus, runtimeStatus)
	}
}
