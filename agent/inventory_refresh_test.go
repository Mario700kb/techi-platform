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
		nil,
		nil,
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
	assertParts(t, b.forHeartbeat(everything))
}

func TestEachPartIsSentOnceAfterItIsCollected(t *testing.T) {
	_, b := newFakeInventory()
	b.collectDue(everything)

	first := b.forHeartbeat(everything)
	assertParts(t, first, "processes", "services", "software", "patch")
	first.sent()

	assertParts(t, b.forHeartbeat(everything))
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
	b.forHeartbeat(everything).sent()

	f.advance(time.Hour)
	b.collectDue(everything)
	// The process list differs every time; software, services and patch did not change.
	assertParts(t, b.forHeartbeat(everything), "processes")
}

func TestAChangedPartIsSent(t *testing.T) {
	f, b := newFakeInventory()
	b.collectDue(everything)
	b.forHeartbeat(everything).sent()

	f.softwareName = "7-Zip 26.01"
	f.pendingUpdates = 3
	f.advance(time.Hour)
	b.collectDue(everything)

	h := b.forHeartbeat(everything)
	assertParts(t, h, "processes", "software", "patch")
	if h.Software[0].Name != "7-Zip 26.01" || h.Patch.PendingUpdates != 3 {
		t.Fatalf("stale values sent: %+v %+v", h.Software, h.Patch)
	}
}

func TestEverythingIsResentPeriodically(t *testing.T) {
	f, b := newFakeInventory()
	b.collectDue(everything)
	b.forHeartbeat(everything).sent()

	f.advance(inventoryResendEvery)
	assertParts(t, b.forHeartbeat(everything), "processes", "services", "software", "patch")
}

func TestAPartIsResentWhenTheHeartbeatFailed(t *testing.T) {
	_, b := newFakeInventory()
	b.collectDue(everything)

	_ = b.forHeartbeat(everything) // sent() never called: the heartbeat did not get through
	assertParts(t, b.forHeartbeat(everything), "processes", "services", "software", "patch")
}

func TestDisabledPartsAreNeverCollectedButPatchStatusIs(t *testing.T) {
	f, b := newFakeInventory()
	b.collectDue(&Config{})

	if f.processes.Load()+f.services.Load()+f.software.Load() != 0 {
		t.Fatal("a part turned off in the configuration was collected")
	}
	assertParts(t, b.forHeartbeat(everything), "patch")
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
		nil,
		nil,
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
	assertParts(t, b.forHeartbeat(everything))

	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for len(sentParts(b.forHeartbeat(everything))) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	assertParts(t, b.forHeartbeat(everything), "patch")
	if started.Load() != 1 {
		t.Fatalf("a second pass started while the first was running: %d", started.Load())
	}
}

func TestAnEmptyProcessListKeepsTheLastOneAndIsRetriedSoon(t *testing.T) {
	now := time.Date(2026, 10, 25, 9, 0, 0, 0, time.UTC)
	var calls atomic.Int32
	b := newBackgroundInventory(
		func() time.Time { return now },
		func() []ProcessInfo {
			if calls.Add(1) == 2 {
				return nil // the second collection fails
			}
			return []ProcessInfo{{PID: calls.Load(), Name: "sqlservr.exe"}}
		},
		func() []ServiceInfo { return nil },
		func() []SoftwareInfo { return nil },
		func() *PatchStatus { return &PatchStatus{PatchState: "up_to_date"} },
		nil,
		nil,
	)
	only := &Config{CollectProcesses: true}
	b.collectDue(only)
	b.forHeartbeat(only).sent()

	now = now.Add(processRefreshEvery)
	b.collectDue(only) // fails
	if h := b.forHeartbeat(only); h.Processes != nil {
		t.Fatalf("a failed collection must not be sent: %+v", h.Processes)
	}
	if b.processes.value[0].Name != "sqlservr.exe" {
		t.Fatal("the last good list must be kept")
	}

	now = now.Add(inventoryRetryEvery)
	b.collectDue(only)
	if calls.Load() != 3 {
		t.Fatalf("a failed collection must be retried after %s, collections=%d", inventoryRetryEvery, calls.Load())
	}
	if h := b.forHeartbeat(only); len(h.Processes) != 1 || h.Processes[0].PID != 3 {
		t.Fatalf("the retried list must be sent: %+v", h.Processes)
	}
}

func TestCollectSoonWaitsForARunningPassThenCallsBack(t *testing.T) {
	f, b := newFakeInventory()
	b.pass <- struct{}{} // a pass is running
	done := make(chan struct{})
	b.collectSoon(everything, func() { close(done) })
	select {
	case <-done:
		t.Fatal("collectSoon must wait for the running pass")
	case <-time.After(50 * time.Millisecond):
	}
	<-b.pass
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("collectSoon never finished")
	}
	if f.services.Load() != 1 {
		t.Fatalf("services collected %d times, want 1", f.services.Load())
	}
	assertParts(t, b.forHeartbeat(everything), "processes", "services", "software", "patch")
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

func TestAForcedRefreshCollectsEverythingNow(t *testing.T) {
	f, b := newFakeInventory()
	b.collectDue(everything)
	b.forHeartbeat(everything).sent()

	// Ten minutes later nothing is due; a technician installs software and
	// presses Refresh inventory.
	f.advance(10 * time.Minute)
	f.softwareName = "Installed just now"
	b.forceCollect(everything)

	if f.software.Load() != 2 || f.patch.Load() != 2 || f.services.Load() != 2 {
		t.Fatalf("forced refresh skipped parts: software=%d patch=%d services=%d",
			f.software.Load(), f.patch.Load(), f.services.Load())
	}
	h := b.forHeartbeat(everything)
	if len(h.Software) != 1 || h.Software[0].Name != "Installed just now" {
		t.Fatalf("the refreshed software list was not sent: %+v", h.Software)
	}
}

func TestAPartSwitchedOffIsNotSentAgain(t *testing.T) {
	f, b := newFakeInventory()
	b.collectDue(everything)
	b.forHeartbeat(everything).sent()

	softwareOff := &Config{CollectProcesses: true, CollectServices: true}
	f.advance(inventoryResendEvery)
	assertParts(t, b.forHeartbeat(softwareOff), "processes", "services", "patch")
}
