package main

import (
	"testing"
	"time"
)

func TestJitteredIntervalStaysWithinTenPercent(t *testing.T) {
	base := time.Minute
	seen := map[time.Duration]bool{}
	for i := 0; i < 2000; i++ {
		got := jitteredInterval(base)
		if got < 54*time.Second || got > 66*time.Second {
			t.Fatalf("jitteredInterval(%s) = %s, want within ±10%%", base, got)
		}
		seen[got] = true
	}
	if len(seen) < 100 {
		t.Fatalf("only %d distinct waits in 2000 draws; agents would stay in lockstep", len(seen))
	}
}

func TestJitteredIntervalLeavesTinyDurationsAlone(t *testing.T) {
	if got := jitteredInterval(5 * time.Nanosecond); got != 5*time.Nanosecond {
		t.Fatalf("got %s", got)
	}
}
