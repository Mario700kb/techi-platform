//go:build !linux

package main

import "testing"

// On real Windows/other builds the build-tag-selected currentPlatform() must
// report no capabilities and a zero ExtraInventory, so the Windows heartbeat
// payload is byte-for-byte unchanged by Platform Expansion. This assertion is
// only true off Linux, so it is constrained to non-Linux builds; the OS-neutral
// wiring contract (a nothing-reporting collector omits every field) is proven
// deterministically for all hosts in pal_test.go.
func TestExtraInventoryEmptyOnNonLinux(t *testing.T) {
	if caps := currentPlatform().Capabilities(); caps != nil {
		t.Errorf("expected nil capabilities on non-Linux, got %v", caps)
	}
	if (currentPlatform().ExtraInventory() != ExtraInventory{}) {
		t.Error("expected zero ExtraInventory on non-Linux")
	}
}
