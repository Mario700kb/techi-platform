package main

import (
	"bufio"
	"bytes"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// cliProbeInterval throttles the --get-id/--version CLI probes below: each
// spawns a second instance of the single-instance-locked Remote Support exe,
// so probing on every heartbeat (every ~60s) piles up processes far faster
// than a kill-on-timeout can clean them up. Once we have a usable cached
// value there's no need to re-probe more than occasionally.
const cliProbeInterval = 30 * time.Minute

var (
	cliProbeMu      sync.Mutex
	cliProbeVersion string
	cliProbeVerAt   time.Time
	cliProbeIDAt    time.Time
)

func cachedRustDeskVersion(path string) string {
	cliProbeMu.Lock()
	if cliProbeVersion != "" && time.Since(cliProbeVerAt) < cliProbeInterval {
		v := cliProbeVersion
		cliProbeMu.Unlock()
		return v
	}
	cliProbeMu.Unlock()

	v := rustDeskVersion(path)
	cliProbeMu.Lock()
	if v != "" {
		cliProbeVersion = v
		cliProbeVerAt = time.Now()
	}
	cliProbeMu.Unlock()
	return v
}

func shouldProbeRustDeskID(currentID string) bool {
	if !isUsableRustDeskID(currentID) {
		return true
	}
	cliProbeMu.Lock()
	defer cliProbeMu.Unlock()
	return time.Since(cliProbeIDAt) >= cliProbeInterval
}

func recordRustDeskIDProbe() {
	cliProbeMu.Lock()
	cliProbeIDAt = time.Now()
	cliProbeMu.Unlock()
}

type RustDeskInfo struct {
	ID            string `json:"rustdesk_id"`
	EncID         string `json:"rustdesk_enc_id,omitempty"`
	InstallStatus string `json:"rustdesk_install_status"`
	Status        string `json:"rustdesk_status"`
	Version       string `json:"rustdesk_version"`
	InstallPath   string `json:"rustdesk_install_path"`
}

func discoverRustDesk(cfg *Config) RustDeskInfo {
	info := RustDeskInfo{
		ID:            configuredRustDeskID(cfg),
		InstallStatus: "unknown",
		Status:        "unknown",
	}

	switch runtime.GOOS {
	case "windows":
		info = discoverRustDeskWindows(info)
	default:
		info = discoverRustDeskPortable(info)
	}

	if info.ID == "" {
		info.ID = configuredRustDeskID(cfg)
	}
	return info
}

func configuredRustDeskID(cfg *Config) string {
	id := strings.TrimSpace(cfg.RustDeskID)
	if !isUsableRustDeskID(id) {
		return ""
	}
	return id
}

// normalizeRustDeskID strips whitespace and non-digit characters.
// "1 235 009 710" → "1235009710"
func normalizeRustDeskID(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// isNumericRustDeskID returns true for a normalized all-digit ID of 5–20 digits.
func isNumericRustDeskID(id string) bool {
	if len(id) < 5 || len(id) > 20 {
		return false
	}
	for _, r := range id {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func isUsableRustDeskID(id string) bool {
	id = strings.TrimSpace(id)
	if id == "" {
		return false
	}
	lower := strings.ToLower(id)
	if lower == "rustdesk-placeholder" || lower == "unknown" || lower == "unset" || lower == "none" {
		return false
	}
	if strings.HasPrefix(lower, "agent_") || strings.HasPrefix(lower, "pending_") {
		return false
	}
	return isNumericRustDeskID(normalizeRustDeskID(id))
}

// localRustDeskIDFromCLI runs `rustdesk.exe --get-id` and returns the
// normalized numeric ID (e.g. "1235009710") or "" if unavailable.
//
// This spawns a second instance of the (single-instance-locked) Remote
// Support exe. If it doesn't exit cleanly on its own, the 5s timeout below
// kills it -- but cmd.Process.Kill() only kills that one PID, not any
// children it spawned, so a hung/non-exiting --get-id leaves an orphaned
// process that holds the single-instance lock forever (manual launches of
// Remote Support then silently do nothing, since they just forward to the
// orphan instead of opening a window). killProcessTree below force-kills
// the whole tree as a safety net.
func localRustDeskIDFromCLI(installPath string) string {
	if installPath == "" {
		return ""
	}
	cmd := exec.Command(installPath, "--get-id")
	var out bytes.Buffer
	cmd.Stdout = &out
	done := make(chan error, 1)
	go func() { done <- cmd.Run() }()
	select {
	case <-time.After(5 * time.Second):
		if cmd.Process != nil {
			killProcessTree(cmd.Process.Pid)
		}
		return ""
	case <-done:
	}
	scanner := bufio.NewScanner(strings.NewReader(out.String()))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		id := normalizeRustDeskID(line)
		if isNumericRustDeskID(id) {
			return id
		}
	}
	return ""
}

// killProcessTree force-kills pid and its descendants. Used as a safety net
// when a spawned CLI probe (--get-id, --version) doesn't exit on its own --
// cmd.Process.Kill() alone only terminates the single PID we spawned.
func killProcessTree(pid int) {
	_, _ = runWithTimeout(5*time.Second, "taskkill", "/F", "/T", "/PID", strconv.Itoa(pid))
}

func discoverRustDeskWindows(info RustDeskInfo) RustDeskInfo {
	msi := detectRemoteSupportMSIRegistration("")
	installPath := firstExistingPath([]string{
		// Program Files is primary -- matches the proven TECHI-Remote-Support.iss
		// reference installer and the existing fleet's install location.
		// ProgramData/LOCALAPPDATA remain fallbacks for machines that picked up
		// the incorrect ProgramData install during the brief window it shipped.
		filepath.Join(os.Getenv("ProgramFiles"), "TECHI Remote Support", "TECHI Remote Support.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "TECHI Remote Support", "TECHI Remote Support.exe"),
		filepath.Join(os.Getenv("ProgramData"), "TECHI Remote Support", "TECHI Remote Support.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "TECHI Remote Support", "TECHI Remote Support.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "TECHI Remote Support", "rustdesk.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "TECHI Remote Support", "rustdesk.exe"),
		filepath.Join(os.Getenv("ProgramData"), "TECHI Remote Support", "rustdesk.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "TECHI Remote Support", "rustdesk.exe"),
	})

	if installPath != "" {
		info.InstallStatus = "installed"
		info.InstallPath = installPath
	} else {
		info.InstallStatus = "not_installed"
	}
	if msi.Version != "" {
		if fullPath := firstExistingPath(remoteSupportFullMSIPaths()); fullPath != "" {
			info.InstallStatus = "installed"
			info.InstallPath = fullPath
		}
	}

	// The managed MSI's registry DisplayVersion is authoritative and lives in a
	// DIFFERENT namespace than the executable's own --version (MSI ProductVersion
	// e.g. "1.4.6.29665273" vs app semantic version e.g. "1.4.6"). We only probe
	// the executable when there is no managed registration at all, and we log
	// loudly when we do -- a failed registry lookup must never silently
	// masquerade as a healthy managed install reporting a semantic version.
	fileVersion := ""
	if msi.Version == "" && installPath != "" {
		fileVersion = cachedRustDeskVersion(installPath)
	}
	version, source := remoteSupportReportedVersion(msi, fileVersion)
	info.Version = version
	if source == "file_version" {
		log.Printf("[rustdesk] no managed MSI registration for %s — reporting executable --version %q (app semantic version, NOT MSI ProductVersion)", installPath, version)
	}

	info.Status = rustDeskWindowsStatus(msi.Version != "")

	// Prefer CLI: rustdesk.exe --get-id gives the exact ID shown in the UI.
	// Only probe when we don't have a usable ID yet, or periodically to
	// catch drift -- see cliProbeInterval.
	if installPath != "" && shouldProbeRustDeskID(info.ID) {
		if cliID := localRustDeskIDFromCLI(installPath); cliID != "" {
			info.ID = cliID
		}
		recordRustDeskIDProbe()
	}

	// Read TOML files for encID, and ID as fallback if CLI produced nothing.
	fileID, encID := readRustDeskFromKnownFiles()
	if info.ID == "" && fileID != "" {
		info.ID = fileID
	}
	if encID != "" {
		info.EncID = encID
	}
	return info
}

func discoverRustDeskPortable(info RustDeskInfo) RustDeskInfo {
	installPath, err := exec.LookPath("rustdesk")
	if err == nil && installPath != "" {
		info.InstallStatus = "installed"
		info.InstallPath = installPath
		info.Version = rustDeskVersion(installPath)
		info.Status = "unknown"
	} else {
		info.InstallStatus = "not_installed"
		info.Status = "not_installed"
	}

	id, encID := readRustDeskFromKnownFiles()
	if id != "" {
		info.ID = id
	}
	if encID != "" {
		info.EncID = encID
	}
	return info
}

func firstExistingPath(paths []string) string {
	for _, path := range paths {
		if path == "" {
			continue
		}
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return ""
}

func rustDeskVersion(path string) string {
	if path == "" {
		return ""
	}
	cmd := exec.Command(path, "--version")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	done := make(chan error, 1)
	go func() { done <- cmd.Run() }()
	select {
	case <-time.After(2 * time.Second):
		if cmd.Process != nil {
			killProcessTree(cmd.Process.Pid)
		}
		return ""
	case err := <-done:
		if err != nil {
			return ""
		}
		return strings.TrimSpace(out.String())
	}
}

// rustDeskWindowsStatus gathers the runtime signals and classifies them.
// managedMSIRegistered is authoritative installation-topology evidence: it comes
// from the uninstall registry (ProductCode first), NOT from anything a running
// process can fake.
func rustDeskWindowsStatus(managedMSIRegistered bool) string {
	signals := remoteSupportRuntimeSignals{ManagedMSIRegistered: managedMSIRegistered}

	// Service state via the SCM API (numeric SERVICE_STATUS code) -- no sc.exe
	// output parsing, so service-name quoting, exit codes and localized output
	// cannot silently turn into a wrong classification. An undetermined state is
	// logged with its reason and never treated as evidence of a tray-only install.
	state, err := remoteSupportServiceState()
	if err != nil {
		log.Printf("[rustdesk] service state undetermined: %v", err)
	}
	signals.ServiceState = state

	procs := collectRemoteSupportProcessSignals()
	signals.DaemonProcess = procs.Daemon
	signals.TrayProcess = procs.Tray
	signals.BrandedProcess = procs.Branded
	signals.LegacyProcess = procs.Legacy
	signals.LegacyServiceRunning = legacyRemoteSupportServiceRunning()

	return classifyRustDeskWindowsRuntime(signals)
}

// remoteSupportReportedVersion returns the version to report for the heartbeat
// plus the namespace it came from: "msi_registry" (the managed MSI's registry
// DisplayVersion -- authoritative), "file_version" (the executable's own
// semantic --version -- informational fallback for unmanaged/legacy installs
// only), or "unknown".
func remoteSupportReportedVersion(msi remoteSupportMSIRegistration, fileVersion string) (string, string) {
	if version := strings.TrimSpace(msi.Version); version != "" {
		return version, "msi_registry"
	}
	if version := strings.TrimSpace(fileVersion); version != "" {
		return version, "file_version"
	}
	return "", "unknown"
}

func selectRemoteSupportVersion(fileVersion string, msi remoteSupportMSIRegistration) string {
	version, _ := remoteSupportReportedVersion(msi, fileVersion)
	return version
}

// remoteSupportServiceStateName maps a numeric Windows SERVICE_STATUS state
// (winsvc.h) to our vocabulary. Numeric codes are locale-independent -- the
// English words in sc.exe output are not.
func remoteSupportServiceStateName(code uint32) string {
	switch code {
	case 1: // SERVICE_STOPPED
		return "stopped"
	case 2, 3, 5, 6: // START/STOP/CONTINUE/PAUSE_PENDING
		return "pending"
	case 4: // SERVICE_RUNNING
		return "running"
	case 7: // SERVICE_PAUSED
		return "paused"
	default:
		return ""
	}
}

// remoteSupportProcessSignals separates the managed daemon from the cosmetic
// tray. All four Remote Support processes share one image name, so the command
// line -- not the image name -- decides the role.
type remoteSupportProcessSignals struct {
	Daemon  bool // "--service" or "--server": the actual connection daemon
	Tray    bool // "--tray" only: the cosmetic UI companion
	Branded bool // branded exe seen, role possibly unknown (unreadable cmdline)
	Legacy  bool // upstream rustdesk.exe present
}

// classifyRemoteSupportProcessArgs maps observed branded command lines to roles.
// An entry that is empty (command line unreadable, e.g. a protected process)
// still counts as "branded" but claims neither daemon nor tray -- failing safe
// rather than inventing evidence in either direction.
func classifyRemoteSupportProcessArgs(brandedCmdlines []string, legacyPresent bool) remoteSupportProcessSignals {
	signals := remoteSupportProcessSignals{Legacy: legacyPresent}
	for _, raw := range brandedCmdlines {
		signals.Branded = true
		lower := strings.ToLower(raw)
		if strings.Contains(lower, "--service") || strings.Contains(lower, "--server") {
			signals.Daemon = true
			continue
		}
		if strings.Contains(lower, "--tray") {
			signals.Tray = true
		}
	}
	return signals
}

// remoteSupportManagedInstallDirs are the directories a MANAGED Remote Support
// installation can live in (Program Files is the supported location; the others
// are historical install paths still present in the fleet). Termination is
// restricted to executables under these directories.
func remoteSupportManagedInstallDirs() []string {
	return []string{
		filepath.Join(os.Getenv("ProgramFiles"), "TECHI Remote Support"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "TECHI Remote Support"),
		filepath.Join(os.Getenv("ProgramData"), "TECHI Remote Support"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "TECHI Remote Support"),
	}
}

// remoteSupportLegacyInstallDirs are the upstream RustDesk install directories a
// legacy runtime can occupy.
func remoteSupportLegacyInstallDirs() []string {
	return []string{
		filepath.Join(os.Getenv("ProgramFiles"), "RustDesk"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "RustDesk"),
		filepath.Join(os.Getenv("ProgramData"), "RustDesk"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "RustDesk"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "RustDesk"),
	}
}

func remoteSupportAllInstallDirs() []string {
	return append(remoteSupportManagedInstallDirs(), remoteSupportLegacyInstallDirs()...)
}

// executablePathUnderAny reports whether exePath sits inside one of dirs.
// Comparison is case-insensitive and separator-normalized (Windows paths), and
// requires a directory boundary so "…\TECHI Remote SupportX\a.exe" cannot match
// "…\TECHI Remote Support". An empty path never matches: an executable we could
// not verify is never a termination target.
func executablePathUnderAny(exePath string, dirs []string) bool {
	normalize := func(value string) string {
		value = strings.ReplaceAll(strings.TrimSpace(value), "/", `\`)
		return strings.ToLower(value)
	}
	path := normalize(exePath)
	if path == "" {
		return false
	}
	for _, dir := range dirs {
		prefix := normalize(dir)
		if prefix == "" || prefix == `\` {
			continue
		}
		prefix = strings.TrimRight(prefix, `\`) + `\`
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

// executablePathFromCommandLine extracts the image path from a command line,
// used to verify a process whose executable path could not be read directly.
// Handles the quoted form ("C:\...\TECHI Remote Support.exe" --service) and the
// unquoted form by cutting at the first ".exe".
func executablePathFromCommandLine(cmdline string) string {
	cmdline = strings.TrimSpace(cmdline)
	if cmdline == "" {
		return ""
	}
	if strings.HasPrefix(cmdline, `"`) {
		if end := strings.Index(cmdline[1:], `"`); end >= 0 {
			return cmdline[1 : 1+end]
		}
		return ""
	}
	lower := strings.ToLower(cmdline)
	if idx := strings.Index(lower, ".exe"); idx >= 0 {
		return cmdline[:idx+len(".exe")]
	}
	return ""
}

// trayArtifactRemoval records what a tray-removal convergence pass removed.
// Tray mode is deprecated: this type only ever describes deletions.
type trayArtifactRemoval struct {
	ScheduledTask bool
	RunKeys       []string
	Shortcuts     []string
	Processes     int
}

func (r trayArtifactRemoval) HasAny() bool {
	return r.ScheduledTask || len(r.RunKeys) > 0 || len(r.Shortcuts) > 0 || r.Processes > 0
}

func (r trayArtifactRemoval) Summary() string {
	if !r.HasAny() {
		return "none"
	}
	parts := []string{}
	if r.ScheduledTask {
		parts = append(parts, "scheduled_task")
	}
	if len(r.RunKeys) > 0 {
		parts = append(parts, "run_keys="+strconv.Itoa(len(r.RunKeys)))
	}
	if len(r.Shortcuts) > 0 {
		parts = append(parts, "startup_shortcuts="+strconv.Itoa(len(r.Shortcuts)))
	}
	if r.Processes > 0 {
		parts = append(parts, "processes="+strconv.Itoa(r.Processes))
	}
	return strings.Join(parts, ",")
}

// commandLineIsTrayLauncher reports whether an autostart command line launches
// Remote Support in the deprecated background tray mode. A command line that
// points at the exe WITHOUT --tray is a user-facing launcher (the supported
// on-demand UI) and must never be removed.
func commandLineIsTrayLauncher(value string) bool {
	lower := strings.ToLower(value)
	if !strings.Contains(lower, "techi remote support.exe") && !strings.Contains(lower, "rustdesk.exe") {
		return false
	}
	return strings.Contains(lower, "--tray")
}

// shortcutBytesLaunchTray reports whether a .lnk file's raw bytes contain a
// "--tray" argument. Shortcut arguments are stored as UTF-16LE (and, in older
// shortcuts, ANSI), so both encodings are checked. Byte-level matching keeps
// this dependency-free and, crucially, exact: the normal UI shortcut passes no
// arguments and therefore cannot match.
func shortcutBytesLaunchTray(data []byte) bool {
	const marker = "--tray"
	if bytes.Contains(data, []byte(marker)) {
		return true
	}
	utf16LE := make([]byte, 0, len(marker)*2)
	for _, r := range marker {
		utf16LE = append(utf16LE, byte(r), 0)
	}
	return bytes.Contains(data, utf16LE)
}

// remoteSupportRuntimeSignals is the full evidence set the classifier decides on.
type remoteSupportRuntimeSignals struct {
	// ServiceState is "running", "stopped", "pending", "paused" or "" (could not
	// be determined -- an absence of evidence, never evidence of absence).
	ServiceState string
	// ManagedMSIRegistered: the managed TECHI Remote Support MSI is registered in
	// the uninstall registry. Authoritative installation topology.
	ManagedMSIRegistered bool
	DaemonProcess        bool
	TrayProcess          bool
	BrandedProcess       bool
	LegacyProcess        bool
	LegacyServiceRunning bool
}

// classifyRustDeskWindowsRuntime derives the reported rustdesk_status.
//
// A managed installation is described in SERVICE terms only -- "running",
// "starting", "stopped", "service_error", "conflicting_dual_install". No tray
// concept takes part in describing it: what a "--tray" process is or isn't doing
// cannot change a managed verdict.
//
// INVARIANT: "tray_only" may only be returned when ManagedMSIRegistered is
// false. It is purely a discovery marker for an old, unmigrated endpoint.
func classifyRustDeskWindowsRuntime(signals remoteSupportRuntimeSignals) string {
	state := strings.ToLower(strings.TrimSpace(signals.ServiceState))
	branded := signals.BrandedProcess || signals.DaemonProcess || signals.TrayProcess

	if signals.ManagedMSIRegistered {
		if signals.LegacyProcess || signals.LegacyServiceRunning {
			return "conflicting_dual_install"
		}
		// Either signal proves the daemon is up. The SCM read is allowed to be
		// unavailable without changing the verdict.
		if state == "running" || signals.DaemonProcess {
			return "running"
		}
		switch state {
		case "pending":
			// SCM start/stop/continue pending: a transition, not a fault.
			return "starting"
		case "stopped":
			// SCM is authoritative that the service is not running.
			return "stopped"
		}
		// Paused, or the service state could not be read at all, with no daemon
		// process to prove otherwise: the managed service is not providing the
		// runtime and we cannot say it is cleanly stopped.
		return "service_error"
	}

	// Unmanaged / legacy endpoint: preserved as-is so migration reporting keeps
	// flagging these for deployment of the managed MSI.
	switch state {
	case "running":
		if signals.LegacyProcess || signals.LegacyServiceRunning {
			return "conflicting_dual_install"
		}
		return "running"
	case "stopped":
		if branded || signals.LegacyProcess {
			return "tray_only"
		}
		return "stopped"
	}
	if branded || signals.LegacyProcess {
		return "tray_only"
	}
	if signals.LegacyServiceRunning {
		return "legacy_service_running"
	}
	return "not_running"
}

type remoteSupportMSIRegistration struct {
	ProductCode string
	Version     string
}

// managedRemoteSupportProductCode is the ProductCode of the managed TECHI
// Remote Support MSI -- the only supported installation. Discovery looks this up
// FIRST (a direct, exact uninstall-key read, the same one the deploy action uses
// successfully) instead of opening with a registry-wide text search, which was
// silently returning nothing and degrading the reported version into the app's
// semantic-version namespace.
const managedRemoteSupportProductCode = "{74CEDF4A-E226-4151-BC7A-5154F0BC9E79}"

// Indirection points so the discovery ORDER (ProductCode first, ARP name scan
// only as fallback) is testable without a Windows registry.
var (
	uninstallDisplayVersionLookup    = queryUninstallDisplayVersion
	arpRemoteSupportRegistrationScan = scanARPForRemoteSupportRegistration
)

func remoteSupportFullMSIPaths() []string {
	return []string{
		filepath.Join(os.Getenv("ProgramFiles"), "TECHI Remote Support", "TECHI Remote Support.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "TECHI Remote Support", "TECHI Remote Support.exe"),
	}
}

// detectRemoteSupportMSIRegistration resolves the managed MSI registration,
// ProductCode first. Every failure branch is logged: a lookup that finds nothing
// must be visible, never silently absorbed into a semantic-version fallback.
func detectRemoteSupportMSIRegistration(productGUID string) remoteSupportMSIRegistration {
	guid := strings.TrimSpace(productGUID)
	if guid == "" {
		guid = managedRemoteSupportProductCode
	}
	if version := uninstallDisplayVersionLookup(guid); version != "" {
		return remoteSupportMSIRegistration{ProductCode: guid, Version: version}
	}
	log.Printf("[rustdesk] ProductCode %s has no DisplayVersion in the uninstall registry — falling back to ARP name scan", guid)

	registration := arpRemoteSupportRegistrationScan()
	if registration.Version == "" {
		log.Printf("[rustdesk] no managed Remote Support MSI registration found (ProductCode lookup and ARP name scan both failed)")
		return registration
	}
	log.Printf("[rustdesk] managed MSI found by ARP name scan: ProductCode=%s DisplayVersion=%s", registration.ProductCode, registration.Version)
	return registration
}

// scanARPForRemoteSupportRegistration is the fallback: a registry-wide
// Add/Remove-Programs search by DisplayName. Only used when the ProductCode
// lookup above finds nothing (e.g. an MSI rebuilt with a new ProductCode).
func scanARPForRemoteSupportRegistration() remoteSupportMSIRegistration {
	for _, root := range []string{
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
		`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
	} {
		out, err := runWithTimeout(10*time.Second, "reg", "query", root, "/s", "/f", "TECHI Remote Support", "/d")
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(out), "\n") {
			key := strings.TrimSpace(line)
			if !strings.HasPrefix(strings.ToUpper(key), "HKEY_LOCAL_MACHINE\\") {
				continue
			}
			name := queryRegistryStringValue(key, "DisplayName")
			if !strings.EqualFold(strings.TrimSpace(name), "TECHI Remote Support") {
				continue
			}
			version := queryRegistryStringValue(key, "DisplayVersion")
			if version == "" {
				continue
			}
			productCode := filepath.Base(key)
			return remoteSupportMSIRegistration{ProductCode: productCode, Version: version}
		}
	}
	return remoteSupportMSIRegistration{}
}

func queryUninstallDisplayVersion(guid string) string {
	if guid == "" {
		return ""
	}
	for _, root := range []string{
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\` + guid,
		`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\` + guid,
	} {
		if version := queryRegistryStringValue(root, "DisplayVersion"); version != "" {
			return version
		}
	}
	return ""
}

func queryRegistryStringValue(root string, valueName string) string {
	out, err := runWithTimeout(5*time.Second, "reg", "query", root, "/v", valueName)
	if err != nil {
		return ""
	}
	valueName = strings.ToLower(valueName)
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(strings.ToLower(line), valueName) {
			parts := strings.Fields(line)
			if len(parts) >= 3 {
				return strings.Join(parts[2:], " ")
			}
		}
	}
	return ""
}

func readRustDeskFromKnownFiles() (id, encID string) {
	for _, path := range rustDeskConfigCandidates() {
		fileID, fileEncID := readRustDeskFieldsFromFile(path)
		if id == "" && fileID != "" {
			id = fileID
		}
		if encID == "" && fileEncID != "" {
			encID = fileEncID
		}
		if id != "" && encID != "" {
			return
		}
	}
	return
}

func rustDeskConfigCandidates() []string {
	home, _ := os.UserHomeDir()
	candidates := []string{
		filepath.Join(os.Getenv("APPDATA"), "TECHI Remote Support", "config", "TECHI Remote Support2.toml"),
		filepath.Join(os.Getenv("APPDATA"), "TECHI Remote Support", "config", "TECHI Remote Support.toml"),
		filepath.Join(os.Getenv("APPDATA"), "TECHI Remote Support", "config", "TECHI Remote Support2_local.toml"),
		filepath.Join(os.Getenv("APPDATA"), "TECHI Remote Support", "config", "TECHI Remote Support_local.toml"),
		filepath.Join(os.Getenv("APPDATA"), "TECHI Remote Support", "TECHI Remote Support2.toml"),
		filepath.Join(os.Getenv("APPDATA"), "TECHI Remote Support", "TECHI Remote Support.toml"),
		filepath.Join(os.Getenv("PROGRAMDATA"), "TECHI Remote Support", "config", "TECHI Remote Support2.toml"),
		filepath.Join(os.Getenv("PROGRAMDATA"), "TECHI Remote Support", "config", "TECHI Remote Support.toml"),
		filepath.Join(os.Getenv("PROGRAMDATA"), "TECHI Remote Support", "config", "TECHI Remote Support2_local.toml"),
		filepath.Join(os.Getenv("PROGRAMDATA"), "TECHI Remote Support", "config", "TECHI Remote Support_local.toml"),
		filepath.Join(os.Getenv("SystemRoot"), "ServiceProfiles", "LocalService", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support2.toml"),
		filepath.Join(os.Getenv("SystemRoot"), "ServiceProfiles", "LocalService", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support.toml"),
		filepath.Join(os.Getenv("SystemRoot"), "ServiceProfiles", "LocalService", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support2_local.toml"),
		filepath.Join(os.Getenv("SystemRoot"), "ServiceProfiles", "LocalService", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support_local.toml"),
		filepath.Join(home, ".config", "TECHI Remote Support", "TECHI Remote Support2.toml"),
		filepath.Join(home, ".config", "TECHI Remote Support", "TECHI Remote Support.toml"),
		filepath.Join(home, "Library", "Application Support", "TECHI Remote Support", "TECHI Remote Support2.toml"),
		filepath.Join(home, "Library", "Application Support", "TECHI Remote Support", "TECHI Remote Support.toml"),
	}
	for _, pattern := range []string{
		filepath.Join(os.Getenv("SystemDrive")+string(os.PathSeparator), "Users", "*", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support2.toml"),
		filepath.Join(os.Getenv("SystemDrive")+string(os.PathSeparator), "Users", "*", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support.toml"),
		filepath.Join(os.Getenv("SystemDrive")+string(os.PathSeparator), "Users", "*", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support2_local.toml"),
		filepath.Join(os.Getenv("SystemDrive")+string(os.PathSeparator), "Users", "*", "AppData", "Roaming", "TECHI Remote Support", "config", "TECHI Remote Support_local.toml"),
	} {
		if matches, err := filepath.Glob(pattern); err == nil {
			candidates = append(candidates, matches...)
		}
	}
	return candidates
}

func readRustDeskFieldsFromFile(path string) (id, encID string) {
	if path == "" {
		return
	}
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimPrefix(strings.TrimSpace(scanner.Text()), "\ufeff")
		lower := strings.ToLower(line)
		if !strings.Contains(lower, "id") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.Trim(strings.ToLower(parts[0]), " \"'")
		value := strings.SplitN(parts[1], "#", 2)[0]
		value = strings.Trim(strings.TrimSpace(value), " \"'")

		switch key {
		case "id", "rustdesk_id":
			if id == "" {
				normalized := normalizeRustDeskID(value)
				if isNumericRustDeskID(normalized) {
					id = normalized
				}
			}
		case "enc_id":
			if encID == "" && value != "" {
				encID = value
			}
		}
	}
	return
}
