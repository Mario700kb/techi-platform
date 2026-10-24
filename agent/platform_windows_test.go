//go:build windows

package main

import (
	"net"
	"testing"
)

func TestMacForIPNamesTheAdapterHoldingTheIP(t *testing.T) {
	if got := macForIP(""); got != "" {
		t.Fatalf("empty ip: %q", got)
	}
	if got := macForIP("203.0.113.9"); got != "" {
		t.Fatalf("an address no adapter holds: %q", got)
	}
	if got := macForIP("127.0.0.1"); got != "" {
		t.Fatalf("loopback has no hardware address: %q", got)
	}

	ifaces, err := net.Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, iface := range ifaces {
		if len(iface.HardwareAddr) == 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			if got := macForIP(ipNet.IP.String()); got != iface.HardwareAddr.String() {
				t.Errorf("%s on %s: got %q, want %q", ipNet.IP, iface.Name, got, iface.HardwareAddr)
			}
			checked++
		}
	}
	if checked == 0 {
		t.Skip("no adapter with a hardware address on this machine")
	}
}

func TestWindowsExtraInventoryReportsTheLocalIPsAdapter(t *testing.T) {
	ip := getLocalIP()
	if ip == "" {
		t.Skip("no local IP on this machine")
	}
	if got, want := (windowsPlatform{}).ExtraInventory().MACAddress, macForIP(ip); got != want {
		t.Fatalf("MACAddress %q, want the adapter of %s: %q", got, ip, want)
	}
}
