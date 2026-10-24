//go:build windows

package main

import (
	"net"
	"strings"
)

// windowsPlatform keeps the Windows heartbeat close to pre-PAL builds: an
// ExtraInventory with the MAC address only (from 2.1.41; every other field is
// omitempty) and one capability, "powershell", from 2.1.29 and only where the
// pseudo console exists — it is what lets the platform offer the
// administrator PowerShell console.
type windowsPlatform struct{}

func currentPlatform() Platform { return windowsPlatform{} }

func (windowsPlatform) Capabilities() []string {
	if conPTYAvailable() {
		return []string{"powershell"}
	}
	return nil
}

func (windowsPlatform) ExtraInventory() ExtraInventory {
	return ExtraInventory{MACAddress: macForIP(getLocalIP())}
}

// macForIP is the MAC address of the adapter that holds ip, so the MAC and the
// local IP the agent reports describe the same network card (a Hyper-V switch
// or a VPN adapter may come first in the list). "" when no adapter holds it.
func macForIP(ip string) string {
	target := net.ParseIP(strings.TrimSpace(ip))
	if target == nil {
		return ""
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if len(iface.HardwareAddr) == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			if ipNet, ok := addr.(*net.IPNet); ok && ipNet.IP.Equal(target) {
				return iface.HardwareAddr.String()
			}
		}
	}
	return ""
}
