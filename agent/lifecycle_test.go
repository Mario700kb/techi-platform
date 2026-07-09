package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func useTempLifecycleFile(t *testing.T) {
	t.Helper()
	orig := lifecycleStateFile
	origState := currentLifecycleState
	lifecycleStateFile = filepath.Join(t.TempDir(), "agent.state.json")
	currentLifecycleState = ""
	t.Cleanup(func() {
		lifecycleStateFile = orig
		currentLifecycleState = origState
	})
}

func TestLifecycleStateFileRoundtrip(t *testing.T) {
	useTempLifecycleFile(t)

	setLifecycleState(stateLoadingConfig, "open config: access denied")

	status, err := readLifecycleStatus()
	if err != nil {
		t.Fatalf("readLifecycleStatus: %v", err)
	}
	if status.State != stateLoadingConfig {
		t.Fatalf("state = %q, want %q", status.State, stateLoadingConfig)
	}
	if status.Detail != "open config: access denied" {
		t.Fatalf("detail = %q", status.Detail)
	}
	if status.PID != os.Getpid() {
		t.Fatalf("pid = %d, want %d", status.PID, os.Getpid())
	}
	if time.Since(status.UpdatedAt) > time.Minute {
		t.Fatalf("updated_at not fresh: %s", status.UpdatedAt)
	}
}

func TestLoadConfigWithRetryOnceFailsFast(t *testing.T) {
	useTempLifecycleFile(t)

	missing := filepath.Join(t.TempDir(), "nope", "agent.config.json")
	start := time.Now()
	if _, err := loadConfigWithRetry(context.Background(), missing, true); err == nil {
		t.Fatal("expected error for missing config in once mode")
	}
	if time.Since(start) > time.Second {
		t.Fatal("once mode must not retry with backoff")
	}
}

func TestLoadConfigWithRetryRecovers(t *testing.T) {
	useTempLifecycleFile(t)

	origInitial, origMax := configRetryInitialDelay, configRetryMaxDelay
	configRetryInitialDelay, configRetryMaxDelay = 5*time.Millisecond, 20*time.Millisecond
	t.Cleanup(func() {
		configRetryInitialDelay, configRetryMaxDelay = origInitial, origMax
	})

	dir := t.TempDir()
	configPath := filepath.Join(dir, "agent.config.json")
	// Invalid JSON first: the loader must stay in LoadingConfig and retry.
	if err := os.WriteFile(configPath, []byte("{not json"), 0600); err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(40 * time.Millisecond)
		_ = os.WriteFile(configPath, []byte(`{"api_url":"http://localhost:8000"}`), 0600)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cfg, err := loadConfigWithRetry(ctx, configPath, false)
	if err != nil {
		t.Fatalf("loadConfigWithRetry: %v", err)
	}
	if cfg.APIURL != "http://localhost:8000" {
		t.Fatalf("api_url = %q", cfg.APIURL)
	}
	if currentLifecycleState != stateLoadingConfig {
		t.Fatalf("state during load = %q, want %q", currentLifecycleState, stateLoadingConfig)
	}
}

func TestLoadConfigWithRetryStopsOnCancel(t *testing.T) {
	useTempLifecycleFile(t)

	origInitial := configRetryInitialDelay
	configRetryInitialDelay = time.Hour // force the wait branch
	t.Cleanup(func() { configRetryInitialDelay = origInitial })

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	missing := filepath.Join(t.TempDir(), "nope", "agent.config.json")
	_, err := loadConfigWithRetry(ctx, missing, false)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestRecordHeartbeatOutcomeTransitions(t *testing.T) {
	useTempLifecycleFile(t)

	// Failures before the first success keep the startup state.
	recordHeartbeatOutcome(stateEnrolling, errors.New("backend unreachable"))
	if currentLifecycleState != stateEnrolling {
		t.Fatalf("state = %q, want %q", currentLifecycleState, stateEnrolling)
	}

	// First success transitions to Operational.
	recordHeartbeatOutcome(stateEnrolling, nil)
	if currentLifecycleState != stateOperational {
		t.Fatalf("state = %q, want %q", currentLifecycleState, stateOperational)
	}

	// Later failures do not leave Operational; the ticker keeps retrying.
	recordHeartbeatOutcome(stateEnrolling, errors.New("timeout"))
	if currentLifecycleState != stateOperational {
		t.Fatalf("state after transient failure = %q, want %q", currentLifecycleState, stateOperational)
	}
	status, err := readLifecycleStatus()
	if err != nil {
		t.Fatal(err)
	}
	if status.Detail == "" {
		t.Fatal("transient failure should be recorded as detail")
	}
}
