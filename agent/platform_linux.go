//go:build linux

package main

import (
	"net"
	"os"
	"os/exec"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// linuxPlatform is the first native non-Windows platform. It reports real
// capabilities and inventory; everything is best-effort with graceful
// fallbacks so a minimal distro still enrolls.
type linuxPlatform struct{}

func currentPlatform() Platform { return linuxPlatform{} }

// Capabilities are computed at runtime and restricted to the vocabulary the
// backend knows (platform_core.capabilities). A capability is reported only
// when its prerequisite is actually present.
func (linuxPlatform) Capabilities() []string {
	caps := []string{"terminal", "processes", "services", "interfaces", "logs"}
	if _, err := exec.LookPath("bash"); err == nil {
		caps = append(caps, "bash")
	}
	if _, err := exec.LookPath("python3"); err == nil {
		caps = append(caps, "python")
	}
	if hasSystemd() {
		caps = append(caps, "systemd")
	}
	if _, err := exec.LookPath("journalctl"); err == nil {
		caps = append(caps, "journal")
	}
	if linuxPackageManager() != "" {
		caps = append(caps, "packages")
	}
	if dockerAvailable() {
		caps = append(caps, "docker")
	}
	return caps
}

func (linuxPlatform) ExtraInventory() ExtraInventory {
	return ExtraInventory{
		FQDN:          linuxFQDN(),
		KernelVersion: linuxKernelVersion(),
		Architecture:  linuxArch(),
		MACAddress:    primaryMAC(),
		Timezone:      linuxTimezone(),
		LastBootAt:    linuxLastBootAt(),
	}
}

func hasSystemd() bool {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return false
	}
	// systemd exposes this cgroup/dir when it is PID 1.
	if _, err := os.Stat("/run/systemd/system"); err == nil {
		return true
	}
	return false
}

func dockerAvailable() bool {
	if fi, err := os.Stat("/var/run/docker.sock"); err == nil && fi.Mode()&os.ModeSocket != 0 {
		return true
	}
	_, err := exec.LookPath("docker")
	return err == nil
}

// linuxPackageManager returns the detected package manager name, or "".
func linuxPackageManager() string {
	for _, mgr := range []string{"apt-get", "dnf", "yum", "zypper", "pacman"} {
		if _, err := exec.LookPath(mgr); err == nil {
			return mgr
		}
	}
	return ""
}

func linuxKernelVersion() string {
	var uts unix.Utsname
	if err := unix.Uname(&uts); err != nil {
		return ""
	}
	return unix.ByteSliceToString(uts.Release[:])
}

func linuxArch() string {
	var uts unix.Utsname
	if err := unix.Uname(&uts); err == nil {
		if m := unix.ByteSliceToString(uts.Machine[:]); m != "" {
			return m
		}
	}
	return ""
}

func linuxFQDN() string {
	host, err := os.Hostname()
	if err != nil {
		return ""
	}
	// A short hostname resolves to its FQDN via the resolver; ignore failures.
	if !strings.Contains(host, ".") {
		if addrs, err := net.LookupAddr(host); err == nil && len(addrs) > 0 {
			return strings.TrimSuffix(addrs[0], ".")
		}
	}
	return host
}

func primaryMAC() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 || iface.HardwareAddr == nil {
			continue
		}
		if iface.Flags&net.FlagUp != 0 && len(iface.HardwareAddr) > 0 {
			return iface.HardwareAddr.String()
		}
	}
	return ""
}

func linuxTimezone() string {
	// /etc/timezone (Debian family) is the cheapest source.
	if data, err := os.ReadFile("/etc/timezone"); err == nil {
		if tz := strings.TrimSpace(string(data)); tz != "" {
			return tz
		}
	}
	// Fall back to the /etc/localtime symlink target (…/zoneinfo/Area/City).
	if target, err := os.Readlink("/etc/localtime"); err == nil {
		if idx := strings.Index(target, "zoneinfo/"); idx != -1 {
			return target[idx+len("zoneinfo/"):]
		}
	}
	return ""
}

func linuxLastBootAt() string {
	var info unix.Sysinfo_t
	if err := unix.Sysinfo(&info); err != nil {
		return ""
	}
	boot := time.Now().Add(-time.Duration(info.Uptime) * time.Second)
	return boot.UTC().Format(time.RFC3339)
}

// osReleaseField reads a single field (e.g. "NAME", "VERSION_ID") from
// /etc/os-release, returning "" when absent. Shared by inventory_linux.go.
func osReleaseField(key string) string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, key+"=") {
			continue
		}
		val := strings.TrimPrefix(line, key+"=")
		val = strings.TrimSpace(val)
		val = strings.Trim(val, "\"")
		return val
	}
	return ""
}
