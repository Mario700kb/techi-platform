//go:build windows

package main

// windowsPlatform keeps the Windows agent's observable behavior unchanged:
// no capabilities and an empty ExtraInventory, so the heartbeat payload is
// byte-for-byte identical to pre-PAL builds (every new field is omitempty).
type windowsPlatform struct{}

func currentPlatform() Platform { return windowsPlatform{} }

func (windowsPlatform) Capabilities() []string { return nil }

func (windowsPlatform) ExtraInventory() ExtraInventory { return ExtraInventory{} }
