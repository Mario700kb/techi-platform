package main

import (
	"testing"
	"time"
)

// A one-shot maintenance subcommand must ALWAYS finish in bounded time — the MSI
// custom action that runs it is synchronous, and an unbounded command hung
// msiexec for over an hour in the field.

func TestBoundedOneShotReturnsWorkCodeWhenFast(t *testing.T) {
	code, timedOut := boundedOneShot(5*time.Second, 2, func() int { return 0 })
	if timedOut || code != 0 {
		t.Fatalf("fast work: got (code=%d, timedOut=%v), want (0, false)", code, timedOut)
	}

	code, timedOut = boundedOneShot(5*time.Second, 2, func() int { return 7 })
	if timedOut || code != 7 {
		t.Fatalf("fast work: got (code=%d, timedOut=%v), want (7, false)", code, timedOut)
	}
}

func TestBoundedOneShotTimesOutAndDoesNotWaitForWork(t *testing.T) {
	start := time.Now()
	code, timedOut := boundedOneShot(50*time.Millisecond, 2, func() int {
		time.Sleep(10 * time.Second) // simulates a stuck stop (sc/gopsutil/taskkill)
		return 0
	})
	elapsed := time.Since(start)

	if !timedOut || code != 2 {
		t.Fatalf("stuck work: got (code=%d, timedOut=%v), want (2, true)", code, timedOut)
	}
	// It must return at the bound, NOT wait ~10s for the stuck work.
	if elapsed > 2*time.Second {
		t.Fatalf("boundedOneShot waited %s for stuck work — must return at the bound", elapsed)
	}
}

// TestMaintenanceSubcommandsNeverFallIntoAgentLoop pins the dispatch invariant:
// every one-shot maintenance subcommand is handled and os.Exit'd BEFORE main()
// reaches the normal agent runtime (runAgent). The field hang was an OLD binary
// that lacked stop-remote-support-runtime falling through into runAgent and
// heartbeating forever; the current binary must dispatch it first.
func TestMaintenanceSubcommandsNeverFallIntoAgentLoop(t *testing.T) {
	src := agentSource(t, "main.go")

	runAgentIdx := indexOf(src, "runAgent(ctx")
	if runAgentIdx < 0 {
		t.Fatal("could not locate the runAgent(ctx ...) call in main.go")
	}
	for _, sub := range []string{
		`case "stop-remote-support-runtime":`,
		`case "remove-tray-artifacts", "rs-tray-task":`,
		`case "swap-binary":`,
		`case "bootstrap-config":`,
	} {
		idx := indexOf(src, sub)
		if idx < 0 {
			t.Errorf("main.go dispatch missing %q", sub)
			continue
		}
		if idx > runAgentIdx {
			t.Errorf("dispatch %q appears AFTER runAgent — it would fall through into the agent loop", sub)
		}
	}

	// The subcommand handlers must go through the bounded wrapper.
	boot := agentSource(t, "bootstrap_windows.go")
	for _, want := range []string{
		"runBoundedOneShot(\"[stop-remote-support-runtime]\"",
		"runBoundedOneShot(\"[remove-tray-artifacts]\"",
	} {
		if indexOf(boot, want) < 0 {
			t.Errorf("bootstrap_windows.go: %q not wired through the bounded wrapper", want)
		}
	}
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
