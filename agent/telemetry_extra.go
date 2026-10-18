package main

// What 2.1.33 adds to every sample, to explain a slow machine rather than
// only show it:
//
//   - disk activity: how busy the busiest volume was (% of the minute with
//     I/O in flight), its average queue and the bytes read and written per
//     second over all fixed volumes (Windows: IOCTL_DISK_PERFORMANCE);
//   - network quality: round trip and loss of four pings to the default
//     gateway (Windows: IcmpSendEcho, no PowerShell) and the TCP connect time
//     to the platform;
//   - in a busy minute only (CPU >= 15% or memory >= 80%), the processes that
//     used most CPU over the minute (share of the whole machine) and most
//     memory — so "CPU 90% at 03:05" says who.
//
// Each reading is native and costs milliseconds; one that fails is left out
// of the sample (null on the platform), never guessed.

import (
	"net"
	"net/url"
	"sort"
	"strings"
	"time"

	gopsprocess "github.com/shirou/gopsutil/v3/process"
)

const (
	topProcessCount    = 3
	topProcessMaxCount = 5
	topBusyCPU         = 15.0
	topBusyMem         = 80.0

	// A volume smaller than this (recovery, EFI, a small data partition) is
	// sampled and shown but never raises a disk alert.
	smallVolumeGB       = 5.0
	gatewayPings        = 4
	gatewayPingTimeout  = time.Second
	gatewayRefreshEvery = 15 * time.Minute
	platformDialTimeout = 3 * time.Second
)

type topProcess struct {
	Name  string  `json:"n"`
	CPU   float64 `json:"c"`
	MemMB float64 `json:"m"`
}

// ── processes ───────────────────────────────────────────────────────────────

type procTimes struct {
	cpu     float64 // user + kernel seconds
	created int64   // ms since epoch: a reused PID is another process
}

// processSampler keeps every process's CPU time from the previous minute, so
// a process's share is measured over the whole minute, not one instant.
type processSampler struct {
	last   map[int32]procTimes
	lastAt time.Time
	cpus   int
}

type procReading struct {
	proc  *gopsprocess.Process
	cpu   float64
	memMB float64
}

// sample updates the CPU baseline and, when busy, returns the top processes.
func (p *processSampler) sample(at time.Time, busyCPU, busyMem bool) []topProcess {
	procs, err := gopsprocess.Processes()
	if err != nil {
		return nil
	}
	cpus := p.cpus
	if cpus <= 0 {
		cpus = 1
	}
	elapsed := at.Sub(p.lastAt).Seconds()
	current := make(map[int32]procTimes, len(procs))
	readings := make([]procReading, 0, len(procs))
	for _, proc := range procs {
		if proc.Pid == 0 {
			continue // System Idle Process
		}
		times, err := proc.Times()
		if err != nil {
			continue
		}
		created, _ := proc.CreateTime()
		total := times.User + times.System
		current[proc.Pid] = procTimes{cpu: total, created: created}
		reading := procReading{proc: proc}
		if prev, ok := p.last[proc.Pid]; ok && prev.created == created && elapsed > 0 && total >= prev.cpu {
			reading.cpu = clampPercent((total - prev.cpu) / elapsed / float64(cpus) * 100)
		}
		if busyMem {
			if info, err := proc.MemoryInfo(); err == nil && info != nil {
				reading.memMB = float64(info.RSS) / (1024 * 1024)
			}
		}
		readings = append(readings, reading)
	}
	first := p.last == nil
	p.last, p.lastAt = current, at
	if first || (!busyCPU && !busyMem) {
		return nil
	}
	return pickTopProcesses(readings, busyCPU, busyMem, func(r procReading) (string, float64) {
		mem := r.memMB
		if mem == 0 {
			if info, err := r.proc.MemoryInfo(); err == nil && info != nil {
				mem = float64(info.RSS) / (1024 * 1024)
			}
		}
		if exe, err := r.proc.Exe(); err == nil && exe != "" {
			return exe, mem
		}
		name, _ := r.proc.Name()
		return name, mem
	})
}

// pickTopProcesses: the top three CPU users of a CPU-busy minute, then those
// of the top three memory users of a memory-busy one not listed yet — at most
// five. describe gives a picked process's name and memory (MB); they are read
// only for those, since reading them opens the process.
func pickTopProcesses(readings []procReading, busyCPU, busyMem bool, describe func(procReading) (string, float64)) []topProcess {
	var picked []procReading
	seen := map[int32]bool{}
	if busyCPU {
		byCPU := append([]procReading(nil), readings...)
		sort.SliceStable(byCPU, func(i, j int) bool { return byCPU[i].cpu > byCPU[j].cpu })
		for _, r := range byCPU {
			if len(picked) >= topProcessCount || r.cpu < 1 {
				break
			}
			picked = append(picked, r)
			seen[pidOf(r)] = true
		}
	}
	if busyMem {
		byMem := append([]procReading(nil), readings...)
		sort.SliceStable(byMem, func(i, j int) bool { return byMem[i].memMB > byMem[j].memMB })
		if len(byMem) > topProcessCount {
			byMem = byMem[:topProcessCount]
		}
		for _, r := range byMem {
			if len(picked) >= topProcessMaxCount || r.memMB <= 0 {
				break
			}
			if !seen[pidOf(r)] {
				picked = append(picked, r)
				seen[pidOf(r)] = true
			}
		}
	}
	out := make([]topProcess, 0, len(picked))
	for _, r := range picked {
		path, mem := describe(r)
		name := baseName(path)
		if name == "" {
			continue
		}
		out = append(out, topProcess{Name: name, CPU: round1(r.cpu), MemMB: float64(int64(mem + 0.5))})
	}
	return out
}

func pidOf(r procReading) int32 {
	if r.proc == nil {
		return -1
	}
	return r.proc.Pid
}

// baseName is the executable's file name ("sqlservr.exe"), at most 64 characters.
func baseName(path string) string {
	path = strings.TrimSpace(path)
	if i := strings.LastIndexAny(path, `\/`); i >= 0 {
		path = path[i+1:]
	}
	if r := []rune(path); len(r) > 64 {
		path = string(r[:64])
	}
	return path
}

// ── disk activity ───────────────────────────────────────────────────────────

// diskCounters are one volume's cumulative I/O counters.
type diskCounters struct {
	readBytes  uint64
	writeBytes uint64
	ioTime     float64 // seconds the volume spent with requests (read + write), summed per request
	idleTime   float64 // seconds idle
	queryTime  float64 // seconds on the counters' own clock
}

type diskActivity struct {
	last map[string]diskCounters
	read func(mount string) (diskCounters, bool) // readDiskCounters; tests replace it
}

// sample: busiest volume's busy % and average queue since the last call,
// bytes/s read and written over all volumes. Nil values on the first call or
// where the counters are not available.
func (d *diskActivity) sample(mounts []string) (busy, queue, readBps, writeBps *float64) {
	read := d.read
	if read == nil {
		read = readDiskCounters
	}
	current := map[string]diskCounters{}
	for _, mount := range mounts {
		if len(mount) < 2 {
			continue
		}
		if c, ok := read(mount); ok {
			current[strings.ToUpper(mount[:2])] = c
		}
	}
	prev := d.last
	d.last = current
	if prev == nil || len(current) == 0 {
		return nil, nil, nil, nil
	}
	var maxBusy, maxQueue, reads, writes float64
	measured := false
	for mount, now := range current {
		was, ok := prev[mount]
		span := now.queryTime - was.queryTime
		if !ok || span <= 0 || now.readBytes < was.readBytes || now.writeBytes < was.writeBytes {
			continue
		}
		measured = true
		idle := now.idleTime - was.idleTime
		if b := clampPercent((span - idle) / span * 100); b > maxBusy {
			maxBusy = b
		}
		if q := (now.ioTime - was.ioTime) / span; q > maxQueue {
			maxQueue = q
		}
		reads += float64(now.readBytes-was.readBytes) / span
		writes += float64(now.writeBytes-was.writeBytes) / span
	}
	if !measured {
		return nil, nil, nil, nil
	}
	b, q := round1(maxBusy), round1(maxQueue)
	r, w := float64(int64(reads+0.5)), float64(int64(writes+0.5))
	return &b, &q, &r, &w
}

// ── network quality ─────────────────────────────────────────────────────────

type networkQuality struct {
	gateway   string
	gatewayAt time.Time

	// answered: this gateway has replied at least once. Some routers never
	// answer pings; their silence is "unknown", not 100% loss.
	answered bool
	ping     func(host string, count int, timeout time.Duration) ([]float64, int)
	lookup   func() string
}

// sample pings the default gateway (looked up every 15 minutes): average
// round trip of the replies and the share lost. Nil when there is no IPv4
// gateway, pinging is not available here, or the gateway never answers.
func (n *networkQuality) sample(at time.Time) (ms, loss *float64) {
	lookup, ping := n.lookup, n.ping
	if lookup == nil {
		lookup = defaultGateway
	}
	if ping == nil {
		ping = pingHost
	}
	if n.gatewayAt.IsZero() || at.Sub(n.gatewayAt) >= gatewayRefreshEvery {
		if gw := lookup(); gw != n.gateway {
			n.gateway, n.answered = gw, false
		}
		n.gatewayAt = at
	}
	if n.gateway == "" {
		return nil, nil
	}
	rtts, sent := ping(n.gateway, gatewayPings, gatewayPingTimeout)
	if sent == 0 {
		return nil, nil
	}
	if len(rtts) > 0 {
		n.answered = true
	} else if !n.answered {
		return nil, nil
	}
	lost := round1(float64(sent-len(rtts)) / float64(sent) * 100)
	loss = &lost
	if len(rtts) > 0 {
		var sum float64
		for _, r := range rtts {
			sum += r
		}
		avg := round1(sum / float64(len(rtts)))
		ms = &avg
	}
	return ms, loss
}

// platformConnectMs is the TCP connect time to the platform, the path every
// heartbeat, upload and remote session takes. Nil when it did not connect.
func platformConnectMs(backendURL string) *float64 {
	u, err := url.Parse(strings.TrimSpace(backendURL))
	if err != nil || u.Hostname() == "" {
		return nil
	}
	host := u.Host
	if u.Port() == "" {
		port := "443"
		if u.Scheme == "http" {
			port = "80"
		}
		host = net.JoinHostPort(u.Hostname(), port)
	}
	start := time.Now()
	conn, err := net.DialTimeout("tcp", host, platformDialTimeout)
	if err != nil {
		return nil
	}
	elapsed := round1(float64(time.Since(start).Microseconds()) / 1000)
	_ = conn.Close()
	return &elapsed
}
