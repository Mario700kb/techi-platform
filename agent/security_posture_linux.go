//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

const linuxToolTimeout = 15 * time.Second

func securityPostureCollector() func() *SecurityPosture { return collectLinuxSecurityPosture }

// collectLinuxSecurityPosture reads the same report as on Windows, as far as a
// Linux machine has the same things: firewall, disk encryption of the system
// disk (LUKS), Secure Boot, antivirus when one runs, and who is an administrator.
// Defender and UAC do not exist here and stay absent.
func collectLinuxSecurityPosture() *SecurityPosture {
	p := &SecurityPosture{Platform: "linux"}
	p.Firewall.Public = linuxFirewallOn()
	p.BitLocker.SystemDrive = "/"
	p.BitLocker.Protection = linuxRootEncryption()
	p.SecureBoot = linuxSecureBoot()
	if text, ok := runLinuxTool(linuxToolTimeout, "systemctl", "list-units", "--type=service", "--all", "--plain", "--no-legend", "--no-pager"); ok {
		p.ThirdPartyAV = linuxAntivirusNames(parseSystemdUnits(text))
	}
	var admins []string
	if raw, err := os.ReadFile("/etc/passwd"); err == nil {
		admins = append(admins, parseRootUsers(string(raw))...)
	}
	if raw, err := os.ReadFile("/etc/group"); err == nil {
		admins = append(admins, parseAdminGroups(string(raw))...)
	}
	p.LocalAdmins = admins
	p.normalise(time.Now())
	return p
}

// linuxFirewallOn: nil when no tool could say.
func linuxFirewallOn() *bool {
	yes, no := true, false
	if out, ok := runLinuxTool(linuxToolTimeout, "ufw", "status"); ok && strings.Contains(out, "Status: active") {
		return &yes
	}
	if out, ok := runLinuxTool(linuxToolTimeout, "firewall-cmd", "--state"); ok && strings.Contains(out, "running") {
		return &yes
	}
	nftOut, nftRan := runLinuxTool(linuxToolTimeout, "nft", "list", "ruleset")
	if nftRan && firewallFromNft(nftOut) {
		return &yes
	}
	if out, ok := runLinuxTool(linuxToolTimeout, "iptables", "-S", "INPUT"); ok {
		if on, read := firewallFromIptables(out); read {
			if on {
				return &yes
			}
			return &no
		}
	}
	if nftRan {
		return &no
	}
	return nil
}

// linuxRootEncryption: "on" when the root file system sits on a LUKS device.
func linuxRootEncryption() string {
	source, ok := runLinuxTool(linuxToolTimeout, "findmnt", "-no", "SOURCE", "/")
	if !ok {
		return "unknown"
	}
	// btrfs shows its subvolume: /dev/sda2[/@]
	device, _, _ := strings.Cut(strings.TrimSpace(source), "[")
	if !strings.HasPrefix(device, "/dev/") {
		return "unknown" // a container's overlay, a network root
	}
	types, ok := runLinuxTool(linuxToolTimeout, "lsblk", "-s", "-no", "TYPE", device)
	if !ok {
		return "unknown"
	}
	for _, kind := range strings.Fields(types) {
		if kind == "crypt" {
			return "on"
		}
	}
	return "off"
}

// linuxSecureBoot: nil on BIOS machines and the Raspberry Pi, which have no UEFI.
func linuxSecureBoot() *bool {
	matches, _ := filepath.Glob("/sys/firmware/efi/efivars/SecureBoot-*")
	if len(matches) == 0 {
		return nil
	}
	raw, err := os.ReadFile(matches[0])
	if err != nil {
		return nil
	}
	return secureBootFromEfivar(raw)
}
