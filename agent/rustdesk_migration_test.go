package main

import "testing"

func TestSelectRemoteSupportVersionPrefersMSIProductVersion(t *testing.T) {
	got := selectRemoteSupportVersion("1.4.6", remoteSupportMSIRegistration{
		ProductCode: "{74CEDF4A-E226-4151-BC7A-5154F0BC9E79}",
		Version:     "1.4.6.29665273",
	})

	if got != "1.4.6.29665273" {
		t.Fatalf("version = %q, want MSI ProductVersion", got)
	}
}

func TestSelectRemoteSupportVersionFallsBackToFileVersionForLegacyTray(t *testing.T) {
	got := selectRemoteSupportVersion("1.4.6", remoteSupportMSIRegistration{})

	if got != "1.4.6" {
		t.Fatalf("version = %q, want legacy file version", got)
	}
}

func TestClassifyRustDeskWindowsRuntimeFullMSIWinsOverBrandedTray(t *testing.T) {
	got := classifyRustDeskWindowsRuntime("running", true, false, false)

	if got != "running" {
		t.Fatalf("status = %q, want running", got)
	}
}

func TestClassifyRustDeskWindowsRuntimeTrayOnlyWithoutFullService(t *testing.T) {
	got := classifyRustDeskWindowsRuntime("", true, false, false)

	if got != "tray_only" {
		t.Fatalf("status = %q, want tray_only", got)
	}
}

func TestClassifyRustDeskWindowsRuntimeReportsDualInstallConflict(t *testing.T) {
	got := classifyRustDeskWindowsRuntime("running", true, true, false)

	if got != "conflicting_dual_install" {
		t.Fatalf("status = %q, want conflicting_dual_install", got)
	}
}

func TestClassifyRustDeskWindowsRuntimeReportsLegacyServiceSeparately(t *testing.T) {
	got := classifyRustDeskWindowsRuntime("", false, false, true)

	if got != "legacy_service_running" {
		t.Fatalf("status = %q, want legacy_service_running", got)
	}
}
