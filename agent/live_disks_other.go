//go:build !windows

package main

import (
	"math"
	"strings"

	"github.com/shirou/gopsutil/v3/disk"
)

// Pseudo and network filesystems are not disks an operator watches, and a
// network mount that does not answer would stall the live stream.
var liveSkipFilesystems = map[string]bool{
	"tmpfs": true, "devtmpfs": true, "overlay": true, "squashfs": true, "proc": true,
	"sysfs": true, "cgroup": true, "cgroup2": true, "nfs": true, "nfs4": true,
	"cifs": true, "smbfs": true, "fuse.sshfs": true, "autofs": true,
}

func liveDiskMounts() []string {
	partitions, err := disk.Partitions(false)
	if err != nil {
		return nil
	}
	var mounts []string
	for _, p := range partitions {
		if liveSkipFilesystems[strings.ToLower(p.Fstype)] || strings.HasPrefix(p.Mountpoint, "/snap/") {
			continue
		}
		mounts = append(mounts, p.Mountpoint)
	}
	return mounts
}

func liveDiskUsage(mount string) (liveDisk, bool) {
	usage, err := disk.Usage(mount)
	if err != nil || usage.Total == 0 || math.IsNaN(usage.UsedPercent) {
		return liveDisk{}, false
	}
	return liveDisk{
		Mount:       mount,
		UsedPercent: round1(usage.UsedPercent),
		FreeGB:      round1(float64(usage.Free) / (1 << 30)),
		TotalGB:     round1(float64(usage.Total) / (1 << 30)),
	}, true
}
