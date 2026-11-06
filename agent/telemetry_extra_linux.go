//go:build linux

package main

import (
	"net"
	"os"
	"strings"
	"time"
)

var diskClockStart = time.Now()

// diskIOTargets: on Linux the counters belong to whole disks, not mount points.
func diskIOTargets([]string) []string {
	entries, err := os.ReadDir("/sys/block")
	if err != nil {
		return nil
	}
	var names []string
	for _, entry := range entries {
		if isPhysicalBlockDevice(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	return names
}

func readDiskCounters(device string) (diskCounters, bool) {
	raw, err := os.ReadFile("/proc/diskstats")
	if err != nil {
		return diskCounters{}, false
	}
	return parseDiskStats(string(raw), device, time.Since(diskClockStart).Seconds())
}

func defaultGateway() string {
	raw, err := os.ReadFile("/proc/net/route")
	if err != nil {
		return ""
	}
	return parseDefaultGateway(string(raw))
}

// pingHost sends real ICMP echoes over a raw socket; the agent runs as root. No
// ping binary is needed, so minimal systems measure the same as any other.
func pingHost(host string, count int, timeout time.Duration) ([]float64, int) {
	conn, err := net.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		return nil, 0
	}
	defer conn.Close()
	target := &net.IPAddr{IP: net.ParseIP(host)}
	if target.IP == nil {
		return nil, 0
	}
	id := uint16(os.Getpid())
	buf := make([]byte, 1500)
	var rtts []float64
	sent := 0
	for seq := 0; seq < count; seq++ {
		started := time.Now()
		if _, err := conn.WriteTo(icmpEchoRequest(id, uint16(seq)), target); err != nil {
			continue
		}
		sent++
		_ = conn.SetReadDeadline(started.Add(timeout))
		for {
			n, from, err := conn.ReadFrom(buf)
			if err != nil {
				break // timed out: this one is lost
			}
			if strings.EqualFold(from.String(), target.String()) && isICMPEchoReply(buf[:n], id, uint16(seq)) {
				rtts = append(rtts, float64(time.Since(started).Microseconds())/1000)
				break
			}
		}
	}
	return rtts, sent
}
