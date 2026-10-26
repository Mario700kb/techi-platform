package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"

	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
)

func getLocalIP() string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return ""
	}

	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}

		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			ip = ip.To4()
			if ip == nil {
				continue
			}
			return ip.String()
		}
	}

	return ""
}

// buildRAMInfo is the memory as people know it: "4 GB", "512 MB". Windows
// reports what is installed; elsewhere (or when Windows cannot tell) the
// usable total is rounded to the nearest GB, never down: 3.8 GB usable on a
// 4 GB PC used to show "3 GB".
func buildRAMInfo() string {
	size := installedRAMBytes()
	if size == 0 {
		stats, err := mem.VirtualMemory()
		if err != nil {
			return ""
		}
		size = stats.Total
	}
	return formatRAM(size)
}

func formatRAM(size uint64) string {
	const mib, gib = 1 << 20, 1 << 30
	if size == 0 {
		return ""
	}
	if size < gib-gib/10 {
		return fmt.Sprintf("%d MB", (size+mib/2)/mib)
	}
	return fmt.Sprintf("%d GB", (size+gib/2)/gib)
}

func buildStorageInfo() string {
	path := "/"
	if runtime.GOOS == "windows" {
		drive := os.Getenv("SystemDrive")
		if drive != "" {
			path = filepath.Join(drive, "\\")
		}
	}

	usage, err := disk.Usage(path)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%d GB free / %d GB total", usage.Free/1024/1024/1024, usage.Total/1024/1024/1024)
}
