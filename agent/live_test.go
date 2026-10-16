package main

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeLiveClock drives a liveStreamer without real waiting: every sleep of the
// stream loop advances the clock by the interval it asked for.
type fakeLiveClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeLiveClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeLiveClock) Sleep(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
	time.Sleep(time.Millisecond) // let the test goroutine observe progress
}

func newTestStreamer() (*liveStreamer, *fakeLiveClock) {
	clock := &fakeLiveClock{now: time.Date(2026, 10, 16, 23, 0, 0, 0, time.UTC)}
	s := newLiveStreamer(clock.Now, func() liveSnapshot {
		cpu := 12.5
		return liveSnapshot{At: clock.Now().UnixMilli(), CPUPercent: &cpu, Disks: []liveDisk{}, Processes: []liveProcess{}}
	}, clock.Sleep)
	return s, clock
}

func waitStopped(t *testing.T, s *liveStreamer) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for s.active() {
		if time.Now().After(deadline) {
			t.Fatal("the stream did not stop")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestALiveRequestStreamsUntilItsTTLRunsOut(t *testing.T) {
	s, _ := newTestStreamer()
	var mu sync.Mutex
	var frames [][]byte
	s.request(3, 45, func(b []byte) error {
		mu.Lock()
		frames = append(frames, b)
		mu.Unlock()
		return nil
	})
	waitStopped(t, s)

	// 45 s at one frame every 3 s.
	if len(frames) != 15 {
		t.Fatalf("sent %d frames over a 45 s TTL at 3 s, want 15", len(frames))
	}
	var msg struct {
		Type string                 `json:"type"`
		Data map[string]interface{} `json:"data"`
	}
	if err := json.Unmarshal(frames[0], &msg); err != nil || msg.Type != "live" || msg.Data["cpu_percent"] != 12.5 {
		t.Fatalf("frame is not a live snapshot: %s (%v)", frames[0], err)
	}
}

func TestLiveStopEndsTheStream(t *testing.T) {
	s, _ := newTestStreamer()
	sent := make(chan struct{}, 100)
	s.request(3, 120, func([]byte) error { sent <- struct{}{}; return nil })
	<-sent
	s.stop()
	waitStopped(t, s)
	if len(sent) > 2 {
		t.Fatalf("kept streaming after live_stop: %d more frames", len(sent))
	}
}

func TestAFailedSendEndsTheStream(t *testing.T) {
	s, _ := newTestStreamer()
	calls := 0
	s.request(3, 120, func([]byte) error { calls++; return errors.New("connection closed") })
	waitStopped(t, s)
	if calls != 1 {
		t.Fatalf("kept sending to a dead connection: %d sends", calls)
	}
}

func TestARenewedRequestKeepsOneStream(t *testing.T) {
	s, clock := newTestStreamer()
	var mu sync.Mutex
	count := 0
	send := func([]byte) error { mu.Lock(); count++; mu.Unlock(); return nil }
	s.request(3, 45, send)
	// Renew a few times before the TTL ends, as an open page does every 15 s.
	for i := 0; i < 3; i++ {
		for {
			mu.Lock()
			c := count
			mu.Unlock()
			if c >= (i+1)*5 {
				break
			}
			time.Sleep(time.Millisecond)
		}
		s.request(3, 45, send)
	}
	waitStopped(t, s)
	_ = clock
	// Three renewals at frames 5, 10 and 15 each push the end 45 s on: the
	// stream runs 15 more frames after the last one, and never doubles up.
	if count < 30 || count > 31 {
		t.Fatalf("renewed stream sent %d frames, want 30", count)
	}
}

func TestLiveIntervalAndTTLAreBounded(t *testing.T) {
	if clampLiveInterval(0) != liveMinInterval || clampLiveInterval(1) != liveMinInterval {
		t.Fatal("an interval below 2 s must be raised to 2 s")
	}
	if clampLiveInterval(3600) != liveMaxInterval {
		t.Fatal("an interval above 30 s must be lowered to 30 s")
	}
	if clampLiveTTL(0) != liveDefaultTTL || clampLiveTTL(86400) != liveMaxTTL {
		t.Fatal("the TTL must default to 45 s and never exceed 2 min")
	}
}

func TestTheBusiestProcessesComeFirst(t *testing.T) {
	top := topLiveProcesses([]liveProcess{
		{PID: 1, Name: "idle.exe", CPUPercent: 0, MemoryMB: 900},
		{PID: 2, Name: "sqlservr.exe", CPUPercent: 40, MemoryMB: 4000},
		{PID: 3, Name: "chrome.exe", CPUPercent: 40, MemoryMB: 700},
		{PID: 4, Name: "tiny.exe", CPUPercent: 0, MemoryMB: 5},
	}, 3)
	got := []int32{top[0].PID, top[1].PID, top[2].PID}
	if got[0] != 2 || got[1] != 3 || got[2] != 1 {
		t.Fatalf("order %v, want [2 3 1]", got)
	}
}

func TestARealSampleIsSmallAndComplete(t *testing.T) {
	s := newLiveSampler()
	s.sample() // the first sample has no process CPU baseline
	snap := s.sample()
	if snap.CPUPercent == nil || snap.RAMPercent == nil {
		t.Fatalf("cpu or ram missing: %+v", snap)
	}
	if snap.ProcessCount == 0 || len(snap.Processes) == 0 || len(snap.Processes) > liveTopProcesses {
		t.Fatalf("process list wrong: count=%d top=%d", snap.ProcessCount, len(snap.Processes))
	}
	data, err := json.Marshal(liveMessage{Type: "live", Data: snap})
	if err != nil {
		t.Fatal(err)
	}
	// The backend drops frames over 16 KB; a snapshot is a few KB.
	if len(data) > 8*1024 {
		t.Fatalf("snapshot is %d bytes", len(data))
	}
}
