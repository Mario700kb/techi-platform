package main

// Platform Abstraction Layer (PLATFORM-EXPANSION-AUDIT.md §12).
//
// The agent has always split OS-specific code by build tag (`*_windows.go`
// vs `*_other.go`). This file formalizes that split into a single documented
// contract so new platforms (Linux first) plug in without touching shared
// business logic. Each GOOS provides a `currentPlatform()` returning its
// implementation; shared code depends only on this interface.
//
// Windows contract: `platform_windows.go` returns empty ExtraInventory and no
// capabilities, so the Windows heartbeat payload is byte-for-byte unchanged
// (every new field is `omitempty`). Capability reporting is a Linux+ feature.

// ExtraInventory carries the additive, platform-neutral facts introduced by
// Platform Expansion (backend columns from Phase 1). All fields are optional;
// a platform that cannot determine one leaves it empty.
type ExtraInventory struct {
	FQDN          string
	KernelVersion string
	Architecture  string
	MACAddress    string
	Timezone      string
	LastBootAt    string // RFC3339; empty when unknown
}

// Platform is the per-OS contract consumed by shared inventory/heartbeat code.
type Platform interface {
	// Capabilities reports what this endpoint supports, from the controlled
	// vocabulary the backend knows (see platform_core.capabilities). Windows
	// returns nil to keep its payload unchanged.
	Capabilities() []string
	// ExtraInventory returns the additive facts above. Windows returns a zero
	// value (all omitempty → omitted).
	ExtraInventory() ExtraInventory
}
