package main

import (
	"testing"
	"time"
)

func resetCollection() {
	for _, c := range []*collectionSetting{softwareCollection, servicesCollection, processesCollection} {
		c.set.Store(false)
		c.enabled.Store(false)
	}
}

func TestThePlatformDecidesWhichInventoryPartsAreCollected(t *testing.T) {
	resetCollection()
	defer resetCollection()
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
