//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// Windows process-creation flags used to detach the restart-helper process so
// it survives after the TechiAgent service itself is stopped.
const (
	_CREATE_NEW_PROCESS_GROUP = 0x00000200
	_CREATE_NO_WINDOW         = 0x08000000
)

// handleRestartDevice schedules an immediate OS reboot via `shutdown /r /t 0 /f`.
// The actual shutdown is deferred 3 seconds so the completeAction HTTP callback
// can reach the backend before network is torn down.
func handleRestartDevice(_ context.Context) actionResult {
	go func() {
		time.Sleep(3 * time.Second)
		log.Printf("[action] restart_device: issuing shutdown /r /t 0 /f")
		if _, err := runWithTimeout(10*time.Second, "shutdown", "/r", "/t", "0", "/f"); err != nil {
			log.Printf("[action] restart_device: shutdown command failed: %v", err)
		}
	}()
	log.Printf("[action] restart_device: OS restart scheduled — will execute in ~3 seconds")
	return actionResult{message: "PC restart initiated — system shutting down in ~3 seconds"}
}

// handleRestartAgent launches a detached PowerShell process that waits 5 seconds
// and then calls Restart-Service. The delay gives the completeAction callback
// time to reach the backend before the TechiAgent service process is stopped.
// The child process is detached (new process group, no window) so it survives
// when Windows SCM stops the TechiAgent service.
func handleRestartAgent(_ context.Context) actionResult {
	// Use single-line PowerShell to avoid any quoting issues on older PS versions.
	script := `Start-Sleep -Seconds 5; ` +
		`try { Restart-Service -Name TechiAgent -Force -ErrorAction Stop } ` +
		`catch { exit 1 }`

	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
		"-Command", script,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: _CREATE_NEW_PROCESS_GROUP | _CREATE_NO_WINDOW,
	}

	if err := cmd.Start(); err != nil {
		return actionResult{
			err:    fmt.Errorf("restart_agent: failed to schedule restart: %w", err),
			stderr: err.Error(),
		}
	}
	// Release detaches the child process from this process so it is not
	// automatically killed when the TechiAgent service process exits.
	_ = cmd.Process.Release()

	log.Printf("[action] restart_agent: detached PowerShell restart helper launched (5s delay before Restart-Service TechiAgent)")
	return actionResult{
		message: "Agent service restart scheduled — TechiAgent will stop and restart within ~15 seconds",
	}
}

func handleRestartRustDesk(ctx context.Context, cfg *Config) actionResult {
	release, err := acquireRemoteSupportRepairLock()
	if err != nil {
		return actionResult{err: err}
	}
	done := make(chan actionResult, 1)
	go func() {
		defer release()
		log.Printf("[action] restart_rustdesk: stopping service+tray")
		stopRustDeskServiceFn()
		stopRustDeskTray()
		time.Sleep(2 * time.Second)

		log.Printf("[action] restart_rustdesk: starting service+tray")
		if err := startRustDeskServiceFn(); err != nil {
			done <- actionResult{
				err:    fmt.Errorf("start service failed: %w", err),
				stderr: err.Error(),
			}
			return
		}
		if err := startRustDeskTray(); err != nil {
			log.Printf("[action] restart_rustdesk: tray start failed (non-fatal): %v", err)
		}
		rd := discoverRustDesk(cfg)
		done <- actionResult{
			message: fmt.Sprintf("TECHI Remote Support restarted — status=%s id=%s", rd.Status, rd.ID),
		}
	}()
	select {
	case <-ctx.Done():
		return actionResult{err: fmt.Errorf("restart_rustdesk timed out")}
	case r := <-done:
		return r
	}
}

func handleReinstallRustDesk(ctx context.Context, cfg *Config, params map[string]interface{}) actionResult {
	release, lockErr := acquireRemoteSupportRepairLock()
	if lockErr != nil {
		err := fmt.Errorf("reinstall phase=acquire_lock: %w", lockErr)
		return actionResult{err: err, stderr: err.Error()}
	}
	defer release()

	result, err := executeRemoteSupportReinstall(ctx, newWindowsRemoteSupportReinstallOps(cfg, params))
	if err != nil {
		return actionResult{err: err, stderr: err.Error()}
	}
	rd := discoverRustDesk(cfg)
	return actionResult{message: fmt.Sprintf(
		"TECHI Remote Support %s: version=%s id=%s", result.status, result.version, rd.ID,
	)}
}

func handleReopenRustDesk(ctx context.Context, cfg *Config) actionResult {
	release, err := acquireRemoteSupportRepairLock()
	if err != nil {
		return actionResult{err: err}
	}
	done := make(chan actionResult, 1)
	go func() {
		defer release()
		rd := discoverRustDesk(cfg)
		if rd.Status == "running" {
			if err := openRustDeskDesktopUI(rd.InstallPath); err != nil {
				done <- actionResult{
					err:    fmt.Errorf("reopen_rustdesk: %w", err),
					stderr: rustDeskStatusUILaunchFailed,
				}
				return
			}
			done <- actionResult{message: fmt.Sprintf("TECHI Remote Support UI restored — status=%s id=%s", rd.Status, rd.ID)}
			return
		}
		log.Printf("[action] reopen_rustdesk: status=%s — launching desktop UI", rd.Status)
		if err := openRustDeskDesktopUI(rd.InstallPath); err != nil {
			done <- actionResult{
				err:    fmt.Errorf("reopen_rustdesk: %w", err),
				stderr: rustDeskStatusUILaunchFailed,
			}
			return
		}
		rd = discoverRustDesk(cfg)
		if rd.Status != "running" {
			done <- actionResult{
				err:    fmt.Errorf("reopen_rustdesk: %s", rustDeskStatusUILaunchFailed),
				stderr: fmt.Sprintf("status=%s", rd.Status),
			}
			return
		}
		done <- actionResult{
			message: fmt.Sprintf("TECHI Remote Support reopened — status=%s id=%s", rd.Status, rd.ID),
		}
	}()
	select {
	case <-ctx.Done():
		return actionResult{err: fmt.Errorf("reopen_rustdesk timed out")}
	case r := <-done:
		return r
	}
}

func handleRepairConfigRustDesk(ctx context.Context, cfg *Config) actionResult {
	release, err := acquireRemoteSupportRepairLock()
	if err != nil {
		return actionResult{err: err}
	}
	done := make(chan actionResult, 1)
	go func() {
		defer release()
		log.Printf("[action] repair_config_rustdesk: stopping service and all owned processes before config synchronization")
		stopRustDeskServiceFn()
		stopRustDeskTray()
		time.Sleep(2 * time.Second)

		canonical, err := loadCanonicalRustDeskIdentity()
		if err != nil {
			_ = startRustDeskServiceFn()
			_ = startRustDeskTray()
			done <- actionResult{
				err:    fmt.Errorf("canonical identity selection failed: %w", err),
				stderr: err.Error(),
			}
			return
		}
		log.Printf("[action] repair_config_rustdesk: atomically synchronizing canonical user identity")
		changed, err := synchronizeCanonicalRustDeskConfig(cfg, canonical, false)
		if err != nil {
			_ = startRustDeskServiceFn()
			_ = startRustDeskTray()
			done <- actionResult{
				err:    fmt.Errorf("config synchronization failed: %w", err),
				stderr: err.Error(),
			}
			return
		}

		log.Printf("[action] repair_config_rustdesk: starting service+tray")
		if err2 := startRustDeskServiceFn(); err2 != nil {
			done <- actionResult{
				err:    fmt.Errorf("service restart failed after config repair: %w", err2),
				stderr: err2.Error(),
			}
			return
		}
		if err2 := startRustDeskTray(); err2 != nil {
			done <- actionResult{
				err:    fmt.Errorf("UI restart failed after config repair: %w", err2),
				stderr: err2.Error(),
			}
			return
		}

		time.Sleep(2 * time.Second)
		if err := validateCanonicalRustDeskIdentity(cfg, canonical); err != nil {
			done <- actionResult{err: err, stderr: err.Error()}
			return
		}
		rd := discoverRustDesk(cfg)
		action := "verified"
		if changed {
			action = "repaired"
		}
		done <- actionResult{
			message: fmt.Sprintf(
				"TECHI Remote Support config %s — service restarted, status=%s id=%s",
				action, rd.Status, rd.ID,
			),
		}
	}()
	select {
	case <-ctx.Done():
		return actionResult{err: fmt.Errorf("repair_config_rustdesk timed out")}
	case r := <-done:
		return r
	}
}

// ------------------------------------------------------------------ //
// deploy_remote_support                                                //
// ------------------------------------------------------------------ //

type deployRemoteSupportResult struct {
	InstalledVersion string `json:"installed_version"`
	InstallStatus    string `json:"install_status"`
	ConfigStatus     string `json:"config_status"`
	ServiceStatus    string `json:"service_status"`
	ProtocolStatus   string `json:"protocol_status"`
	RustDeskID       string `json:"rustdesk_id"`
	RebootRequired   bool   `json:"reboot_required"`
}

func handleDeployRemoteSupport(ctx context.Context, cfg *Config, params map[string]interface{}) actionResult {
	release, err := acquireRemoteSupportRepairLock()
	if err != nil {
		return actionResult{err: err}
	}
	done := make(chan actionResult, 1)
	go func() {
		defer release()
		done <- executeDeployRemoteSupport(cfg, params)
	}()
	select {
	case <-ctx.Done():
		return actionResult{err: fmt.Errorf("deploy_remote_support timed out")}
	case r := <-done:
		return r
	}
}

func executeDeployRemoteSupport(cfg *Config, params map[string]interface{}) actionResult {
	msiURL := stringParam(params, "msi_url")
	msiVersion := stringParam(params, "msi_version")
	productGUID := stringParam(params, "product_guid")
	rendezvousServer := stringParam(params, "rendezvous_server")
	key := stringParam(params, "key")
	forceReinstall := boolParam(params, "force_reinstall")

	// Fall back to agent config values if not provided in params.
	if msiURL == "" {
		msiURL = cfg.RustDeskMSIUrl
	}
	if rendezvousServer == "" {
		rendezvousServer = cfg.RustDeskRendezvousServer
	}
	if key == "" {
		key = cfg.RustDeskKey
	}

	st := deployRemoteSupportResult{}

	// Phase 1 & 2: version check via registry GUID.
	installedVersion := getInstalledVersionByGUID(productGUID)
	st.InstalledVersion = installedVersion
	needsInstall := installedVersion == "" ||
		(msiVersion != "" && installedVersion != msiVersion) ||
		forceReinstall

	if !needsInstall {
		log.Printf("[deploy_remote_support] version %s already installed — skipping MSI install", installedVersion)
		st.InstallStatus = "already_current"
	} else {
		// Phase 3: download + install.
		if msiURL == "" {
			return actionResult{err: fmt.Errorf("deploy_remote_support: no msi_url provided")}
		}

		// Build a temporary config copy for the download helpers.
		dlCfg := *cfg
		dlCfg.RustDeskMSIUrl = msiURL
		dlCfg.RustDeskPackageVersion = msiVersion
		dlCfg.RustDeskMSIChecksumSHA256 = ""

		cachePath, err := cachedMSIPath(&dlCfg)
		if err != nil {
			return actionResult{err: fmt.Errorf("deploy_remote_support: cache path: %w", err)}
		}
		if err := ensureCachedMSI(&dlCfg, cachePath); err != nil {
			return actionResult{err: fmt.Errorf("deploy_remote_support: download failed: %w", err)}
		}

		log.Printf("[deploy_remote_support] installing %s", cachePath)
		var rebootReq bool
		var installErr error
		for attempt := 1; attempt <= 3; attempt++ {
			rebootReq, installErr = runMSIInstall(cachePath)
			if installErr == nil {
				break
			}
			if attempt < 3 {
				delay := time.Duration(attempt) * 10 * time.Second
				log.Printf("[deploy_remote_support] install attempt %d failed: %v; retrying in %s", attempt, installErr, delay)
				time.Sleep(delay)
			}
		}
		if installErr != nil {
			return actionResult{err: fmt.Errorf("deploy_remote_support: install failed: %w", installErr)}
		}
		st.RebootRequired = rebootReq

		// Wait briefly for the installer to commit to the registry.
		time.Sleep(3 * time.Second)

		// Phase 4: verify installation is visible in registry or on disk.
		if verified := getInstalledVersionByGUID(productGUID); verified != "" {
			st.InstalledVersion = verified
		} else if !isRustDeskInstalled() {
			st.InstallStatus = "verification_failed"
			return actionResult{
				err:    fmt.Errorf("deploy_remote_support: MSI returned success but product not found on disk or in registry"),
				output: marshalDeployResult(st),
			}
		}
		st.InstallStatus = "installed"
	}

	// Phase 5: write TOML config using params (force=true for deploy action).
	cfgForOps := *cfg
	if rendezvousServer != "" {
		cfgForOps.RustDeskRendezvousServer = rendezvousServer
	}
	if key != "" {
		cfgForOps.RustDeskKey = key
	}
	cfgForOps.RustDeskForceConfig = true

	if _, err := writeRustDeskConfig(&cfgForOps); err != nil {
		log.Printf("[deploy_remote_support] config write failed (non-fatal): %v", err)
		st.ConfigStatus = "failed"
	} else {
		st.ConfigStatus = "written"
	}

	// Phase 6: ensure service (real connection daemon) + tray (cosmetic) running.
	if _, err := ensureRustDeskService(); err != nil {
		log.Printf("[deploy_remote_support] service ensure failed: %v", err)
		st.ServiceStatus = "failed"
	} else {
		st.ServiceStatus = "started"
	}
	if _, err := ensureRustDeskTrayRunning(); err != nil {
		log.Printf("[deploy_remote_support] tray ensure failed (non-fatal): %v", err)
	}

	// Phase 7: verify protocol handler.
	st.ProtocolStatus = ensureRustDeskProtocolHandler()

	// Phase 8: discover live RustDesk ID and final service status.
	rd := discoverRustDesk(&cfgForOps)
	st.RustDeskID = rd.ID
	if rd.Status == "running" {
		st.ServiceStatus = "running"
	}

	outputJSON := marshalDeployResult(st)
	return actionResult{
		message: fmt.Sprintf(
			"deploy_remote_support: install=%s version=%s config=%s service=%s protocol=%s id=%s",
			st.InstallStatus, st.InstalledVersion, st.ConfigStatus, st.ServiceStatus, st.ProtocolStatus, st.RustDeskID,
		),
		output: outputJSON,
	}
}

// getInstalledVersionByGUID queries the uninstall registry for a product GUID
// and returns its DisplayVersion, or "" if not found.
func getInstalledVersionByGUID(guid string) string {
	if guid == "" {
		return ""
	}
	roots := []string{
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\` + guid,
		`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\` + guid,
	}
	for _, root := range roots {
		out, err := runWithTimeout(5*time.Second, "reg", "query", root, "/v", "DisplayVersion")
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			if strings.Contains(strings.ToLower(line), "displayversion") {
				parts := strings.Fields(line)
				if len(parts) >= 3 {
					return parts[len(parts)-1]
				}
			}
		}
	}
	return ""
}

// runMSIInstall runs msiexec /i /qn /norestart and treats exit code 3010
// (reboot required) as success rather than failure.
func runMSIInstall(msiPath string) (rebootRequired bool, err error) {
	cmd := exec.Command(system32ExePath("msiexec.exe"), "/i", msiPath, "/qn", "/norestart")
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	if startErr := cmd.Start(); startErr != nil {
		return false, startErr
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case waitErr := <-done:
		if waitErr == nil {
			return false, nil
		}
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) && exitErr.ExitCode() == 3010 {
			return true, nil
		}
		return false, fmt.Errorf("msiexec: %w (output: %s)", waitErr, strings.TrimSpace(buf.String()))
	case <-time.After(10 * time.Minute):
		_ = cmd.Process.Kill()
		return false, fmt.Errorf("msiexec timed out after 10 minutes")
	}
}

// ensureRustDeskProtocolHandler checks that HKCR\rustdesk\shell\open\command
// points to TECHI Remote Support.exe. If absent it writes it via PowerShell.
func ensureRustDeskProtocolHandler() string {
	const regKey = `HKCR\rustdesk\shell\open\command`
	out, err := runWithTimeout(5*time.Second, "reg", "query", regKey, "/ve")
	if err == nil && strings.Contains(strings.ToLower(string(out)), "techi remote support") {
		return "ok"
	}

	// Write the protocol handler entries via PowerShell (handles quoting cleanly).
	script := `$p = 'HKCR:\rustdesk'; ` +
		`if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }; ` +
		`New-ItemProperty -Path $p -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null; ` +
		`$p2 = 'HKCR:\rustdesk\shell\open\command'; ` +
		`New-Item -Path $p2 -Force | Out-Null; ` +
		`Set-ItemProperty -Path $p2 -Name '(Default)' ` +
		`-Value '"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" "%1"' -Force`

	if _, writeErr := runWithTimeout(15*time.Second, "powershell",
		"-NoProfile", "-NonInteractive", "-Command", script); writeErr != nil {
		log.Printf("[deploy_remote_support] protocol handler write failed: %v", writeErr)
		return "write_failed"
	}
	log.Printf("[deploy_remote_support] protocol handler written")
	return "written"
}

// ------------------------------------------------------------------ //
// register_protocol                                                    //
// ------------------------------------------------------------------ //

func handleRegisterTechiProtocol(_ context.Context) actionResult {
	script := `$p = 'HKLM:\SOFTWARE\Classes\techiremotesupport'; ` +
		`if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }; ` +
		`Set-ItemProperty -Path $p -Name '(Default)' -Value 'URL:TECHI Remote Support Protocol' -Force; ` +
		`New-ItemProperty -Path $p -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null; ` +
		`$p2 = "$p\shell\open\command"; ` +
		`New-Item -Path $p2 -Force | Out-Null; ` +
		`Set-ItemProperty -Path $p2 -Name '(Default)' ` +
		`-Value '"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" "%1"' -Force`

	if _, err := runWithTimeout(15*time.Second, "powershell",
		"-NoProfile", "-NonInteractive", "-Command", script); err != nil {
		return actionResult{
			err:    fmt.Errorf("register_protocol: registry write failed: %w", err),
			stderr: err.Error(),
		}
	}
	log.Printf("[action] register_protocol: techiremotesupport:// registered in HKLM")
	return actionResult{message: "Protocol techiremotesupport:// registered successfully"}
}

// ------------------------------------------------------------------ //
// reboot_pc                                                            //
// ------------------------------------------------------------------ //

func handleRebootPC(_ context.Context, params map[string]interface{}) actionResult {
	delay := 60
	if v, ok := params["delay_seconds"]; ok {
		switch n := v.(type) {
		case float64:
			delay = int(n)
		case int:
			delay = n
		}
	}
	if delay < 30 {
		delay = 30
	}
	if delay > 3600 {
		delay = 3600
	}

	comment := fmt.Sprintf("TECHI Platform initiated reboot (delay=%ds)", delay)
	if _, err := runWithTimeout(10*time.Second,
		"shutdown", "/r", "/t", fmt.Sprintf("%d", delay), "/c", comment, "/f"); err != nil {
		return actionResult{
			err:    fmt.Errorf("reboot_pc: shutdown command failed: %w", err),
			stderr: err.Error(),
		}
	}
	log.Printf("[action] reboot_pc: reboot scheduled in %ds", delay)
	return actionResult{message: fmt.Sprintf("Reboot scheduled in %ds", delay)}
}

// ------------------------------------------------------------------ //
// run_powershell                                                       //
// ------------------------------------------------------------------ //

func handleRunPowerShell(ctx context.Context, params map[string]interface{}) actionResult {
	script := stringParam(params, "script")
	if script == "" {
		return actionResult{err: fmt.Errorf("run_powershell: missing 'script' parameter")}
	}

	timeoutSecs := 30
	if v, ok := params["timeout_seconds"]; ok {
		switch n := v.(type) {
		case float64:
			timeoutSecs = int(n)
		case int:
			timeoutSecs = n
		}
	}
	if timeoutSecs < 1 {
		timeoutSecs = 1
	}
	if timeoutSecs > 300 {
		timeoutSecs = 300
	}

	log.Printf("[action] run_powershell: executing script (timeout=%ds, len=%d)", timeoutSecs, len(script))

	psCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSecs)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(psCtx,
		"powershell.exe",
		"-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass",
		"-Command", script,
	)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()

	outStr := stdout.String()
	errStr := stderr.String()

	// Truncate to 4096 chars each to avoid huge callback payloads.
	const maxOut = 4096
	if len(outStr) > maxOut {
		outStr = outStr[:maxOut] + "\n[truncated]"
	}
	if len(errStr) > maxOut {
		errStr = errStr[:maxOut] + "\n[truncated]"
	}

	if psCtx.Err() == context.DeadlineExceeded {
		return actionResult{
			err:    fmt.Errorf("run_powershell: timed out after %ds", timeoutSecs),
			output: outStr,
			stderr: errStr,
		}
	}
	if runErr != nil {
		return actionResult{
			err:    fmt.Errorf("run_powershell: exit error: %w", runErr),
			output: outStr,
			stderr: errStr,
		}
	}

	log.Printf("[action] run_powershell: completed, output_len=%d", len(outStr))
	return actionResult{
		message: fmt.Sprintf("PowerShell completed (output_len=%d)", len(outStr)),
		output:  outStr,
		stderr:  errStr,
	}
}

// ------------------------------------------------------------------ //
// self_update (manual trigger via pending_action)                      //
// ------------------------------------------------------------------ //

func handleSelfUpdate(_ context.Context, params map[string]interface{}) actionResult {
	url := stringParam(params, "download_url")
	version := stringParam(params, "version")
	checksum := stringParam(params, "sha256")
	if url == "" {
		return actionResult{err: fmt.Errorf("self_update: missing 'download_url' parameter")}
	}
	update := &AgentUpdate{
		Available: true,
		Version:   version,
		URL:       url,
		Checksum:  checksum,
	}
	go performSelfUpdate(update)
	return actionResult{message: fmt.Sprintf("Self-update to v%s initiated in background", version)}
}

func marshalDeployResult(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func stringParam(params map[string]interface{}, key string) string {
	if v, ok := params[key]; ok {
		if s, ok := v.(string); ok {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func boolParam(params map[string]interface{}, key string) bool {
	if v, ok := params[key]; ok {
		switch b := v.(type) {
		case bool:
			return b
		case string:
			return strings.EqualFold(b, "true") || b == "1"
		}
	}
	return false
}

func handleApplyPowerPolicy(ctx context.Context, cfg *Config) actionResult {
	if !cfg.ManagePowerPolicy {
		return actionResult{err: fmt.Errorf("apply_power_policy: manage_power_policy is disabled in config")}
	}
	done := make(chan actionResult, 1)
	go func() {
		var applied []string
		var errs []string

		// Prevent sleep on AC.
		if cfg.PreventSleepOnAC || cfg.AvailabilityProfile == "server" {
			if _, err := runWithTimeout(15*time.Second, "powercfg", "/change", "standby-timeout-ac", "0"); err != nil {
				errs = append(errs, fmt.Sprintf("standby-timeout-ac: %v", err))
			} else {
				applied = append(applied, "standby-timeout-ac=0")
			}
		}

		// Prevent hibernate.
		if cfg.PreventHibernate || cfg.AvailabilityProfile == "server" {
			if _, err := runWithTimeout(15*time.Second, "powercfg", "/h", "off"); err != nil {
				errs = append(errs, fmt.Sprintf("hibernate off: %v", err))
			} else {
				applied = append(applied, "hibernate=off")
			}
		}

		// Allow display off on AC (energy saving — not forced off unless configured).
		if !cfg.AllowDisplayOffOnAC && cfg.AvailabilityProfile == "server" {
			if _, err := runWithTimeout(15*time.Second, "powercfg", "/change", "monitor-timeout-ac", "0"); err != nil {
				errs = append(errs, fmt.Sprintf("monitor-timeout-ac: %v", err))
			} else {
				applied = append(applied, "monitor-timeout-ac=0")
			}
		}

		if len(errs) > 0 {
			done <- actionResult{
				err:    fmt.Errorf("power policy partial failure: %s", strings.Join(errs, "; ")),
				stderr: strings.Join(errs, "\n"),
				output: strings.Join(applied, "\n"),
			}
			return
		}
		summary := "No power settings changed"
		if len(applied) > 0 {
			summary = "Applied: " + strings.Join(applied, ", ")
		}
		done <- actionResult{
			message: summary,
			output:  strings.Join(applied, "\n"),
		}
	}()
	select {
	case <-ctx.Done():
		return actionResult{err: fmt.Errorf("apply_power_policy timed out")}
	case r := <-done:
		return r
	}
}

// handleRunCommand: on Windows the Command Center uses run_powershell; this
// path exists only so the shared dispatch compiles. Never sent to Windows.
func handleRunCommand(_ context.Context, _ map[string]interface{}) actionResult {
	return actionResult{err: fmt.Errorf("run_command: use run_powershell on Windows")}
}

// handleOpenTerminal: Web Terminal is Linux-first (Phase 5). This stub keeps
// the shared dispatch compiling on Windows; the backend never sends it here.
func handleOpenTerminal(_ context.Context, _ *Config, _ map[string]interface{}) actionResult {
	return actionResult{err: fmt.Errorf("open_terminal: not supported on Windows")}
}
