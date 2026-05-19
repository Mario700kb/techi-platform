//go:build windows

package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"
)

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
			message: fmt.Sprintf("RustDesk restarted — status=%s id=%s", rd.Status, rd.ID),
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
				"RustDesk reinstalled — install_status=%s status=%s version=%s id=%s",
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
			done <- actionResult{message: fmt.Sprintf("RustDesk already running (id=%s)", rd.ID)}
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
			message: fmt.Sprintf("RustDesk reopened — status=%s id=%s", rd.Status, rd.ID),
		}
	}()
	select {
	case <-ctx.Done():
		return actionResult{err: fmt.Errorf("reopen_rustdesk timed out")}
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
