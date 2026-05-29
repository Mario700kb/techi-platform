//go:build windows

package main

import (
	"context"
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
	done := make(chan actionResult, 1)
	go func() {
		log.Printf("[action] restart_rustdesk: stopping service")
		_, _ = runWithTimeout(15*time.Second, "sc", "stop", rustdeskServiceName)
		time.Sleep(2 * time.Second)

		log.Printf("[action] restart_rustdesk: starting service")
		if _, err := runWithTimeout(30*time.Second, "sc", "start", rustdeskServiceName); err != nil {
			// Try starting the exe directly if the service doesn't exist yet.
			if _, err2 := runWithTimeout(15*time.Second, rustdeskDefaultInstallPath, "--service"); err2 != nil {
				done <- actionResult{
					err:    fmt.Errorf("sc start failed: %v; direct launch also failed: %v", err, err2),
					stderr: fmt.Sprintf("sc start: %v\ndirect: %v", err, err2),
				}
				return
			}
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

func handleReinstallRustDesk(ctx context.Context, cfg *Config) actionResult {
	if cfg.RustDeskMSIUrl == "" {
		return actionResult{err: fmt.Errorf("reinstall_rustdesk: no MSI URL configured")}
	}
	done := make(chan actionResult, 1)
	go func() {
		log.Printf("[action] reinstall_rustdesk: stopping service")
		_, _ = runWithTimeout(15*time.Second, "sc", "stop", rustdeskServiceName)
		time.Sleep(2 * time.Second)

		log.Printf("[action] reinstall_rustdesk: running MSI install")
		if err := installRustDeskMSI(cfg); err != nil {
			done <- actionResult{
				err:    fmt.Errorf("MSI install failed: %w", err),
				stderr: err.Error(),
			}
			return
		}

		// Re-apply config and restart service after install.
		if _, err := writeRustDeskConfig(cfg); err != nil {
			log.Printf("[action] reinstall_rustdesk: config write failed (non-fatal): %v", err)
		}
		if _, err := ensureRustDeskService(); err != nil {
			log.Printf("[action] reinstall_rustdesk: service start failed (non-fatal): %v", err)
		}

		rd := discoverRustDesk(cfg)
		done <- actionResult{
			message: fmt.Sprintf(
				"TECHI Remote Support reinstalled — install_status=%s status=%s version=%s id=%s",
				rd.InstallStatus, rd.Status, rd.Version, rd.ID,
			),
		}
	}()
	select {
	case <-ctx.Done():
		return actionResult{err: fmt.Errorf("reinstall_rustdesk timed out")}
	case r := <-done:
		return r
	}
}

func handleReopenRustDesk(ctx context.Context, cfg *Config) actionResult {
	done := make(chan actionResult, 1)
	go func() {
		rd := discoverRustDesk(cfg)
		if rd.Status == "running" {
			done <- actionResult{message: fmt.Sprintf("TECHI Remote Support already running (id=%s)", rd.ID)}
			return
		}
		log.Printf("[action] reopen_rustdesk: service not running — starting")
		if _, err := runWithTimeout(30*time.Second, "sc", "start", rustdeskServiceName); err != nil {
			// Fallback: launch the executable directly.
			if _, err2 := runWithTimeout(15*time.Second, rustdeskDefaultInstallPath); err2 != nil {
				done <- actionResult{
					err:    fmt.Errorf("sc start: %v; direct launch: %v", err, err2),
					stderr: fmt.Sprintf("sc start: %v\ndirect: %v", err, err2),
				}
				return
			}
		}
		time.Sleep(2 * time.Second)
		rd = discoverRustDesk(cfg)
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
	done := make(chan actionResult, 1)
	go func() {
		log.Printf("[action] repair_config_rustdesk: writing config")
		changed, err := writeRustDeskConfig(cfg)
		if err != nil {
			done <- actionResult{
				err:    fmt.Errorf("config write failed: %w", err),
				stderr: err.Error(),
			}
			return
		}

		log.Printf("[action] repair_config_rustdesk: stopping service for restart")
		_, _ = runWithTimeout(15*time.Second, "sc", "stop", rustdeskServiceName)
		time.Sleep(2 * time.Second)

		log.Printf("[action] repair_config_rustdesk: starting service")
		if _, err2 := runWithTimeout(30*time.Second, "sc", "start", rustdeskServiceName); err2 != nil {
			done <- actionResult{
				err:    fmt.Errorf("service restart failed after config repair: %w", err2),
				stderr: err2.Error(),
			}
			return
		}

		time.Sleep(2 * time.Second)
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
