//go:build !windows && !linux

package main

// otherPlatform is the fallback for dev cross-compiles (e.g. darwin). Like
// Windows it reports nothing extra, so only Linux carries the expansion fields.
type otherPlatform struct{}

func currentPlatform() Platform { return otherPlatform{} }

func (otherPlatform) Capabilities() []string { return nil }

func (otherPlatform) ExtraInventory() ExtraInventory { return ExtraInventory{} }
