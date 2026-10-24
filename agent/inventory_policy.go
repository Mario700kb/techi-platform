package main

import (
	"log"
	"sync/atomic"
)

// The platform decides whether the agent collects installed software (Agent
// config, per platform; 2.1.42). Until a heartbeat says so, the agent's own
// config file decides, as before — collect_software was off by default, so
// about one PC in six never reported its software.
var softwareCollection struct {
	set     atomic.Bool
	enabled atomic.Bool
}

func collectSoftwareEnabled(cfg *Config) bool {
	if softwareCollection.set.Load() {
		return softwareCollection.enabled.Load()
	}
	return cfg != nil && cfg.CollectSoftware
}

// applySoftwareCollection adopts the platform's setting from a heartbeat
// response; nil (an older backend) changes nothing. Turned on, the software
// list is collected at the next background pass instead of within the hour.
func applySoftwareCollection(cfg *Config, want *bool) {
	if want == nil {
		return
	}
	before := collectSoftwareEnabled(cfg)
	softwareCollection.enabled.Store(*want)
	softwareCollection.set.Store(true)
	if before == *want {
		return
	}
	log.Printf("[inventory] installed software collection %s by the platform", map[bool]string{true: "on", false: "off"}[*want])
	if *want {
		heavyInventory.mu.Lock()
		heavyInventory.software.markDue()
		heavyInventory.mu.Unlock()
	}
}
