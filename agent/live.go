package main

// Live device view. While an operator has this device's page open, the backend
// sends live_start over the command channel every 15 s; the agent then sends a
// small snapshot every few seconds until the last request's TTL runs out or
// live_stop arrives. Nobody watching costs nothing: no sampling runs.
//
// Everything is read through native APIs (gopsutil: GetSystemTimes,
// GlobalMemoryStatusEx, GetDiskFreeSpaceEx, GetIfEntry2, OpenProcess) — no
// PowerShell — and only local fixed disks are read on Windows, so a network
// drive that does not answer cannot stall the stream.

import (
	"encoding/json"
	"log"
	"runtime"
	"sort"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	gopsnet "github.com/shirou/gopsutil/v3/net"
	gopsprocess "github.com/shirou/gopsutil/v3/process"
)

const (
	liveMinInterval   = 2 * time.Second
	liveMaxInterval   = 30 * time.Second
	liveDefaultTTL    = 45 * time.Second
	liveMaxTTL        = 2 * time.Minute
	liveTopProcesses  = 10
	liveDiskListEvery = time.Minute
)

type liveDisk struct {
	Mount       string  `json:"mount"`
	UsedPercent float64 `json:"used_percent"`
	FreeGB      float64 `json:"free_gb"`
	TotalGB     float64 `json:"total_gb"`
}

type liveProcess struct {
	PID        int32   `json:"pid"`
	Name       string  `json:"name"`
	CPUPercent float64 `json:"cpu_percent"`
	MemoryMB   float64 `json:"memory_mb"`
}

type liveSnapshot struct {
	At               int64         `json:"at"`
	CPUPercent       *float64      `json:"cpu_percent,omitempty"`
	RAMPercent       *float64      `json:"ram_percent,omitempty"`
	RAMUsedMB        float64       `json:"ram_used_mb,omitempty"`
	RAMTotalMB       float64       `json:"ram_total_mb,omitempty"`
	Disks            []liveDisk    `json:"disks"`
	NetRxKbps        *float64      `json:"net_rx_kbps,omitempty"`
	NetTxKbps        *float64      `json:"net_tx_kbps,omitempty"`
	UptimeSeconds    uint64        `json:"uptime_seconds,omitempty"`
	CurrentUser      string        `json:"current_user,omitempty"`
	UserSessionState string        `json:"user_session_state,omitempty"`
	ProcessCount     int           `json:"process_count"`
	Processes        []liveProcess `json:"processes"`
}

type liveMessage struct {
	Type string       `json:"type"`
	Data liveSnapshot `json:"data"`
}

// ── streamer ─────────────────────────────────────────────────────────────

type liveStreamer struct {
	mu       sync.Mutex
	until    time.Time
	interval time.Duration
	send     func([]byte) error
	running  bool
	now      func() time.Time
	sample   func() liveSnapshot
	sleep    func(time.Duration)
}

var agentLive = newLiveStreamer(time.Now, newLiveSampler().sample, time.Sleep)

func newLiveStreamer(now func() time.Time, sample func() liveSnapshot, sleep func(time.Duration)) *liveStreamer {
	return &liveStreamer{now: now, sample: sample, sleep: sleep}
}

func clampLiveInterval(seconds int) time.Duration {
	d := time.Duration(seconds) * time.Second
	if d < liveMinInterval {
		return liveMinInterval
	}
	if d > liveMaxInterval {
		return liveMaxInterval
	}
	return d
}

func clampLiveTTL(seconds int) time.Duration {
	d := time.Duration(seconds) * time.Second
	if d <= 0 {
		return liveDefaultTTL
	}
	if d > liveMaxTTL {
		return liveMaxTTL
	}
	return d
}

// request starts the stream, or extends it, until ttl from now.
func (s *liveStreamer) request(intervalSeconds, ttlSeconds int, send func([]byte) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.until = s.now().Add(clampLiveTTL(ttlSeconds))
	s.interval = clampLiveInterval(intervalSeconds)
	s.send = send
	if !s.running {
		s.running = true
		log.Printf("[live] streaming every %s", s.interval)
		go s.loop()
	}
}

func (s *liveStreamer) stop() {
	s.mu.Lock()
	s.until = time.Time{}
	s.mu.Unlock()
}

func (s *liveStreamer) active() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

func (s *liveStreamer) loop() {
	for {
		s.mu.Lock()
		if !s.now().Before(s.until) {
			s.running = false
			s.mu.Unlock()
			log.Printf("[live] stopped")
			return
		}
		interval, send := s.interval, s.send
		s.mu.Unlock()

		data, err := json.Marshal(liveMessage{Type: "live", Data: s.sample()})
		if err == nil && send != nil {
			if err := send(data); err != nil {
				// The connection is gone; serveCommandChannel stops us too.
				s.stop()
			}
		}
		s.sleep(interval)
	}
}

// ── sampler ──────────────────────────────────────────────────────────────

type procSample struct {
	cpuSeconds float64
	name       string
}

type liveSampler struct {
	lastCPU    *cpu.TimesStat
	lastNetRx  uint64
	lastNetTx  uint64
	lastNetAt  time.Time
	lastProcs  map[int32]procSample
	lastProcAt time.Time
	disks      []string
	disksAt    time.Time
}

func newLiveSampler() *liveSampler {
	return &liveSampler{lastProcs: map[int32]procSample{}}
}

func cpuBusyTotal(t cpu.TimesStat) (busy, total float64) {
	total = t.User + t.System + t.Idle + t.Nice + t.Iowait + t.Irq + t.Softirq + t.Steal
	return total - t.Idle - t.Iowait, total
}

func (s *liveSampler) cpuPercent() *float64 {
	times, err := cpu.Times(false)
	if err != nil || len(times) == 0 {
		return nil
	}
	current := times[0]
	if s.lastCPU == nil {
		// First sample of a stream: measure over a short window now rather
		// than send nothing.
		s.lastCPU = &current
		time.Sleep(250 * time.Millisecond)
		if times, err = cpu.Times(false); err != nil || len(times) == 0 {
			return nil
		}
		current = times[0]
	}
	busy0, total0 := cpuBusyTotal(*s.lastCPU)
	busy1, total1 := cpuBusyTotal(current)
	s.lastCPU = &current
	if total1 <= total0 {
		return nil
	}
	pct := clampPercent((busy1 - busy0) / (total1 - total0) * 100)
	return &pct
}

func clampPercent(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

func round1(v float64) float64 {
	return float64(int64(v*10+0.5)) / 10
}

func (s *liveSampler) network(now time.Time) (rx, tx *float64) {
	counters, err := gopsnet.IOCounters(false)
	if err != nil || len(counters) == 0 {
		return nil, nil
	}
	c := counters[0]
	defer func() { s.lastNetRx, s.lastNetTx, s.lastNetAt = c.BytesRecv, c.BytesSent, now }()
	if s.lastNetAt.IsZero() || c.BytesRecv < s.lastNetRx || c.BytesSent < s.lastNetTx {
		return nil, nil
	}
	secs := now.Sub(s.lastNetAt).Seconds()
	if secs <= 0 {
		return nil, nil
	}
	r := round1(float64(c.BytesRecv-s.lastNetRx) * 8 / 1000 / secs)
	t := round1(float64(c.BytesSent-s.lastNetTx) * 8 / 1000 / secs)
	return &r, &t
}

func (s *liveSampler) diskList(now time.Time) []string {
	if s.disks == nil || now.Sub(s.disksAt) >= liveDiskListEvery {
		s.disks = liveDiskMounts()
		s.disksAt = now
	}
	return s.disks
}

func (s *liveSampler) processes(now time.Time) (int, []liveProcess) {
	pids, err := gopsprocess.Pids()
	if err != nil {
		return 0, nil
	}
	elapsed := now.Sub(s.lastProcAt).Seconds()
	cpus := float64(runtime.NumCPU())
	current := make(map[int32]procSample, len(pids))
	out := make([]liveProcess, 0, len(pids))
	for _, pid := range pids {
		if pid == 0 {
			continue
		}
		p := &gopsprocess.Process{Pid: pid}
		times, err := p.Times()
		if err != nil {
			continue
		}
		sample := procSample{cpuSeconds: times.User + times.System}
		if prev, ok := s.lastProcs[pid]; ok && prev.name != "" {
			sample.name = prev.name
		} else if name, err := p.Name(); err == nil {
			sample.name = name
		}
		current[pid] = sample
		if sample.name == "" {
			continue
		}
		entry := liveProcess{PID: pid, Name: sample.name}
		if prev, ok := s.lastProcs[pid]; ok && elapsed > 0 && sample.cpuSeconds >= prev.cpuSeconds {
			entry.CPUPercent = round1(clampPercent((sample.cpuSeconds - prev.cpuSeconds) / elapsed / cpus * 100))
		}
		if memInfo, err := p.MemoryInfo(); err == nil && memInfo != nil {
			entry.MemoryMB = round1(float64(memInfo.RSS) / (1024 * 1024))
		}
		out = append(out, entry)
	}
	s.lastProcs = current
	s.lastProcAt = now
	return len(out), topLiveProcesses(out, liveTopProcesses)
}

// topLiveProcesses keeps the busiest processes, by CPU and then memory.
func topLiveProcesses(all []liveProcess, n int) []liveProcess {
	sort.Slice(all, func(i, j int) bool {
		if all[i].CPUPercent != all[j].CPUPercent {
			return all[i].CPUPercent > all[j].CPUPercent
		}
		return all[i].MemoryMB > all[j].MemoryMB
	})
	if len(all) > n {
		all = all[:n]
	}
	return all
}

func (s *liveSampler) sample() liveSnapshot {
	now := time.Now()
	snap := liveSnapshot{At: now.UnixMilli(), Disks: []liveDisk{}, Processes: []liveProcess{}}
	snap.CPUPercent = s.cpuPercent()
	if vm, err := mem.VirtualMemory(); err == nil {
		pct := round1(vm.UsedPercent)
		snap.RAMPercent = &pct
		snap.RAMUsedMB = round1(float64(vm.Used) / (1024 * 1024))
		snap.RAMTotalMB = round1(float64(vm.Total) / (1024 * 1024))
	}
	for _, mount := range s.diskList(now) {
		if d, ok := liveDiskUsage(mount); ok {
			snap.Disks = append(snap.Disks, d)
		}
	}
	snap.NetRxKbps, snap.NetTxKbps = s.network(now)
	if up, err := host.Uptime(); err == nil {
		snap.UptimeSeconds = up
	}
	session := buildUserSession()
	if session.UserSource != "no_interactive_user" && session.UserSource != "registry_last_logon" {
		snap.CurrentUser = session.CurrentUser
		snap.UserSessionState = session.UserSessionState
	}
	snap.ProcessCount, snap.Processes = s.processes(now)
	return snap
}
