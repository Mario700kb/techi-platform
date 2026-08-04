//go:build !linux

// Build-tagged !linux since 2026-08-05: every assertion here is about the
// NON-Linux contract (the file's own comment says so), so running it on Linux
// failed by construction and kept `go test ./...` red on that platform. That
// went unnoticed because the agent was only ever tested from Windows/darwin;
// it blocks a Linux CI job. No production code changes — the same assertions
// still run on Windows and darwin exactly as before.
package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// On non-Linux platforms (Windows/darwin) currentPlatform() reports no
// capabilities and empty ExtraInventory, so the heartbeat JSON must NOT
// contain any Platform Expansion field. This is the behavioral proof that
// the Windows payload is unchanged by Phase 2.
func TestNonLinuxPayloadOmitsExpansionFields(t *testing.T) {
	inv := &Inventory{Hostname: "host", Platform: "windows"}
	// Mirror the wiring in collectInventory for the current (non-Linux) platform.
	extra := currentPlatform().ExtraInventory()
	inv.FQDN = extra.FQDN
	inv.KernelVersion = extra.KernelVersion
	inv.Architecture = extra.Architecture
	inv.MACAddress = extra.MACAddress
	inv.Timezone = extra.Timezone
	inv.LastBootAt = extra.LastBootAt
	inv.Capabilities = currentPlatform().Capabilities()

	cfg := &Config{}
	payload := buildHeartbeatPayload(cfg, inv, RustDeskInfo{}, nil, nil, nil, nil, nil)
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	js := string(data)
	for _, field := range []string{
		"fqdn", "kernel_version", "architecture", "mac_address",
		"timezone", "last_boot_at", "capabilities",
	} {
		if strings.Contains(js, "\""+field+"\"") {
			t.Errorf("non-Linux payload must omit %q, got: %s", field, js)
		}
	}
}

func TestExtraInventoryEmptyOnNonLinux(t *testing.T) {
	// Guards the Windows/other contract at the source.
	if caps := currentPlatform().Capabilities(); caps != nil {
		t.Errorf("expected nil capabilities on non-Linux, got %v", caps)
	}
	if (currentPlatform().ExtraInventory() != ExtraInventory{}) {
		t.Error("expected zero ExtraInventory on non-Linux")
	}
}
