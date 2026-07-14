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

// applyExpansionInventory copies a platform's additive expansion facts and
// capabilities onto inv. It is the single, OS-neutral wiring point shared by
// collectInventory (production) and the unit tests.
//
// The platform is passed in explicitly rather than read from a package global,
// so production supplies the build-tag-selected currentPlatform() while tests
// inject a deterministic fake Platform. That keeps the tests from depending on
// the host OS that compiles them: a Linux CI runner's currentPlatform() reports
// real Linux data, which would otherwise leak into a simulated Windows payload.
//
// A platform that reports nothing (Windows/other → zero ExtraInventory, nil
// capabilities) leaves every field empty, so buildHeartbeatPayload omits them
// via the struct's omitempty tags. Linux-only fields are therefore present only
// when the supplied platform actually collected them.
func applyExpansionInventory(inv *Inventory, p Platform) {
	extra := p.ExtraInventory()
	inv.FQDN = extra.FQDN
	inv.KernelVersion = extra.KernelVersion
	inv.Architecture = extra.Architecture
	inv.MACAddress = extra.MACAddress
	inv.Timezone = extra.Timezone
	inv.LastBootAt = extra.LastBootAt
	inv.Capabilities = p.Capabilities()
}
