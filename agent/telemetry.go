package main

import (
	"net"
	"net/url"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
)

type Telemetry struct {
	CPUPercent         float64 `json:"cpu_percent"`
	RAMPercent         float64 `json:"ram_percent"`
	DiskPercent        float64 `json:"disk_percent"`
	UptimeSeconds      uint64  `json:"uptime_seconds"`
	HeartbeatLatencyMs int64   `json:"heartbeat_latency_ms"`
}

func collectTelemetry() *Telemetry {
	t := &Telemetry{}

	percents, err := cpu.Percent(100*time.Millisecond, false)
	if err == nil && len(percents) > 0 {
		t.CPUPercent = percents[0]
	}

	vmStat, err := mem.VirtualMemory()
	if err == nil {
		t.RAMPercent = vmStat.UsedPercent
	}

	diskPath := "/"
	if runtime.GOOS == "windows" {
		diskPath = `C:\`
	}
	diskStat, err := disk.Usage(diskPath)
	if err == nil {
		t.DiskPercent = diskStat.UsedPercent
	}

	uptime, err := host.Uptime()
	if err == nil {
		t.UptimeSeconds = uptime
	}

	return t
}

func measureLatencyMs(backendURL string, timeoutSeconds int) int64 {
	u, err := url.Parse(backendURL)
	if err != nil || u.Host == "" {
		return 0
	}
	timeout := time.Duration(timeoutSeconds) * time.Second
	start := time.Now()
	conn, err := net.DialTimeout("tcp", u.Host, timeout)
	if err != nil {
		return 0
	}
	elapsed := time.Since(start).Milliseconds()
	conn.Close()
	return elapsed
}
