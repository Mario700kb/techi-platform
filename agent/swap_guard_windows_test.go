//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var swapT0 = time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)

func swapAt(d time.Duration) time.Time { return swapT0.Add(d) }

func lifecycleAt(state lifecycleState, at time.Time) *lifecycleStatus {
	return &lifecycleStatus{State: state, UpdatedAt: at, Detail: "detail"}
}

func TestSwapWatchConfirmsOnlyOnTheNewAgentsOperationalState(t *testing.T) {
	w := newSwapWatch(swapT0, swapConfirmWindow)

	// The old agent's Operational entry predates the install: not a confirmation.
	v, _ := w.observe(swapObservation{Now: swapAt(5 * time.Second), ExeExists: true, ServiceRunning: true,
		Lifecycle: lifecycleAt(stateOperational, swapAt(-time.Hour))})
	if v != swapPending {
		t.Fatalf("stale Operational must not confirm, got %v", v)
	}

	v, _ = w.observe(swapObservation{Now: swapAt(40 * time.Second), ExeExists: true, ServiceRunning: true,
		Lifecycle: lifecycleAt(stateOperational, swapAt(30*time.Second))})
	if v != swapConfirmed {
		t.Fatalf("fresh Operational must confirm, got %v", v)
	}
}

func TestSwapWatchKeepsAnUnreachablePlatformUnconfirmed(t *testing.T) {
	// HeartbeatGuard 503 or an offline PC: the agent stays in first_heartbeat.
	w := newSwapWatch(swapT0, swapConfirmWindow)
	for d := time.Duration(0); d < swapConfirmWindow; d += swapPollInterval {
		v, reason := w.observe(swapObservation{Now: swapAt(d), ExeExists: true, ServiceRunning: true,
			Lifecycle: lifecycleAt(stateFirstHeartbeat, swapAt(d))})
		if v != swapPending {
			t.Fatalf("at %s: got %v (%s), want pending", d, v, reason)
		}
	}
	v, _ := w.observe(swapObservation{Now: swapAt(swapConfirmWindow), ExeExists: true, ServiceRunning: true,
		Lifecycle: lifecycleAt(stateFirstHeartbeat, swapAt(swapConfirmWindow))})
	if v != swapUnconfirmed {
		t.Fatalf("at the deadline: got %v, want unconfirmed (never a rollback)", v)
	}
}

func TestSwapWatchFailsWhenTheExeDisappears(t *testing.T) {
	w := newSwapWatch(swapT0, swapConfirmWindow)
	v, reason := w.observe(swapObservation{Now: swapAt(20 * time.Second), ExeExists: false, ServiceRunning: false})
	if v != swapFailed || !strings.Contains(reason, "disappeared") {
		t.Fatalf("got %v (%s), want failed: exe disappeared", v, reason)
	}
}

func TestSwapWatchFailsOnAFreshFaultedState(t *testing.T) {
	w := newSwapWatch(swapT0, swapConfirmWindow)
	v, _ := w.observe(swapObservation{Now: swapAt(10 * time.Second), ExeExists: true, ServiceRunning: true,
		Lifecycle: lifecycleAt(stateFaulted, swapAt(-time.Minute))})
	if v != swapPending {
		t.Fatalf("Faulted written by the old agent must be ignored, got %v", v)
	}
	v, _ = w.observe(swapObservation{Now: swapAt(20 * time.Second), ExeExists: true, ServiceRunning: false,
		Lifecycle: lifecycleAt(stateFaulted, swapAt(15*time.Second))})
	if v != swapFailed {
		t.Fatalf("fresh Faulted must fail, got %v", v)
	}
}

func TestSwapWatchToleratesSCMRestartsButNotAServiceThatStaysDown(t *testing.T) {
	w := newSwapWatch(swapT0, swapConfirmWindow)
	// Down for two minutes (two SCM restarts at 1 min), then running again.
	for d := time.Duration(0); d <= 2*time.Minute; d += swapPollInterval {
		if v, reason := w.observe(swapObservation{Now: swapAt(d), ExeExists: true, ServiceRunning: false}); v != swapPending {
			t.Fatalf("at %s: got %v (%s), want pending", d, v, reason)
		}
	}
	if v, _ := w.observe(swapObservation{Now: swapAt(2*time.Minute + swapPollInterval), ExeExists: true, ServiceRunning: true}); v != swapPending {
		t.Fatalf("running again must stay pending, got %v", v)
	}

	// The down clock restarts after a running observation.
	start := 3 * time.Minute
	for d := start; d < start+swapServiceDownLimit; d += swapPollInterval {
		if v, _ := w.observe(swapObservation{Now: swapAt(d), ExeExists: true, ServiceRunning: false}); v != swapPending {
			t.Fatalf("at %s: down clock did not restart", d)
		}
	}
	v, reason := w.observe(swapObservation{Now: swapAt(start + swapServiceDownLimit), ExeExists: true, ServiceRunning: false})
	if v != swapFailed {
		t.Fatalf("down for %s: got %v (%s), want failed", swapServiceDownLimit, v, reason)
	}
}

func TestAgentExeRestoreSourcePrefersThePreviousExe(t *testing.T) {
	present := map[string]bool{}
	exists := func(p string) bool { return present[p] }
	backup, self := `C:\x\techi-agent-old.exe`, `C:\x\techi-agent-watchdog.exe`

	if got := agentExeRestoreSource(backup, self, exists); got != "" {
		t.Fatalf("nothing present: got %q", got)
	}
	present[self] = true
	if got := agentExeRestoreSource(backup, self, exists); got != self {
		t.Fatalf("only self: got %q", got)
	}
	present[backup] = true
	if got := agentExeRestoreSource(backup, self, exists); got != backup {
		t.Fatalf("backup present: got %q, want the backup", got)
	}
	if got := agentExeRestoreSource(backup, "", exists); got != backup {
		t.Fatalf("no self: got %q", got)
	}
}

func TestSwapMarkerExpires(t *testing.T) {
	if !swapMarkerFresh(swapAt(5*time.Minute), swapT0, true) {
		t.Fatal("a 5-minute-old marker must count")
	}
	if swapMarkerFresh(swapAt(swapMarkerMaxAge), swapT0, true) {
		t.Fatal("a marker as old as swapMarkerMaxAge must not count")
	}
	if swapMarkerFresh(swapAt(time.Minute), swapT0, false) {
		t.Fatal("no marker must not count")
	}
	// The marker outlives the longest swap: stop 45 s + copies + start 30 s + confirm window.
	if swapMarkerMaxAge <= swapConfirmWindow+5*time.Minute {
		t.Fatalf("swapMarkerMaxAge %s too close to swapConfirmWindow %s", swapMarkerMaxAge, swapConfirmWindow)
	}
}

func TestRefreshWatchdogCopyOnlyRewritesOnChange(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ProgramData", dir)
	if err := os.MkdirAll(agentProgramDataDir(), 0755); err != nil {
		t.Fatal(err)
	}
	agentExe := filepath.Join(agentProgramDataDir(), "techi-agent.exe")
	if err := os.WriteFile(agentExe, []byte("v1"), 0755); err != nil {
		t.Fatal(err)
	}

	got, err := refreshWatchdogCopy(agentExe)
	if err != nil || got != agentWatchdogExePath() {
		t.Fatalf("first copy: %q, %v", got, err)
	}
	old := time.Now().Add(-time.Hour)
	_ = os.Chtimes(got, old, old)
	if _, err := refreshWatchdogCopy(agentExe); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(got); !info.ModTime().Equal(old) {
		t.Fatal("an identical copy was rewritten")
	}

	if err := os.WriteFile(agentExe, []byte("v2-longer"), 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := refreshWatchdogCopy(agentExe); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(got); string(data) != "v2-longer" {
		t.Fatalf("copy not refreshed: %q", data)
	}
	if fileExists(got + ".new") {
		t.Fatal("temp file left behind")
	}
}
