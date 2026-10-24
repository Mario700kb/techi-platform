//go:build windows

package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// Windows reports exactly one capability, "powershell", and only where the
// pseudo console exists, and of the Platform Expansion fields only the MAC
// address (2.1.41); every other one stays out of the heartbeat.
func TestWindowsReportsOnlyThePowerShellCapability(t *testing.T) {
	caps := currentPlatform().Capabilities()
	if conPTYAvailable() {
		if len(caps) != 1 || caps[0] != "powershell" {
			t.Fatalf("want [powershell], got %v", caps)
		}
	} else if caps != nil {
		t.Fatalf("no pseudo console: want nil, got %v", caps)
	}
	extra := currentPlatform().ExtraInventory()
	extra.MACAddress = ""
	if (extra != ExtraInventory{}) {
		t.Errorf("expected only the MAC address in Windows ExtraInventory, got %+v", currentPlatform().ExtraInventory())
	}
	inv := &Inventory{Hostname: "host", Platform: "windows", Capabilities: caps, MACAddress: "00:15:5d:01:02:03"}
	data, _ := json.Marshal(buildHeartbeatPayload(&Config{}, inv, RustDeskInfo{}, nil, nil, nil, nil, nil))
	for _, field := range []string{"fqdn", "kernel_version", "architecture", "timezone", "last_boot_at"} {
		if strings.Contains(string(data), "\""+field+"\"") {
			t.Errorf("Windows payload must omit %q", field)
		}
	}
	if !strings.Contains(string(data), `"mac_address":"00:15:5d:01:02:03"`) {
		t.Errorf("Windows payload must carry the MAC address: %s", data)
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
