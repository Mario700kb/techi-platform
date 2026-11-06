//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/host"
)

const (
	healthToolTimeout = 30 * time.Second
	journalMaxLines   = "5000"
)

func deviceHealthCollector() func() *DeviceHealth { return collectLinuxDeviceHealth }

func collectLinuxDeviceHealth() *DeviceHealth {
	h := &DeviceHealth{}
	h.Disks = linuxPhysicalDisks()
	h.RebootPending, h.RebootReasons = linuxRebootPending()
	h.Events = linuxHealthEvents()
	h.normalise(time.Now())
	return h
}

// linuxPhysicalDisks lists every disk from sysfs. Health needs smartctl, from the
// smartmontools package: without it the disk is listed with its health unknown.
func linuxPhysicalDisks() healthDiskList {
	entries, err := os.ReadDir("/sys/block")
	if err != nil {
		return nil
	}
	disks := healthDiskList{}
	for _, entry := range entries {
		name := entry.Name()
		if !isPhysicalBlockDevice(name) {
			continue
		}
		base := filepath.Join("/sys/block", name)
		sysPath, _ := filepath.EvalSymlinks(base)
		d := HealthDisk{Health: "unknown", Bus: linuxDiskBus(name, sysPath)}
		model, _ := os.ReadFile(filepath.Join(base, "device", "model"))
		d.Name = linuxDiskName(name, string(model))
		if n, ok := readSysfsNumber(filepath.Join(base, "size")); ok && n > 0 {
			gb := float64(int64(n*linuxSectorBytes/1e9*10+0.5)) / 10
			d.SizeGB = &gb
		}
		if rotational, ok := readSysfsNumber(filepath.Join(base, "queue", "rotational")); ok && d.Bus != "Virtual" && d.Bus != "SD" {
			d.Media = "SSD"
			if rotational == 1 {
				d.Media = "HDD"
			}
		}
		// smartctl exits non-zero to flag a failing disk, and still prints its report.
		if out, _ := runLinuxToolOutput(healthToolTimeout, "smartctl", "-j", "-H", "-A", "/dev/"+name); len(out) > 0 {
			applySmartctl(&d, out)
		}
		disks = append(disks, d)
	}
	return disks
}

// linuxRebootPending: Debian, Ubuntu and Raspberry Pi OS leave a file; Red Hat's
// family has needs-restarting. Elsewhere it stays unknown.
func linuxRebootPending() (*bool, postureStringList) {
	yes, no := true, false
	if _, err := os.Stat("/var/run/reboot-required"); err == nil {
		return &yes, postureStringList{"package_update"}
	}
	if _, err := os.Stat("/etc/debian_version"); err == nil {
		return &no, nil
	}
	// needs-restarting exits 1 when a restart is needed, so its words decide.
	out, ran := runLinuxToolOutput(healthToolTimeout, "needs-restarting", "-r")
	if strings.Contains(string(out), "Reboot is required") {
		return &yes, postureStringList{"package_update"}
	}
	if ran {
		return &no, nil
	}
	return nil, nil
}

func linuxHealthEvents() healthEventList {
	since := fmt.Sprintf("--since=-%dh", healthEventLookbackH)
	events := healthEventList{}
	if out, ok := runLinuxTool(healthToolTimeout, "journalctl", "_TRANSPORT=kernel", "-p", "warning", since, "-n", journalMaxLines, "-o", "json", "--no-pager"); ok {
		events = append(events, parseKernelJournal(out)...)
	}
	if out, ok := runLinuxTool(healthToolTimeout, "journalctl", "_PID=1", since, "-n", journalMaxLines, "-o", "json", "--no-pager"); ok {
		events = append(events, parseFailedUnits(out)...)
	}
	// Only a boot inside the window can be an unexplained restart in it.
	if uptime, err := host.Uptime(); err == nil && uptime < healthEventLookbackH*3600 {
		if out, ok := runLinuxTool(healthToolTimeout, "journalctl", "-b", "-1", "-n", "200", "-o", "cat", "--no-pager"); ok {
			if clean, known := previousBootEndedCleanly(out); known && !clean {
				bootAt := time.Now().Add(-time.Duration(uptime) * time.Second).UTC()
				events = append(events, HealthEvent{
					RecordID: bootAt.Unix(),
					Source:   linuxBootSource,
					EventID:  linuxEventUncleanBoot,
					At:       bootAt.Format(time.RFC3339),
					Message:  "The previous boot's log ends without a shutdown " + strconv.FormatUint(uptime/60, 10) + " minutes ago",
				})
			}
		}
	}
	return events
}
