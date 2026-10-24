package main

import (
	"log"
	"sync/atomic"
)

// The platform decides which inventory parts the agent collects — installed
// software (2.1.42), services and processes (2.1.45) — per platform, in Agent
// config. Until a heartbeat says so, the agent's own config file decides, as
// before: collect_software, collect_services and collect_processes were off
// by default there, so PCs installed with a token reported none of them
// (632 of 937 Windows PCs sent no services, 161 no processes).
type collectionSetting struct {
	name    string
	set     atomic.Bool
	enabled atomic.Bool
}

var (
	softwareCollection  = &collectionSetting{name: "installed software"}
	servicesCollection  = &collectionSetting{name: "services"}
	processesCollection = &collectionSetting{name: "processes"}
)

func (c *collectionSetting) enabledFor(fromConfig bool) bool {
	if c.set.Load() {
		return c.enabled.Load()
	}
	return fromConfig
}

func collectSoftwareEnabled(cfg *Config) bool {
	return softwareCollection.enabledFor(cfg != nil && cfg.CollectSoftware)
}

func collectServicesEnabled(cfg *Config) bool {
	return servicesCollection.enabledFor(cfg != nil && cfg.CollectServices)
}

func collectProcessesEnabled(cfg *Config) bool {
	return processesCollection.enabledFor(cfg != nil && cfg.CollectProcesses)
}

// applyInventoryCollection adopts the platform's settings from a heartbeat
// response; a nil field (an older backend) changes nothing. A part turned on
// is collected at the next background pass instead of at its usual interval.
func applyInventoryCollection(cfg *Config, resp HeartbeatResponse) {
	apply(softwareCollection, collectSoftwareEnabled(cfg), resp.CollectSoftware, func() { heavyInventory.software.markDue() })
	apply(servicesCollection, collectServicesEnabled(cfg), resp.CollectServices, func() { heavyInventory.services.markDue() })
	apply(processesCollection, collectProcessesEnabled(cfg), resp.CollectProcesses, func() { heavyInventory.processes.markDue() })
}

func apply(c *collectionSetting, before bool, want *bool, markDue func()) {
	if want == nil {
		return
	}
	c.enabled.Store(*want)
	c.set.Store(true)
	if before == *want {
		return
	}
	log.Printf("[inventory] %s collection %s by the platform", c.name, map[bool]string{true: "on", false: "off"}[*want])
	if *want {
		heavyInventory.mu.Lock()
		markDue()
		heavyInventory.mu.Unlock()
	}
}
