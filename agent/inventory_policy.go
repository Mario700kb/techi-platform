package main

import (
	"encoding/json"
	"log"
	"maps"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
)

// The platform decides which inventory parts the agent collects — installed
// software (2.1.42), services and processes (2.1.45) — per platform, in Agent
// config. Until a heartbeat says so, the agent's own config file decides, as
// before: collect_software, collect_services and collect_processes were off
// by default there, so PCs installed with a token reported none of them
// (632 of 937 Windows PCs sent no services, 161 no processes).
//
// From 2.1.46 the platform's last choice is kept next to the config file, so
// a restart or an update does not fall back to the config file's choice, and
// a part the platform turns on is collected and sent at once instead of two
// heartbeats later (about ten minutes).
type collectionSetting struct {
	name    string
	key     string
	set     atomic.Bool
	enabled atomic.Bool
}

var (
	softwareCollection  = &collectionSetting{name: "installed software", key: "software"}
	servicesCollection  = &collectionSetting{name: "services", key: "services"}
	processesCollection = &collectionSetting{name: "processes", key: "processes"}
	collectionSettings  = []*collectionSetting{softwareCollection, servicesCollection, processesCollection}
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

// collectTurnedOnParts collects the parts just turned on and sends them with
// an immediate heartbeat. A var so tests can watch it without collecting.
var collectTurnedOnParts = func(cfg *Config) {
	heavyInventory.collectSoon(cfg, wakeHeartbeat)
}

// applyInventoryCollection adopts the platform's settings from a heartbeat
// response; a nil field (an older backend) changes nothing.
func applyInventoryCollection(cfg *Config, resp HeartbeatResponse) {
	turnedOn := false
	turnedOn = apply(softwareCollection, collectSoftwareEnabled(cfg), resp.CollectSoftware, func() { heavyInventory.software.markDue() }) || turnedOn
	turnedOn = apply(servicesCollection, collectServicesEnabled(cfg), resp.CollectServices, func() { heavyInventory.services.markDue() }) || turnedOn
	turnedOn = apply(processesCollection, collectProcessesEnabled(cfg), resp.CollectProcesses, func() { heavyInventory.processes.markDue() }) || turnedOn
	saveInventoryCollection()
	if turnedOn {
		collectTurnedOnParts(cfg)
	}
}

// apply stores one setting; true when it turned the part on.
func apply(c *collectionSetting, before bool, want *bool, markDue func()) bool {
	if want == nil {
		return false
	}
	c.enabled.Store(*want)
	c.set.Store(true)
	if before == *want {
		return false
	}
	log.Printf("[inventory] %s collection %s by the platform", c.name, map[bool]string{true: "on", false: "off"}[*want])
	if !*want {
		return false
	}
	heavyInventory.mu.Lock()
	markDue()
	heavyInventory.mu.Unlock()
	return true
}

// ── the platform's last choice, on disk ─────────────────────────────────────

var inventoryCollectionState struct {
	mu    sync.Mutex
	path  string
	saved map[string]bool
}

func inventoryCollectionPathFor(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "inventory-collection.json")
}

// initInventoryCollection adopts the platform's last choice saved next to the
// config file. Missing or unreadable: the config file decides until the first
// heartbeat response, as before 2.1.46.
func initInventoryCollection(configPath string) {
	state := &inventoryCollectionState
	state.mu.Lock()
	defer state.mu.Unlock()
	state.path = inventoryCollectionPathFor(configPath)
	state.saved = nil
	data, err := os.ReadFile(state.path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[inventory] read %s: %v", state.path, err)
		}
		return
	}
	saved := map[string]bool{}
	if err := json.Unmarshal(data, &saved); err != nil {
		log.Printf("[inventory] %s is not valid; the platform will send its settings again: %v", state.path, err)
		return
	}
	for _, c := range collectionSettings {
		if on, ok := saved[c.key]; ok {
			c.enabled.Store(on)
			c.set.Store(true)
		}
	}
	state.saved = saved
	log.Printf("[inventory] collection from the platform's last settings: %v", saved)
}

// saveInventoryCollection writes the settings the platform has sent when they
// differ from the saved copy. Written to a temporary file and renamed, so a
// power cut never leaves half a file.
func saveInventoryCollection() {
	state := &inventoryCollectionState
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.path == "" {
		return
	}
	current := map[string]bool{}
	for _, c := range collectionSettings {
		if c.set.Load() {
			current[c.key] = c.enabled.Load()
		}
	}
	if len(current) == 0 || maps.Equal(current, state.saved) {
		return
	}
	data, err := json.Marshal(current)
	if err != nil {
		return
	}
	tmp := state.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		log.Printf("[inventory] save collection settings: %v", err)
		return
	}
	if err := os.Rename(tmp, state.path); err != nil {
		log.Printf("[inventory] save collection settings: %v", err)
		_ = os.Remove(tmp)
		return
	}
	state.saved = current
}
