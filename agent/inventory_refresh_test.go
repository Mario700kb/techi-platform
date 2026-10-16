package main

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type fakeInventory struct {
	now                                  time.Time
	processes, services, software, patch atomic.Int32
	softwareName                         string
	pendingUpdates                       int
}

func newFakeInventory() (*fakeInventory, *backgroundInventory) {
	f := &fakeInventory{now: time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC), softwareName: "7-Zip"}
	b := newBackgroundInventory(
		func() time.Time { return f.now },
		func() []ProcessInfo {
			n := f.processes.Add(1)
			return []ProcessInfo{{PID: n, Name: "chrome.exe", MemoryMB: float64(n)}}
		},
		func() []ServiceInfo {
			f.services.Add(1)
			return []ServiceInfo{{Name: "MSSQLSERVER", Status: "running", StartupType: "automatic"}}
		},
		func() []SoftwareInfo {
			f.software.Add(1)
			return []SoftwareInfo{{Name: f.softwareName}}
		},
		func() *PatchStatus {
			f.patch.Add(1)
			return &PatchStatus{PendingUpdates: f.pendingUpdates, PatchState: "up_to_date"}
		},
	)
	return f, b
}

var everything = &Config{CollectProcesses: true, CollectServices: true, CollectSoftware: true}

func (f *fakeInventory) advance(d time.Duration) { f.now = f.now.Add(d) }

func sentParts(h inventoryForHeartbeat) []string {
	var parts []string
	if h.Processes != nil {
		parts = append(parts, "processes")
	}
	if h.Services != nil {
		parts = append(parts, "services")
	}
	if h.Software != nil {
		parts = append(parts, "software")
	}
	if h.Patch != nil {
		parts = append(parts, "patch")
	}
	return parts
}

func assertParts(t *testing.T, h inventoryForHeartbeat, want ...string) {
	t.Helper()
	got := sentParts(h)
	if len(got) != len(want) {
		t.Fatalf("heartbeat carries %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("heartbeat carries %v, want %v", got, want)
		}
	}
}

func TestNothingIsSentBeforeTheFirstCollection(t *testing.T) {
	_, b := newFakeInventory()
	assertParts(t, b.forHeartbeat())
}

func TestEachPartIsSentOnceAfterItIsCollected(t *testing.T) {
	_, b := newFakeInventory()
	b.collectDue(everything)

	first := b.forHeartbeat()
	assertParts(t, first, "processes", "services", "software", "patch")
	first.sent()

	assertParts(t, b.forHeartbeat())
}

func TestPartsAreNotCollectedAgainBeforeTheirTime(t *testing.T) {
	f, b := newFakeInventory()
	b.collectDue(everything)
	for i := 0; i < 2; i++ {
		f.advance(5 * time.Minute)
		b.collectDue(everything)
	}
	if f.processes.Load() != 1 || f.services.Load() != 1 || f.software.Load() != 1 || f.patch.Load() != 1 {
		t.Fatalf("collected again within the schedule: processes=%d services=%d software=%d patch=%d",
			f.processes.Load(), f.services.Load(), f.software.Load(), f.patch.Load())
	}

	f.advance(5 * time.Minute) // 15 min: only the process list is due
	b.collectDue(everything)
	if f.processes.Load() != 2 || f.software.Load() != 1 || f.patch.Load() != 1 {
		t.Fatalf("after 15 min: processes=%d software=%d patch=%d", f.processes.Load(), f.software.Load(), f.patch.Load())
	}
}

func TestAnUnchangedPartIsNotResentWhenCollectedAgain(t *testing.T) {
	f, b := newFakeInventory()
	b.collectDue(everything)
	b.forHeartbeat().sent()

	f.advance(time.Hour)
	b.collectDue(everything)
	// The process list differs every time; software, services and patch did not change.
	assertParts(t, b.forHeartbeat(), "processes")
}

func TestAChangedPartIsSent(t *testing.T) {
	f, b := newFakeInventory()
	b.collectDue(everything)
	b.forHeartbeat().sent()

	f.softwareName = "7-Zip 26.01"
	f.pendingUpdates = 3
	f.advance(time.Hour)
	b.collectDue(everything)

	h := b.forHeartbeat()
	assertParts(t, h, "processes", "software", "patch")
	if h.Software[0].Name != "7-Zip 26.01" || h.Patch.PendingUpdates != 3 {
		t.Fatalf("stale values sent: %+v %+v", h.Software, h.Patch)
	}
}

func TestEverythingIsResentOnceADay(t *testing.T) {
	f, b := newFakeInventory()
	b.collectDue(everything)
	b.forHeartbeat().sent()

	f.advance(inventoryResendEvery)
	assertParts(t, b.forHeartbeat(), "processes", "services", "software", "patch")
}

func TestAPartIsResentWhenTheHeartbeatFailed(t *testing.T) {
	_, b := newFakeInventory()
	b.collectDue(everything)

	_ = b.forHeartbeat() // sent() never called: the heartbeat did not get through
	assertParts(t, b.forHeartbeat(), "processes", "services", "software", "patch")
}

func TestDisabledPartsAreNeverCollectedButPatchStatusIs(t *testing.T) {
	f, b := newFakeInventory()
	b.collectDue(&Config{})

	if f.processes.Load()+f.services.Load()+f.software.Load() != 0 {
		t.Fatal("a part turned off in the configuration was collected")
	}
	assertParts(t, b.forHeartbeat(), "patch")
}

func TestRefreshNeverWaitsForTheCollection(t *testing.T) {
	release := make(chan struct{})
	var started atomic.Int32
	b := newBackgroundInventory(
		time.Now,
		func() []ProcessInfo { return nil },
		func() []ServiceInfo { return nil },
		func() []SoftwareInfo { return nil },
		func() *PatchStatus {
			started.Add(1)
			<-release // a Windows Update search that hangs
			return &PatchStatus{PatchState: "up_to_date"}
		},
	)

	done := make(chan struct{})
	go func() {
		b.refresh(&Config{})
		b.refresh(&Config{}) // a second heartbeat while the first pass still runs
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("refresh waited for the collection")
	}
	assertParts(t, b.forHeartbeat())

	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for len(sentParts(b.forHeartbeat())) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	assertParts(t, b.forHeartbeat(), "patch")
	if started.Load() != 1 {
		t.Fatalf("a second pass started while the first was running: %d", started.Load())
	}
}

func TestServiceNamesKeepTheInventoryWording(t *testing.T) {
	states := map[uint32]string{1: "stopped", 2: "start pending", 3: "stop pending", 4: "running", 7: "paused", 99: "unknown"}
	for state, want := range states {
		if got := inventoryServiceState(state); got != want {
			t.Fatalf("state %d = %q, want %q", state, got, want)
		}
	}
	starts := map[uint32]string{0: "boot", 1: "system", 2: "automatic", 3: "manual", 4: "disabled"}
	for start, want := range starts {
		if got := inventoryServiceStartType(start); got != want {
			t.Fatalf("start type %d = %q, want %q", start, got, want)
		}
	}
}

func TestAConfigWithTheOldPublicIPServiceStillLoads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	old := `{"backend_url":"https://api-rdp.techi.com.al/api/v1/agent/heartbeat","public_ip_service":"https://api.ipify.org?format=text","collect_software":true}`
	if err := os.WriteFile(path, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(path)
	if err != nil || !cfg.CollectSoftware {
		t.Fatalf("old config not loaded: %v %+v", err, cfg)
	}
}
