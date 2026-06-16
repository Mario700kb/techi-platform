package main

import (
	"context"
	"errors"
	"log"
	"time"
)

func runAgent(ctx context.Context, configPath string, enrollmentToken string, once bool) error {
	if once {
		return runSingleHeartbeat(configPath, enrollmentToken)
	}

	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	applyEnvironment(cfg)
	if enrollmentToken != "" {
		cfg.EnrollmentToken = enrollmentToken
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
