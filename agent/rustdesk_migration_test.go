package main

import "testing"

// --------------------------------------------------------------------------- //
// Version namespace                                                            //
// --------------------------------------------------------------------------- //

func TestSelectRemoteSupportVersionPrefersMSIProductVersion(t *testing.T) {
	got := selectRemoteSupportVersion("1.4.6", remoteSupportMSIRegistration{
		ProductCode: managedRemoteSupportProductCode,
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

func TestRemoteSupportReportedVersionRecordsItsNamespace(t *testing.T) {
	version, source := remoteSupportReportedVersion(
		remoteSupportMSIRegistration{Version: "1.4.6.29665273"}, "1.4.6")
	if version != "1.4.6.29665273" || source != "msi_registry" {
		t.Fatalf("managed: got (%q, %q), want (1.4.6.29665273, msi_registry)", version, source)
	}

	version, source = remoteSupportReportedVersion(remoteSupportMSIRegistration{}, "1.4.6")
	if version != "1.4.6" || source != "file_version" {
		t.Fatalf("unmanaged: got (%q, %q), want (1.4.6, file_version)", version, source)
	}

	version, source = remoteSupportReportedVersion(remoteSupportMSIRegistration{}, "")
	if version != "" || source != "unknown" {
		t.Fatalf("nothing installed: got (%q, %q), want (\"\", unknown)", version, source)
	}
}

// TestDiscoveryLooksUpManagedProductCodeFirst is the regression test for the
// reported defect: the machine's uninstall registry holds DisplayVersion
// 1.4.6.29665273 under the managed ProductCode, but discovery opened with a
// registry-wide text scan, got nothing, and silently reported the executable's
// semantic version 1.4.6 instead.
func TestDiscoveryLooksUpManagedProductCodeFirst(t *testing.T) {
	restoreLookup := uninstallDisplayVersionLookup
	restoreScan := arpRemoteSupportRegistrationScan
	defer func() {
		uninstallDisplayVersionLookup = restoreLookup
		arpRemoteSupportRegistrationScan = restoreScan
	}()

	var lookedUp string
	uninstallDisplayVersionLookup = func(guid string) string {
		lookedUp = guid
		if guid == managedRemoteSupportProductCode {
			return "1.4.6.29665273"
		}
		return ""
	}
	arpRemoteSupportRegistrationScan = func() remoteSupportMSIRegistration {
		t.Fatal("ARP name scan must not run when the ProductCode lookup succeeds")
		return remoteSupportMSIRegistration{}
	}

	// Empty GUID = the heartbeat discovery path.
	msi := detectRemoteSupportMSIRegistration("")

	if lookedUp != managedRemoteSupportProductCode {
		t.Fatalf("looked up %q, want the managed ProductCode %q", lookedUp, managedRemoteSupportProductCode)
	}
	if msi.Version != "1.4.6.29665273" {
		t.Fatalf("DisplayVersion = %q, want 1.4.6.29665273", msi.Version)
	}
	// ...and the registry value must win over the executable's --version.
	if got := selectRemoteSupportVersion("1.4.6", msi); got != "1.4.6.29665273" {
		t.Fatalf("reported version = %q, want the MSI DisplayVersion 1.4.6.29665273", got)
	}
}

// TestManagedProductCodeIsTheCurrentRegistration pins the current MSI's
// ProductCode as the primary lookup, with the obsolete one demoted to the legacy
// fallback list (the field bug: the agent searched for {74CEDF4A…} while the
// installed MSI registered under {528FACDB…}).
func TestManagedProductCodeIsTheCurrentRegistration(t *testing.T) {
	if managedRemoteSupportProductCode != "{528FACDB-7405-40F2-B8D5-F316F516FBB4}" {
		t.Fatalf("current ProductCode = %q, want {528FACDB-7405-40F2-B8D5-F316F516FBB4}", managedRemoteSupportProductCode)
	}
	found := false
	for _, guid := range legacyRemoteSupportProductCodes {
		if guid == "{74CEDF4A-E226-4151-BC7A-5154F0BC9E79}" {
			found = true
		}
		if guid == managedRemoteSupportProductCode {
			t.Fatalf("the current ProductCode must not also be in the legacy list")
		}
	}
	if !found {
		t.Fatal("the obsolete {74CEDF4A…} ProductCode must be retained as a legacy fallback")
	}
}

// TestDiscoveryFallsBackToLegacyProductCode: the current ProductCode misses but a
// legacy one is registered → discovered without a DisplayName scan.
func TestDiscoveryFallsBackToLegacyProductCode(t *testing.T) {
	restoreLookup := uninstallDisplayVersionLookup
	restoreScan := arpRemoteSupportRegistrationScan
	defer func() {
		uninstallDisplayVersionLookup = restoreLookup
		arpRemoteSupportRegistrationScan = restoreScan
	}()

	legacy := legacyRemoteSupportProductCodes[0]
	var queried []string
	uninstallDisplayVersionLookup = func(guid string) string {
		queried = append(queried, guid)
		if guid == legacy {
			return "1.4.6.0"
		}
		return ""
	}
	arpRemoteSupportRegistrationScan = func() remoteSupportMSIRegistration {
		t.Fatal("DisplayName scan must not run when a legacy ProductCode resolves")
		return remoteSupportMSIRegistration{}
	}

	msi := detectRemoteSupportMSIRegistration("")

	if msi.ProductCode != legacy || msi.Version != "1.4.6.0" {
		t.Fatalf("registration = %+v, want ProductCode=%s Version=1.4.6.0", msi, legacy)
	}
	// The current ProductCode must have been tried BEFORE the legacy one.
	if len(queried) < 2 || queried[0] != managedRemoteSupportProductCode || queried[1] != legacy {
		t.Fatalf("query order = %v, want [current, legacy…]", queried)
	}
}

// TestDiscoveryHonoursAnExplicitCallerProductCode: a ProductCode passed by the
// caller (e.g. the deploy action) is tried first.
func TestDiscoveryHonoursAnExplicitCallerProductCode(t *testing.T) {
	restoreLookup := uninstallDisplayVersionLookup
	restoreScan := arpRemoteSupportRegistrationScan
	defer func() {
		uninstallDisplayVersionLookup = restoreLookup
		arpRemoteSupportRegistrationScan = restoreScan
	}()

	var first string
	uninstallDisplayVersionLookup = func(guid string) string {
		if first == "" {
			first = guid
		}
		if guid == "{CALLER-GUID}" {
			return "9.9.9.9"
		}
		return ""
	}
	arpRemoteSupportRegistrationScan = func() remoteSupportMSIRegistration {
		return remoteSupportMSIRegistration{}
	}

	msi := detectRemoteSupportMSIRegistration("{CALLER-GUID}")

	if first != "{CALLER-GUID}" {
		t.Fatalf("first lookup = %q, want the caller-supplied ProductCode first", first)
	}
	if msi.Version != "9.9.9.9" {
		t.Fatalf("Version = %q, want 9.9.9.9", msi.Version)
	}
}

func TestDiscoveryFallsBackToARPScanOnlyWhenProductCodeMisses(t *testing.T) {
	restoreLookup := uninstallDisplayVersionLookup
	restoreScan := arpRemoteSupportRegistrationScan
	defer func() {
		uninstallDisplayVersionLookup = restoreLookup
		arpRemoteSupportRegistrationScan = restoreScan
	}()

	uninstallDisplayVersionLookup = func(string) string { return "" }
	scanned := false
	arpRemoteSupportRegistrationScan = func() remoteSupportMSIRegistration {
		scanned = true
		return remoteSupportMSIRegistration{ProductCode: "{OTHER}", Version: "1.4.7.1"}
	}

	msi := detectRemoteSupportMSIRegistration("")

	if !scanned {
		t.Fatal("ARP name scan must run when the ProductCode lookup finds nothing")
	}
	if msi.Version != "1.4.7.1" {
		t.Fatalf("DisplayVersion = %q, want the ARP fallback 1.4.7.1", msi.Version)
	}
}

// --------------------------------------------------------------------------- //
// Process command lines                                                        //
// --------------------------------------------------------------------------- //

func TestClassifyRemoteSupportProcessArgsSeparatesDaemonFromTray(t *testing.T) {
	signals := classifyRemoteSupportProcessArgs([]string{
		`"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" --service`,
		`"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" --server`,
		`"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" --tray`,
		`"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" --tray`,
	}, false)

	if !signals.Daemon {
		t.Error("--service/--server must count as daemon evidence")
	}
	if !signals.Tray {
		t.Error("--tray must count as tray evidence")
	}
	if !signals.Branded {
		t.Error("branded processes must be reported as present")
	}
	if signals.Legacy {
		t.Error("no legacy rustdesk.exe was present")
	}
}

func TestClassifyRemoteSupportProcessArgsTreatsUnreadableCmdlineAsRoleUnknown(t *testing.T) {
	signals := classifyRemoteSupportProcessArgs([]string{""}, false)

	if !signals.Branded {
		t.Error("an unreadable command line must still count the process as present")
	}
	if signals.Daemon || signals.Tray {
		t.Error("an unreadable command line must not invent a role")
	}
}

// --------------------------------------------------------------------------- //
// SERVICE_STATUS mapping (locale-independent numeric codes)                    //
// --------------------------------------------------------------------------- //

func TestRemoteSupportServiceStateNameMapsNumericCodes(t *testing.T) {
	cases := map[uint32]string{
		1: "stopped", 2: "pending", 3: "pending", 4: "running",
		5: "pending", 6: "pending", 7: "paused", 99: "",
	}
	for code, want := range cases {
		if got := remoteSupportServiceStateName(code); got != want {
			t.Errorf("state %d = %q, want %q", code, got, want)
		}
	}
}

// --------------------------------------------------------------------------- //
// Runtime classification                                                       //
// --------------------------------------------------------------------------- //

// Case A -- the healthy managed endpoint.
func TestClassifyManagedMSIWithRunningServiceAndTrayIsRunning(t *testing.T) {
	got := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		ManagedMSIRegistered: true,
		ServiceState:         "running",
		DaemonProcess:        true,
		TrayProcess:          true,
		BrandedProcess:       true,
	})

	if got != "running" {
		t.Fatalf("status = %q, want running", got)
	}
}

// Case B -- the reported defect: SCM read unavailable, daemon demonstrably up.
func TestClassifyManagedMSIWithUnreadableServiceStateIsNeverTrayOnly(t *testing.T) {
	got := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		ManagedMSIRegistered: true,
		ServiceState:         "", // undetermined
		DaemonProcess:        true,
		TrayProcess:          true,
		BrandedProcess:       true,
	})

	if got == "tray_only" {
		t.Fatal("a registered managed MSI must never be classified tray_only")
	}
	if got != "running" {
		t.Fatalf("status = %q, want running", got)
	}
}

// Case C -- managed MSI, daemon down, only the tray alive. SCM is authoritative
// that the service is stopped, and a stray tray process cannot change that.
func TestClassifyManagedMSIWithOnlyTrayIsStopped(t *testing.T) {
	got := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		ManagedMSIRegistered: true,
		ServiceState:         "stopped",
		TrayProcess:          true,
		BrandedProcess:       true,
	})

	if got == "tray_only" {
		t.Fatal("a registered managed MSI must never be classified tray_only")
	}
	if got != "stopped" {
		t.Fatalf("status = %q, want stopped", got)
	}
}

// A managed service mid-transition is "starting", not a fault.
func TestClassifyManagedMSIWithPendingServiceIsStarting(t *testing.T) {
	got := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		ManagedMSIRegistered: true,
		ServiceState:         "pending",
	})

	if got != "starting" {
		t.Fatalf("status = %q, want starting", got)
	}
}

// Managed install, no daemon evidence and no readable service state: the service
// is not providing the runtime and we must not claim it is cleanly stopped.
func TestClassifyManagedMSIWithUnreadableStateAndNoDaemonIsServiceError(t *testing.T) {
	unreadable := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		ManagedMSIRegistered: true,
		ServiceState:         "",
		TrayProcess:          true,
		BrandedProcess:       true,
	})
	if unreadable != "service_error" {
		t.Fatalf("unreadable state: status = %q, want service_error", unreadable)
	}

	paused := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		ManagedMSIRegistered: true,
		ServiceState:         "paused",
	})
	if paused != "service_error" {
		t.Fatalf("paused service: status = %q, want service_error", paused)
	}
}

// The managed vocabulary is service-oriented only -- no tray concept describes a
// managed installation, and the retired "managed_degraded" must not come back.
func TestManagedRuntimeStatesAreServiceOriented(t *testing.T) {
	allowed := map[string]bool{
		"running": true, "starting": true, "stopped": true,
		"service_error": true, "conflicting_dual_install": true,
	}
	for _, state := range []string{"", "running", "stopped", "pending", "paused", "bogus"} {
		for _, daemon := range []bool{false, true} {
			for _, tray := range []bool{false, true} {
				for _, legacy := range []bool{false, true} {
					got := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
						ManagedMSIRegistered: true,
						ServiceState:         state,
						DaemonProcess:        daemon,
						TrayProcess:          tray,
						BrandedProcess:       tray || daemon,
						LegacyProcess:        legacy,
					})
					if !allowed[got] {
						t.Fatalf("managed status %q not in the service-oriented vocabulary (state=%q daemon=%v tray=%v legacy=%v)",
							got, state, daemon, tray, legacy)
					}
				}
			}
		}
	}
}

func TestClassifyManagedMSIWithStoppedServiceAndNoProcessesIsStopped(t *testing.T) {
	got := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		ManagedMSIRegistered: true,
		ServiceState:         "stopped",
	})

	if got != "stopped" {
		t.Fatalf("status = %q, want stopped", got)
	}
}

// Case D -- the only remaining legitimate tray_only: an unmigrated legacy endpoint.
func TestClassifyUnmanagedTrayOnlyRuntimeIsTrayOnly(t *testing.T) {
	got := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		ManagedMSIRegistered: false,
		TrayProcess:          true,
		BrandedProcess:       true,
	})

	if got != "tray_only" {
		t.Fatalf("status = %q, want tray_only", got)
	}
}

// Case E -- managed MSI alongside surviving legacy RustDesk artifacts.
func TestClassifyManagedMSIWithLegacyArtifactsIsConflict(t *testing.T) {
	fromProcess := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		ManagedMSIRegistered: true,
		ServiceState:         "running",
		DaemonProcess:        true,
		LegacyProcess:        true,
	})
	if fromProcess != "conflicting_dual_install" {
		t.Fatalf("legacy process: status = %q, want conflicting_dual_install", fromProcess)
	}

	fromService := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		ManagedMSIRegistered: true,
		ServiceState:         "",
		LegacyServiceRunning: true,
	})
	if fromService != "conflicting_dual_install" {
		t.Fatalf("legacy service: status = %q, want conflicting_dual_install", fromService)
	}
}

// The tray_only invariant, asserted directly across the whole signal space.
func TestTrayOnlyRequiresAnUnregisteredInstall(t *testing.T) {
	for _, state := range []string{"", "running", "stopped", "pending", "paused"} {
		for _, daemon := range []bool{false, true} {
			for _, tray := range []bool{false, true} {
				for _, branded := range []bool{false, true} {
					got := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
						ManagedMSIRegistered: true,
						ServiceState:         state,
						DaemonProcess:        daemon,
						TrayProcess:          tray,
						BrandedProcess:       branded,
					})
					if got == "tray_only" {
						t.Fatalf("managed MSI classified tray_only (state=%q daemon=%v tray=%v branded=%v)",
							state, daemon, tray, branded)
					}
				}
			}
		}
	}
}

func TestClassifyUnmanagedLegacyServiceReportedSeparately(t *testing.T) {
	got := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		LegacyServiceRunning: true,
	})

	if got != "legacy_service_running" {
		t.Fatalf("status = %q, want legacy_service_running", got)
	}
}

func TestClassifyNothingInstalledIsNotRunning(t *testing.T) {
	if got := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{}); got != "not_running" {
		t.Fatalf("status = %q, want not_running", got)
	}
}
