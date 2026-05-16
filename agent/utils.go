package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

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

func getPublicIP(service string, timeoutSeconds int) string {
	if service == "" {
		return ""
	}

	client := &http.Client{Timeout: time.Duration(timeoutSeconds) * time.Second}
	resp, err := client.Get(service)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ""
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return ""
	}
	return string(body)
}

func buildRAMInfo() string {
	stats, err := mem.VirtualMemory()
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%d GB", stats.Total/1024/1024/1024)
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
