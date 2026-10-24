package main

import (
	"testing"
	"time"
)

func resetSoftwareCollection() {
	softwareCollection.set.Store(false)
	softwareCollection.enabled.Store(false)
}

func TestThePlatformDecidesSoftwareCollection(t *testing.T) {
	resetSoftwareCollection()
	defer resetSoftwareCollection()
	cfg := &Config{CollectSoftware: false}

	applySoftwareCollection(cfg, nil)
	if collectSoftwareEnabled(cfg) {
		t.Fatal("an older backend (no setting) must leave the config file's choice")
	}

	// Collected a moment ago: not due for an hour.
	heavyInventory.mu.Lock()
	heavyInventory.software.attemptedAt = time.Now()
	heavyInventory.mu.Unlock()

	on := true
	applySoftwareCollection(cfg, &on)
	if !collectSoftwareEnabled(cfg) {
		t.Fatal("the platform turned it on")
	}
	heavyInventory.mu.Lock()
	due := heavyInventory.software.due(time.Now())
	heavyInventory.mu.Unlock()
	if !due {
		t.Fatal("turned on, the software list must be collected at the next pass")
	}

	off := false
	applySoftwareCollection(&Config{CollectSoftware: true}, &off)
	if collectSoftwareEnabled(&Config{CollectSoftware: true}) {
		t.Fatal("the platform's off wins over the config file")
	}
}
