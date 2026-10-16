//go:build windows

package main

import (
	"golang.org/x/sys/windows"

	"github.com/shirou/gopsutil/v3/disk"
)

// liveDiskMounts lists local fixed drives only. Network, removable and
// optical drives are skipped: one that does not answer would stall the live
// stream on every sample.
func liveDiskMounts() []string {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil
	}
	var mounts []string
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		rootPtr, err := windows.UTF16PtrFromString(root)
		if err != nil {
			continue
		}
		if windows.GetDriveType(rootPtr) == windows.DRIVE_FIXED {
			mounts = append(mounts, root)
		}
	}
	return mounts
}

func liveDiskUsage(mount string) (liveDisk, bool) {
	usage, err := disk.Usage(mount)
	if err != nil || usage.Total == 0 {
		return liveDisk{}, false
	}
	return liveDisk{
		Mount:       mount[:2],
		UsedPercent: round1(usage.UsedPercent),
		FreeGB:      round1(float64(usage.Free) / (1 << 30)),
		TotalGB:     round1(float64(usage.Total) / (1 << 30)),
	}, true
}
