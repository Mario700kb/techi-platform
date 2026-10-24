package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func resetCollection() {
	for _, c := range collectionSettings {
		c.set.Store(false)
		c.enabled.Store(false)
	}
	inventoryCollectionState.mu.Lock()
	inventoryCollectionState.path = ""
	inventoryCollectionState.saved = nil
	inventoryCollectionState.mu.Unlock()
}

// watchTurnedOn replaces the immediate collection with a counter.
func watchTurnedOn(t *testing.T) *int {
	t.Helper()
	calls := 0
	original := collectTurnedOnParts
	collectTurnedOnParts = func(*Config) { calls++ }
	t.Cleanup(func() { collectTurnedOnParts = original })
	return &calls
}

func TestThePlatformDecidesWhichInventoryPartsAreCollected(t *testing.T) {
	resetCollection()
	defer resetCollection()
	watchTurnedOn(t)
	cfg := &Config{} // a token install's config: every collect_* off

	applyInventoryCollection(cfg, HeartbeatResponse{})
	if collectSoftwareEnabled(cfg) || collectServicesEnabled(cfg) || collectProcessesEnabled(cfg) {
		t.Fatal("an older backend (no settings) must leave the config file's choice")
	}

	// Collected a moment ago: not due for a while.
	heavyInventory.mu.Lock()
	heavyInventory.software.attemptedAt = time.Now()
	heavyInventory.services.attemptedAt = time.Now()
	heavyInventory.processes.attemptedAt = time.Now()
	heavyInventory.mu.Unlock()

	on, off := true, false
	applyInventoryCollection(cfg, HeartbeatResponse{CollectSoftware: &on, CollectServices: &on, CollectProcesses: &on})
	if !collectSoftwareEnabled(cfg) || !collectServicesEnabled(cfg) || !collectProcessesEnabled(cfg) {
		t.Fatal("the platform turned all three on")
	}
	heavyInventory.mu.Lock()
	now := time.Now()
	due := heavyInventory.software.due(now) && heavyInventory.services.due(now) && heavyInventory.processes.due(now)
	heavyInventory.mu.Unlock()
	if !due {
		t.Fatal("turned on, each part must be collected at the next pass")
	}

	full := &Config{CollectSoftware: true, CollectServices: true, CollectProcesses: true}
	applyInventoryCollection(full, HeartbeatResponse{CollectServices: &off})
	if collectServicesEnabled(full) {
		t.Fatal("the platform's off wins over the config file")
	}
	if !collectSoftwareEnabled(full) || !collectProcessesEnabled(full) {
		t.Fatal("a part the response does not name keeps its last setting")
	}
}

func TestAPartTurnedOnIsCollectedAndSentAtOnce(t *testing.T) {
	resetCollection()
	defer resetCollection()
	calls := watchTurnedOn(t)
	cfg := &Config{}
	on, off := true, false

	applyInventoryCollection(cfg, HeartbeatResponse{CollectServices: &off})
	if *calls != 0 {
		t.Fatal("nothing was turned on")
	}
	applyInventoryCollection(cfg, HeartbeatResponse{CollectServices: &on, CollectProcesses: &on})
	if *calls != 1 {
		t.Fatalf("turning parts on must start one immediate collection, got %d", *calls)
	}
	applyInventoryCollection(cfg, HeartbeatResponse{CollectServices: &on, CollectProcesses: &on})
	if *calls != 1 {
		t.Fatal("parts already on must not start another collection")
	}
}

func TestThePlatformsChoiceSurvivesARestart(t *testing.T) {
	resetCollection()
	defer resetCollection()
	watchTurnedOn(t)
	configPath := filepath.Join(t.TempDir(), "config.json")
	cfg := &Config{} // the config file: every collect_* off

	initInventoryCollection(configPath) // first start: no saved choice
	if collectServicesEnabled(cfg) {
		t.Fatal("without a saved choice the config file decides")
	}
	on, off := true, false
	applyInventoryCollection(cfg, HeartbeatResponse{CollectSoftware: &on, CollectServices: &on, CollectProcesses: &off})

	// Restart: the agent forgets everything in memory.
	resetCollection()
	initInventoryCollection(configPath)
	if !collectSoftwareEnabled(cfg) || !collectServicesEnabled(cfg) || collectProcessesEnabled(&Config{CollectProcesses: true}) {
		t.Fatal("after a restart the platform's last choice must apply before any heartbeat")
	}

	// A broken file is ignored: the config file decides until the platform answers.
	if err := os.WriteFile(inventoryCollectionPathFor(configPath), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	resetCollection()
	initInventoryCollection(configPath)
	if collectServicesEnabled(cfg) {
		t.Fatal("an unreadable file must not turn anything on")
	}
	applyInventoryCollection(cfg, HeartbeatResponse{CollectServices: &on})
	if data, _ := os.ReadFile(inventoryCollectionPathFor(configPath)); string(data) != `{"services":true}` {
		t.Fatalf("the platform's answer must replace the broken file, got %s", data)
	}
	if _, err := os.Stat(inventoryCollectionPathFor(configPath) + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("no temporary file may be left behind")
	}
}
