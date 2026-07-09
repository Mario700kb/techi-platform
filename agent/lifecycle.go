package main

// Agent startup lifecycle (state machine).
//
//	Installing (MSI / bootstrap-config, outside this process)
//	    → LoadingConfig → Enrolling → FirstHeartbeat → Operational
//
// Born from a production incident (2026-07-09): a transient "Access is
// denied" reading the legacy config at first service start killed the agent
// loop permanently while the Windows service kept reporting RUNNING — the
// device silently never appeared in the platform. The rules encoded here:
//
//   - Configuration loading is retried forever with exponential backoff
//     (loadConfigWithRetry); a failed read keeps the agent in a recoverable
//     LoadingConfig state instead of ending the loop. Every retry is logged.
//   - The current state is explicit, logged on every transition, and
//     mirrored to a small JSON file (agent.state.json, next to the exe data)
//     so external tooling — watchdog-check, operators — can distinguish
//     "service RUNNING" from "agent actually heartbeating".
//   - The first successful heartbeat transitions the agent to Operational.
//   - If the loop ever exits with an error anyway, the service process exits
//     without reporting SERVICE_STOPPED (service_windows.go), so the SCM
//     failure actions (restart 1m/1m/5m) become meaningful again.
//
// The state file is diagnostic metadata only: it is a new, separate file —
// agent.config.json format, enrollment, and the installer are untouched.

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"
)

type lifecycleState string

const (
	stateLoadingConfig  lifecycleState = "loading_config"
	stateEnrolling      lifecycleState = "enrolling"
	stateFirstHeartbeat lifecycleState = "first_heartbeat"
	stateOperational    lifecycleState = "operational"
	stateFaulted        lifecycleState = "faulted"
)

// Retry pacing for configuration loading. Vars (not consts) so tests can
// shrink them; production values start gentle and cap well below the
// watchdog's staleness threshold so a retrying agent never looks wedged.
var (
	configRetryInitialDelay = 5 * time.Second
	configRetryMaxDelay     = 5 * time.Minute
)

// lifecycleStatus is what gets mirrored to agent.state.json for external
// observers (watchdog-check, operators).
type lifecycleStatus struct {
	State     lifecycleState `json:"state"`
	Detail    string         `json:"detail,omitempty"`
	UpdatedAt time.Time      `json:"updated_at"`
	PID       int            `json:"pid"`
}

// lifecycleStateFile is a var so tests can point it at a temp dir. The file
// always lives next to the config file — one rule for every platform:
// Windows  C:\ProgramData\TechiAgent\agent.state.json
// Linux    /etc/techi-agent/agent.state.json (one-line installer layout)
// dev      ./agent.state.json (next to ./config.json)
// External readers (watchdog-check on Windows) resolve the same default.
var lifecycleStateFile = defaultLifecycleStatePath()

func defaultLifecycleStatePath() string {
	return lifecycleStatePathFor(defaultConfigPath())
}

func lifecycleStatePathFor(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "agent.state.json")
}

// initLifecycleStateFile pins the state file next to the config actually in
// use (a custom -config path carries its state with it).
func initLifecycleStateFile(configPath string) {
	lifecycleStateFile = lifecycleStatePathFor(configPath)
}

// currentLifecycleState is only ever written from the agent loop goroutine
// (plus the service wrapper after that goroutine has finished), so no
// locking is needed.
var currentLifecycleState lifecycleState

// setLifecycleState records the state in memory, logs transitions, and
// refreshes the state file (timestamp included) even when the state is
// unchanged — the watchdog uses the file's age to detect a wedged loop.
func setLifecycleState(state lifecycleState, detail string) {
	if state != currentLifecycleState {
		from := string(currentLifecycleState)
		if from == "" {
			from = "start"
		}
		log.Printf("lifecycle: %s -> %s %s", from, state, detail)
		currentLifecycleState = state
	}
	status := lifecycleStatus{
		State:     state,
		Detail:    detail,
		UpdatedAt: time.Now().UTC(),
		PID:       os.Getpid(),
	}
	data, err := json.Marshal(&status)
	if err != nil {
		return
	}
	// Best effort: the state file is diagnostics, never a dependency.
	_ = os.WriteFile(lifecycleStateFile, data, 0600)
}

// readLifecycleStatus is used by watchdog-check (a separate process) to see
// what the running agent is actually doing.
func readLifecycleStatus() (*lifecycleStatus, error) {
	data, err := os.ReadFile(lifecycleStateFile)
	if err != nil {
		return nil, err
	}
	var status lifecycleStatus
	if err := json.Unmarshal(data, &status); err != nil {
		return nil, err
	}
	return &status, nil
}

// loadConfigWithRetry is the LoadingConfig phase: migration + load, retried
// forever with exponential backoff until the context is cancelled. In `once`
// mode (manual `-once` runs) it fails fast like the pre-lifecycle agent so
// scripts and operators get an immediate answer.
func loadConfigWithRetry(ctx context.Context, configPath string, once bool) (*Config, error) {
	setLifecycleState(stateLoadingConfig, "")
	delay := configRetryInitialDelay
	for attempt := 1; ; attempt++ {
		err := migrateLegacyConfigIfNeeded(configPath)
		if err == nil {
			var cfg *Config
			if cfg, err = loadConfig(configPath); err == nil {
				return cfg, nil
			}
		}
		if once {
			return nil, err
		}
		setLifecycleState(stateLoadingConfig, err.Error())
		log.Printf("lifecycle: config load attempt %d failed: %v — retrying in %s", attempt, err, delay)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
		if delay *= 2; delay > configRetryMaxDelay {
			delay = configRetryMaxDelay
		}
	}
}

// startupHeartbeatState maps the pre-Operational phase to the lifecycle:
// a device without an identity is Enrolling (enrollment itself is unchanged
// and still happens inside the heartbeat cycle); an enrolled device is
// waiting for its FirstHeartbeat.
func startupHeartbeatState(cfg *Config) lifecycleState {
	if cfg.DeviceID == 0 && cfg.AgentID == "" {
		return stateEnrolling
	}
	return stateFirstHeartbeat
}

// recordHeartbeatOutcome advances the state machine after each heartbeat
// cycle: the first success transitions to Operational; failures before that
// keep the startup state (with the error as detail) so the watchdog can see
// the agent is still initializing; failures after that leave the agent
// Operational — the regular ticker already retries.
func recordHeartbeatOutcome(startupState lifecycleState, err error) {
	if err == nil {
		setLifecycleState(stateOperational, "")
		return
	}
	if currentLifecycleState == stateOperational {
		setLifecycleState(stateOperational, "last heartbeat failed: "+err.Error())
		return
	}
	setLifecycleState(startupState, "heartbeat failed: "+err.Error())
}
