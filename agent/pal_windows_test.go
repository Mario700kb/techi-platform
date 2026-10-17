//go:build windows

package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// Windows reports exactly one capability, "powershell", and only where the
// pseudo console exists; every other Platform Expansion field stays out of
// the heartbeat.
func TestWindowsReportsOnlyThePowerShellCapability(t *testing.T) {
	caps := currentPlatform().Capabilities()
	if conPTYAvailable() {
		if len(caps) != 1 || caps[0] != "powershell" {
			t.Fatalf("want [powershell], got %v", caps)
		}
	} else if caps != nil {
		t.Fatalf("no pseudo console: want nil, got %v", caps)
	}
	if (currentPlatform().ExtraInventory() != ExtraInventory{}) {
		t.Error("expected zero ExtraInventory on Windows")
	}
	inv := &Inventory{Hostname: "host", Platform: "windows", Capabilities: caps}
	data, _ := json.Marshal(buildHeartbeatPayload(&Config{}, inv, RustDeskInfo{}, nil, nil, nil, nil, nil))
	for _, field := range []string{"fqdn", "kernel_version", "architecture", "mac_address", "timezone", "last_boot_at"} {
		if strings.Contains(string(data), "\""+field+"\"") {
			t.Errorf("Windows payload must omit %q", field)
		}
	}
}

func TestTheResizeFrameIsReadExactly(t *testing.T) {
	if c, r, ok := parseResizeFrame([]byte(`{"t":"resize","cols":160,"rows":40}`)); !ok || c != 160 || r != 40 {
		t.Fatalf("got %d %d %v", c, r, ok)
	}
	if _, _, ok := parseResizeFrame([]byte(`Write-Host "resize"`)); ok {
		t.Fatal("a typed word is not a resize")
	}
}
