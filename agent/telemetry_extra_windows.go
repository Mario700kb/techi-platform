//go:build windows

package main

import (
	"encoding/binary"
	"net"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modIphlpapi       = windows.NewLazySystemDLL("iphlpapi.dll")
	procGetBestRoute  = modIphlpapi.NewProc("GetBestRoute")
	procIcmpCreate    = modIphlpapi.NewProc("IcmpCreateFile")
	procIcmpClose     = modIphlpapi.NewProc("IcmpCloseHandle")
	procIcmpSendEcho  = modIphlpapi.NewProc("IcmpSendEcho")
	ioctlDiskPerf     = uint32(0x70020) // IOCTL_DISK_PERFORMANCE
	icmpReplyBufBytes = 256
)

// diskPerformance is DISK_PERFORMANCE (winioctl.h); times in 100 ns units.
type diskPerformance struct {
	BytesRead           int64
	BytesWritten        int64
	ReadTime            int64
	WriteTime           int64
	IdleTime            int64
	ReadCount           uint32
	WriteCount          uint32
	QueueDepth          uint32
	SplitCount          uint32
	QueryTime           int64
	StorageDeviceNumber uint32
	StorageManagerName  [8]uint16
	alignmentPadding    uint32 // keeps the size right on 32-bit builds
}

// readDiskCounters reads a fixed volume's cumulative counters ("C:\" or "C:").
func readDiskCounters(mount string) (diskCounters, bool) {
	if len(mount) < 2 {
		return diskCounters{}, false
	}
	path, err := windows.UTF16PtrFromString(`\\.\` + mount[:2])
	if err != nil {
		return diskCounters{}, false
	}
	h, err := windows.CreateFile(path, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return diskCounters{}, false
	}
	defer windows.CloseHandle(h)
	var perf diskPerformance
	var size uint32
	if err := windows.DeviceIoControl(h, ioctlDiskPerf, nil, 0, (*byte)(unsafe.Pointer(&perf)),
		uint32(unsafe.Sizeof(perf)), &size, nil); err != nil {
		return diskCounters{}, false
	}
	const tick = 1e7 // 100 ns units per second
	return diskCounters{
		readBytes:  uint64(perf.BytesRead),
		writeBytes: uint64(perf.BytesWritten),
		ioTime:     float64(perf.ReadTime+perf.WriteTime) / tick,
		idleTime:   float64(perf.IdleTime) / tick,
		queryTime:  float64(perf.QueryTime) / tick,
	}, true
}

// mibIPForwardRow is MIB_IPFORWARDROW: fourteen DWORDs.
type mibIPForwardRow struct {
	Dest, Mask, Policy, NextHop, IfIndex, Type, Proto, Age, NextHopAS uint32
	Metric1, Metric2, Metric3, Metric4, Metric5                       uint32
}

// ipv4ToDword is an IPv4 address in network byte order, as the IP Helper API takes it.
func ipv4ToDword(ip net.IP) uint32 {
	v4 := ip.To4()
	if v4 == nil {
		return 0
	}
	return binary.LittleEndian.Uint32(v4)
}

func dwordToIPv4(v uint32) net.IP {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, v)
	return net.IP(b)
}

// defaultGateway is the IPv4 next hop toward the internet, or "" when the
// route is on-link (no gateway) or unknown.
func defaultGateway() string {
	if procGetBestRoute.Find() != nil {
		return ""
	}
	var row mibIPForwardRow
	dest := ipv4ToDword(net.IPv4(1, 1, 1, 1))
	ret, _, _ := procGetBestRoute.Call(uintptr(dest), 0, uintptr(unsafe.Pointer(&row)))
	if ret != 0 || row.NextHop == 0 || row.NextHop == dest {
		return ""
	}
	return dwordToIPv4(row.NextHop).String()
}

// pingHost sends count ICMP echoes one after the other and returns the round
// trips (ms) of those answered, and how many were sent.
func pingHost(host string, count int, timeout time.Duration) ([]float64, int) {
	ip := net.ParseIP(host).To4()
	if ip == nil || procIcmpCreate.Find() != nil || procIcmpSendEcho.Find() != nil {
		return nil, 0
	}
	handle, _, _ := procIcmpCreate.Call()
	if handle == 0 || handle == uintptr(windows.InvalidHandle) {
		return nil, 0
	}
	defer procIcmpClose.Call(handle)
	payload := []byte("TECHI-agent-ping")
	reply := make([]byte, icmpReplyBufBytes)
	var rtts []float64
	sent := 0
	for i := 0; i < count; i++ {
		sent++
		n, _, _ := procIcmpSendEcho.Call(
			handle, uintptr(ipv4ToDword(ip)),
			uintptr(unsafe.Pointer(&payload[0])), uintptr(len(payload)), 0,
			uintptr(unsafe.Pointer(&reply[0])), uintptr(len(reply)), uintptr(timeout.Milliseconds()),
		)
		if n == 0 {
			continue
		}
		// ICMP_ECHO_REPLY: Address, Status, RoundTripTime are its first three ULONGs.
		status := binary.LittleEndian.Uint32(reply[4:8])
		if status != 0 {
			continue
		}
		rtts = append(rtts, float64(binary.LittleEndian.Uint32(reply[8:12])))
	}
	return rtts, sent
}
