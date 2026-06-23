package main

import (
	"context"
	"errors"
	"log"
	"time"
)

func runAgent(ctx context.Context, configPath string, enrollmentToken string, once bool) error {
	if err := migrateLegacyConfigIfNeeded(configPath); err != nil {
		return err
	}

	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	applyEnvironment(cfg)
	if enrollmentToken != "" {
		cfg.EnrollmentToken = enrollmentToken
	}
	logStartupDiagnostics(configPath, defaultLogPath(), cfg)

	if once {
		return runSingleHeartbeat(configPath, enrollmentToken)
	}

	interval := time.Duration(cfg.HeartbeatSeconds) * time.Second
	if interval <= 0 {
		interval = time.Minute
	}

	log.Printf("agent loop started config=%s interval=%s", configPath, interval)

	// Apply power policy once on startup (Windows only; no-op elsewhere).
	applyPowerPolicy(cfg)

	if err := runSingleHeartbeat(configPath, enrollmentToken); err != nil {
		log.Printf("heartbeat cycle failed: %v", err)
	}
	applyPendingInterval(&interval)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.Canceled) {
				log.Printf("agent loop stopped")
				return nil
			}
			return ctx.Err()
		case <-ticker.C:
			if err := runSingleHeartbeat(configPath, enrollmentToken); err != nil {
				log.Printf("heartbeat cycle failed: %v", err)
			}
			if changed := applyPendingInterval(&interval); changed {
				ticker.Reset(interval)
			}
		}
	}
}

func logStartupDiagnostics(configPath string, logPath string, cfg *Config) {
	agentIDState := "missing"
	if cfg.AgentID != "" {
		agentIDState = "present"
	}
	enrollmentTokenState := "missing"
	if cfg.EnrollmentToken != "" {
		enrollmentTokenState = "present"
	}
	log.Printf(
		"startup diagnostics: config_path=%s log_path=%s backend_url=%s api_url=%s device_id=%d agent_id=%s enrollment_token=%s",
		configPath,
		logPath,
		cfg.BackendURL,
		cfg.APIURL,
		cfg.DeviceID,
		agentIDState,
		enrollmentTokenState,
	)
}

// applyPendingInterval reads pendingIntervalChange (set by server response or
// change_heartbeat_interval action) and updates interval in-place.
// Returns true if the interval actually changed.
func applyPendingInterval(interval *time.Duration) bool {
	newSecs := pendingIntervalChange.Swap(0)
	if newSecs <= 0 {
		return false
	}
	newDur := time.Duration(newSecs) * time.Second
	if newDur == *interval {
		return false
	}
	log.Printf("heartbeat interval changed: %s → %s", *interval, newDur)
	*interval = newDur
	return true
}
