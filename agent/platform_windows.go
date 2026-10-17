//go:build windows

package main

// windowsPlatform keeps the Windows heartbeat close to pre-PAL builds: an
// empty ExtraInventory (every new field is omitempty) and one capability,
// "powershell", from 2.1.29 and only where the pseudo console exists — it is
// what lets the platform offer the administrator PowerShell console.
type windowsPlatform struct{}

func currentPlatform() Platform { return windowsPlatform{} }

func (windowsPlatform) Capabilities() []string {
	if conPTYAvailable() {
		return []string{"powershell"}
	}
	return nil
}

func (windowsPlatform) ExtraInventory() ExtraInventory { return ExtraInventory{} }
