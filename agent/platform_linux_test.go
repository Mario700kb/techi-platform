//go:build linux

package main

import "testing"

// On a real Linux build the build-tag-selected currentPlatform() reports the
// always-available base capabilities and a non-nil capability set. Values that
// depend on the host (kernel version, installed tooling like docker/systemd) are
// intentionally not asserted, so this is deterministic on any Linux host,
// including the CI runner. This is the Linux counterpart to
// TestExtraInventoryEmptyOnNonLinux.
func TestLinuxPlatformReportsBaseCapabilities(t *testing.T) {
	caps := currentPlatform().Capabilities()
	if caps == nil {
		t.Fatal("expected non-nil capabilities on Linux")
	}
	seen := make(map[string]bool, len(caps))
	for _, c := range caps {
		seen[c] = true
	}
	for _, base := range []string{"terminal", "processes", "services", "interfaces", "logs"} {
		if !seen[base] {
			t.Errorf("expected unconditional base capability %q on Linux, got %v", base, caps)
		}
	}
}
