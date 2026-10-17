package main

import (
	"context"
	"errors"
	"log"
	"math/rand"
	"time"
)

func runAgent(ctx context.Context, configPath string, enrollmentToken string, once bool) error {
	// Startup state machine (lifecycle.go): a config read failure keeps the
	// agent in a retryable LoadingConfig state — it must never permanently
	// silence the device while the service still reports RUNNING. The same
	// engine runs on every platform; only the supervisor differs (Windows
	// SCM failure actions vs systemd Restart=always).
	initLifecycleStateFile(configPath)
	cfg, err := loadConfigWithRetry(ctx, configPath, once)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			log.Printf("agent loop stopped while loading configuration")
			return nil
		}
		return err
	}
	applyEnvironment(cfg)
	if enrollmentToken != "" {
		cfg.EnrollmentToken = enrollmentToken
	}
	logStartupDiagnostics(configPath, defaultLogPath(), cfg)

	if once {
		// One-shot run (diagnostics, CI): collect the heavy inventory
		// synchronously so the single heartbeat is complete and no background
		// PowerShell is left running after the process exits.
		pendingForceInventory.Store(true)
		return runSingleHeartbeat(configPath, enrollmentToken)
	}

	interval := time.Duration(cfg.HeartbeatSeconds) * time.Second
	if interval <= 0 {
		interval = time.Minute
	}

	log.Printf("agent loop started config=%s interval=%s", configPath, interval)

	// Install/refresh an external watchdog. If this service is later stopped,
	// the watchdog task can start it again because it runs independently under
	// Task Scheduler.
	ensureAgentServiceWatchdog()

	// Apply power policy once on startup (Windows only; no-op elsewhere).
	applyPowerPolicy(cfg)

	// Prune stale download caches (old RS MSIs, old self-update exes) in the
	// background so startup and the first heartbeat are never delayed.
	go cleanupAgentCaches(cfg)

	startupState := startupHeartbeatState(cfg)
	setLifecycleState(startupState, "")

	// Hold one outbound WebSocket open so interactive actions (Web Terminal)
	// arrive immediately instead of waiting out a heartbeat. Linux only —
	// command_channel_other.go is a no-op, so Windows neither links the
	// websocket client nor opens any connection. Detached and failure-tolerant:
	// if the channel never establishes, actions are still delivered by the
	// heartbeat path exactly as before.
	if !once {
		go runCommandChannel(ctx, configPath)
		// Every-minute samples kept on disk and uploaded every 15 minutes,
		// once the platform has sent a monitoring policy.
		go runTelemetryPipeline(ctx, configPath)
	}

	if err := runSingleHeartbeat(configPath, enrollmentToken); err != nil {
		log.Printf("heartbeat cycle failed: %v", err)
		recordHeartbeatOutcome(startupState, err)
	} else {
		recordHeartbeatOutcome(startupState, nil)
	}
	applyPendingInterval(&interval)

	timer := time.NewTimer(jitteredInterval(interval))
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.Canceled) {
				log.Printf("agent loop stopped")
				return nil
			}
			return ctx.Err()
		case <-timer.C:
			if err := runSingleHeartbeat(configPath, enrollmentToken); err != nil {
				log.Printf("heartbeat cycle failed: %v", err)
				recordHeartbeatOutcome(startupState, err)
			} else {
				recordHeartbeatOutcome(startupState, nil)
			}
			applyPendingInterval(&interval)
			timer.Reset(jitteredInterval(interval))
		case <-heartbeatWakeCh:
			// An action delivered over the command channel asked for a fresh
			// heartbeat. This cycle is that heartbeat, so it must not run a
			// second follow-up of its own.
			pendingImmediateHeartbeat.Store(false)
			if err := runSingleHeartbeat(configPath, enrollmentToken); err != nil {
				log.Printf("heartbeat cycle failed: %v", err)
				recordHeartbeatOutcome(startupState, err)
			} else {
				recordHeartbeatOutcome(startupState, nil)
			}
			applyPendingInterval(&interval)
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(jitteredInterval(interval))
		}
	}
}

// heartbeatWakeCh asks the agent loop for a heartbeat now. Buffered by one: a
// wake that arrives while one is already pending adds nothing.
var heartbeatWakeCh = make(chan struct{}, 1)

func wakeHeartbeat() {
	select {
	case heartbeatWakeCh <- struct{}{}:
	default:
	}
}

// jitteredInterval spreads each wait by up to ±10%. A fixed period keeps
// agents that started together (a site powering on, a mass upgrade, a backend
// restart they all retried against) in lockstep forever, so the backend sees
// the whole cohort as one burst every cycle instead of a steady stream.
func jitteredInterval(d time.Duration) time.Duration {
	spread := int64(d / 10)
	if spread <= 0 {
		return d
	}
	return d + time.Duration(rand.Int63n(2*spread+1)-spread)
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
