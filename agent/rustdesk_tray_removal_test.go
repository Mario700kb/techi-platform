package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Tray mode is deprecated. These tests pin the architecture: the agent may only
// ever REMOVE tray startup, never create or start it, and removal must not touch
// the on-demand UI shortcut or the managed daemon.

func agentSource(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(data)
}

// --------------------------------------------------------------------------- //
// A/B/C: no code path creates or starts a tray                                 //
// --------------------------------------------------------------------------- //

func TestNoAgentCodePathStartsOrCreatesATray(t *testing.T) {
	// Helpers whose entire purpose was starting/keeping a tray alive.
	forbidden := []string{
		"ensureRustDeskTrayRunning",
		"startRustDeskTray(",
		"Register-ScheduledTask",
		"schtasks\", \"/Create\"",
		"runRSTrayTaskCommand",
	}
	sources, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range sources {
		if strings.HasSuffix(file, "_test.go") || file == "swap_windows.go" || file == "watchdog_windows.go" {
			continue // agent self-update/watchdog tasks are unrelated to Remote Support
		}
		text := agentSource(t, file)
		for _, needle := range forbidden {
			if strings.Contains(text, needle) {
				t.Errorf("%s still contains a tray-start path: %q", file, needle)
			}
		}
	}
}

// B: deploy_remote_support installs the service and removes tray artifacts.
func TestDeployRemoteSupportEnsuresServiceAndRemovesTray(t *testing.T) {
	text := agentSource(t, "actions_windows.go")

	deploy := text[strings.Index(text, "func executeDeployRemoteSupport"):]
	deploy = deploy[:strings.Index(deploy, "\nfunc ")]

	if !strings.Contains(deploy, "ensureRustDeskService()") {
		t.Error("deploy must ensure the managed Windows service")
	}
	if !strings.Contains(deploy, "removeManagedTrayArtifacts()") {
		t.Error("deploy must remove deprecated tray artifacts")
	}
	// No "--tray" argument literal may be passed to anything (comments that
	// describe removing tray startup are fine).
	if strings.Contains(deploy, `"--tray"`) {
		t.Error("deploy must never pass --tray as a launch argument")
	}
	if strings.Contains(deploy, "startRustDeskTray") || strings.Contains(deploy, "ensureRustDeskTrayRunning") {
		t.Error("deploy must not start a tray")
	}
}

// C: repair and reinstall converge the same way (reinstall reuses deploy).
func TestRepairAndReinstallDoNotRecreateTray(t *testing.T) {
	text := agentSource(t, "actions_windows.go")

	repair := text[strings.Index(text, "func handleRepairConfigRustDesk"):]
	repair = repair[:strings.Index(repair, "\nfunc ")]
	if !strings.Contains(repair, "removeManagedTrayArtifacts()") {
		t.Error("repair must remove tray artifacts")
	}
	if strings.Contains(repair, "startRustDeskTray") {
		t.Error("repair must not start a tray")
	}

	reinstall := text[strings.Index(text, "func handleReinstallRustDesk"):]
	reinstall = reinstall[:strings.Index(reinstall, "\nfunc ")]
	if !strings.Contains(reinstall, "executeDeployRemoteSupport(cfg, reinstallParams)") {
		t.Error("reinstall must reuse the managed MSI deploy flow (which removes tray)")
	}
}

// D: the heartbeat convergence pass removes tray artifacts.
func TestHeartbeatConvergenceRemovesTrayArtifacts(t *testing.T) {
	text := agentSource(t, "rustdesk_manage.go")
	if !strings.Contains(text, "removeManagedTrayArtifacts()") {
		t.Error("ensureRustDesk must converge by removing tray artifacts")
	}
	if strings.Contains(text, "func ensureRustDeskTrayRunning") || strings.Contains(text, "func startRustDeskTray") {
		t.Error("tray start helpers must no longer exist")
	}
}

// H: one authoritative SCM service-state implementation.
func TestServiceStateReadsGoThroughTheSharedSCMImplementation(t *testing.T) {
	manage := agentSource(t, "rustdesk_manage.go")
	if !strings.Contains(manage, "remoteSupportServiceState()") {
		t.Error("ensureRustDeskService must use the shared SCM state reader")
	}
	if strings.Contains(manage, `"sc", "query"`) {
		t.Error("rustdesk_manage.go must not parse sc.exe query output")
	}

	actions := agentSource(t, "actions_windows.go")
	if strings.Contains(actions, `"sc", "query"`) {
		t.Error("actions_windows.go must not parse sc.exe query output")
	}

	discovery := agentSource(t, "rustdesk.go")
	if strings.Contains(discovery, `exec.Command("sc"`) {
		t.Error("rustdesk.go must not shell out to sc.exe for service state")
	}

	runtime := agentSource(t, "rustdesk_runtime_windows.go")
	if !strings.Contains(runtime, "func windowsServiceState(") {
		t.Error("the shared SCM state reader must live in rustdesk_runtime_windows.go")
	}
}

// --------------------------------------------------------------------------- //
// Removal targeting: tray artifacts only, never the on-demand UI              //
// --------------------------------------------------------------------------- //

func TestCommandLineIsTrayLauncherOnlyMatchesTrayStartup(t *testing.T) {
	tray := []string{
		`"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" --tray`,
		`C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe --tray`,
		`"C:\Users\x\AppData\Local\Programs\TECHI Remote Support\rustdesk.exe" --tray`,
	}
	for _, value := range tray {
		if !commandLineIsTrayLauncher(value) {
			t.Errorf("expected tray launcher: %q", value)
		}
	}

	keep := []string{
		// The supported on-demand UI launcher — no arguments.
		`"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe"`,
		// The managed daemon.
		`"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" --service`,
		`"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" --server`,
		// The protocol handler.
		`"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" "%1"`,
		// Unrelated software.
		`"C:\Program Files\TechiAgent\techi-agent.exe"`,
	}
	for _, value := range keep {
		if commandLineIsTrayLauncher(value) {
			t.Errorf("must NOT be treated as tray startup: %q", value)
		}
	}
}

func TestShortcutBytesLaunchTrayDetectsBothEncodings(t *testing.T) {
	utf16 := func(s string) []byte {
		out := make([]byte, 0, len(s)*2)
		for _, r := range s {
			out = append(out, byte(r), 0)
		}
		return out
	}

	if !shortcutBytesLaunchTray([]byte("...TECHI Remote Support.exe--tray...")) {
		t.Error("ANSI --tray argument must be detected")
	}
	if !shortcutBytesLaunchTray(append([]byte{0x4C, 0x00, 0x00, 0x00}, utf16("--tray")...)) {
		t.Error("UTF-16LE --tray argument must be detected")
	}

	// F: the normal UI shortcut carries no arguments and must survive.
	uiShortcut := append([]byte{0x4C, 0x00, 0x00, 0x00}, utf16(`C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`)...)
	if shortcutBytesLaunchTray(uiShortcut) {
		t.Error("the argument-less UI shortcut must never be removed")
	}
}

func TestTrayArtifactRemovalSummary(t *testing.T) {
	empty := trayArtifactRemoval{}
	if empty.HasAny() || empty.Summary() != "none" {
		t.Errorf("empty removal = %q, want none", empty.Summary())
	}

	full := trayArtifactRemoval{
		ScheduledTask: true,
		RunKeys:       []string{`HKLM\TechiRemoteSupportTray`},
		Shortcuts:     []string{`C:\...\Startup\rs.lnk`},
		Processes:     2,
	}
	summary := full.Summary()
	for _, want := range []string{"scheduled_task", "run_keys=1", "startup_shortcuts=1", "processes=2"} {
		if !strings.Contains(summary, want) {
			t.Errorf("summary %q missing %q", summary, want)
		}
	}
}

// --------------------------------------------------------------------------- //
// E / G: classification without any tray process                              //
// --------------------------------------------------------------------------- //

// E: service + server runtime, no tray at all → running.
func TestManagedServiceAndServerWithoutTrayIsRunning(t *testing.T) {
	signals := classifyRemoteSupportProcessArgs([]string{
		`"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" --service`,
		`"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" --server`,
	}, false)
	if signals.Tray {
		t.Fatal("no tray process was present")
	}

	got := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		ManagedMSIRegistered: true,
		ServiceState:         "running",
		DaemonProcess:        signals.Daemon,
		TrayProcess:          signals.Tray,
		BrandedProcess:       signals.Branded,
	})
	if got != "running" {
		t.Fatalf("status = %q, want running", got)
	}
}

// G: a new managed deployment can never produce tray_only; only an existing
// unmanaged legacy endpoint can.
func TestTrayOnlyOnlyReachableForUnmanagedLegacyEndpoints(t *testing.T) {
	newDeployment := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		ManagedMSIRegistered: true,
		ServiceState:         "running",
		DaemonProcess:        true,
	})
	if newDeployment == "tray_only" {
		t.Fatal("a new managed deployment must never be tray_only")
	}

	legacy := classifyRustDeskWindowsRuntime(remoteSupportRuntimeSignals{
		ManagedMSIRegistered: false,
		TrayProcess:          true,
		BrandedProcess:       true,
	})
	if legacy != "tray_only" {
		t.Fatalf("unmanaged legacy endpoint = %q, want tray_only (migration marker)", legacy)
	}
}

// --------------------------------------------------------------------------- //
// Targeted process termination                                                 //
// --------------------------------------------------------------------------- //

// No code path may kill every process sharing the Remote Support image name:
// the managed daemon (--service/--server), the on-demand UI and any stray tray
// process all run "TECHI Remote Support.exe".
func TestNoBlanketImageNameKills(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		for _, line := range strings.Split(agentSource(t, file), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "//") {
				continue // comments explaining why we do NOT do this are fine
			}
			if strings.Contains(line, `"/IM"`) {
				t.Errorf("%s uses a blanket image-name kill: %s", file, strings.TrimSpace(line))
			}
		}
	}
}

func TestRuntimeStopUsesPIDTargeting(t *testing.T) {
	runtime := agentSource(t, "rustdesk_runtime_windows.go")
	for _, fn := range []string{
		"func killProcessesByPID(",
		"func remoteSupportProcessPIDs(",
		"func legacyRemoteSupportProcessPIDs(",
		"func remoteSupportTrayProcessPIDs(",
	} {
		if !strings.Contains(runtime, fn) {
			t.Errorf("missing PID-targeted helper: %s", fn)
		}
	}

	actions := agentSource(t, "actions_windows.go")
	if !strings.Contains(actions, "killProcessesByPID(\"legacy runtime stop\", legacyRemoteSupportProcessPIDs())") {
		t.Error("legacy runtime stop must terminate by PID")
	}
}

// The subcommand name must not imply tray creation.
func TestTraySubcommandIsNamedForRemoval(t *testing.T) {
	main := agentSource(t, "main.go")
	if !strings.Contains(main, `case "remove-tray-artifacts", "rs-tray-task":`) {
		t.Error("primary subcommand must be remove-tray-artifacts (rs-tray-task kept only as a field-MSI alias)")
	}
	if !strings.Contains(main, `case "stop-remote-support-runtime":`) {
		t.Error("stop-remote-support-runtime must be dispatchable for the MSI custom actions")
	}

	bootstrap := agentSource(t, "bootstrap_windows.go")
	if !strings.Contains(bootstrap, "func runRemoveTrayArtifactsCommand() int {") {
		t.Error("the command implementation must be named for removal")
	}
	if strings.Contains(bootstrap, "func runRSTrayTaskCommand") {
		t.Error("the create-implying function name must be gone")
	}
}

// --------------------------------------------------------------------------- //
// Install-path validation for termination                                      //
// --------------------------------------------------------------------------- //

func TestExecutablePathUnderAnyRequiresAnInstallDirectory(t *testing.T) {
	dirs := []string{
		`C:\Program Files\TECHI Remote Support`,
		`C:\Program Files\RustDesk`,
	}

	inside := []string{
		`C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`,
		`c:\program files\techi remote support\TECHI Remote Support.exe`, // case-insensitive
		`C:\Program Files\TECHI Remote Support\sub\TECHI Remote Support.exe`,
		`C:/Program Files/TECHI Remote Support/TECHI Remote Support.exe`, // separator-normalized
		`C:\Program Files\RustDesk\rustdesk.exe`,
	}
	for _, path := range inside {
		if !executablePathUnderAny(path, dirs) {
			t.Errorf("expected inside an install dir: %q", path)
		}
	}

	outside := []string{
		// The whole point: an unrelated executable sharing the filename.
		`C:\Users\bob\Downloads\TECHI Remote Support.exe`,
		`C:\Temp\rustdesk.exe`,
		// Directory-boundary confusion must not match.
		`C:\Program Files\TECHI Remote SupportX\TECHI Remote Support.exe`,
		`C:\Program Files\TECHI Remote Support.old\TECHI Remote Support.exe`,
		// Unverifiable path: never a target.
		``,
		`   `,
	}
	for _, path := range outside {
		if executablePathUnderAny(path, dirs) {
			t.Errorf("must NOT be treated as an install path: %q", path)
		}
	}
}

func TestExecutablePathFromCommandLine(t *testing.T) {
	cases := map[string]string{
		`"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" --service`: `C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`,
		`C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe --tray`:      `C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`,
		`"C:\Temp\rustdesk.exe"`: `C:\Temp\rustdesk.exe`,
		``:                       ``,
		`   `:                    ``,
		`"unterminated`:          ``,
	}
	for cmdline, want := range cases {
		if got := executablePathFromCommandLine(cmdline); got != want {
			t.Errorf("cmdline %q → %q, want %q", cmdline, got, want)
		}
	}
}

func TestTerminationSelectorsValidateTheInstallPath(t *testing.T) {
	runtime := agentSource(t, "rustdesk_runtime_windows.go")
	if !strings.Contains(runtime, "executablePathUnderAny(exePath, dirs)") {
		t.Error("the shared selector must validate the executable path")
	}
	if !strings.Contains(runtime, "executablePathUnderAny(exePath, managedDirs)") {
		t.Error("the tray sweep must validate against the managed install directories")
	}
	if !strings.Contains(runtime, "func verifiedRemoteSupportExePath(") {
		t.Error("an unverifiable executable path must be handled explicitly")
	}
}
