package main

// GPU use on Linux from what the kernel itself publishes, so nothing needs
// installing and the same code serves every distribution and architecture:
//
//   - /proc/<pid>/fdinfo of a process holding a /dev/dri device lists the time
//     it spent on each engine (kernel 5.17+ for amdgpu, 5.19+ for i915, 6.x for
//     v3d on the Raspberry Pi and others). Differences over the minute give the
//     load per engine and per process, the same figures as on Windows.
//   - amdgpu also publishes the load and its memory directly in sysfs, which
//     covers an older kernel or a machine with no client open.
//
// What the kernel does not publish stays absent: null on the platform, never 0.
// The file reads no platform API, so its tests run anywhere from a fixture tree.

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Real GPUs. A server's display chip or a VM's virtual adapter (ast, mgag200,
// cirrus, bochs, virtio_gpu, vmwgfx, simpledrm, ...) has no load worth a chart,
// and leaving it out spares those machines the walk over /proc.
var gpuDrivers = map[string]bool{
	"amdgpu": true, "radeon": true, "i915": true, "xe": true, "nouveau": true,
	"v3d": true, "vc4": true, "panfrost": true, "panthor": true, "lima": true,
	"msm": true, "etnaviv": true, "tegra": true,
}

type drmClient struct {
	pdev     string
	id       string
	engines  map[string]uint64 // cumulative ns per engine
	capacity map[string]float64
	memBytes float64
}

// parseDRMFdinfo reads one fdinfo file; ok is false when it is not a DRM client.
func parseDRMFdinfo(text string) (drmClient, bool) {
	c := drmClient{engines: map[string]uint64{}, capacity: map[string]float64{}}
	var resident, memory float64
	for _, line := range strings.Split(text, "\n") {
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		value = strings.TrimSpace(value)
		switch {
		case key == "drm-pdev":
			c.pdev = value
		case key == "drm-client-id":
			c.id = value
		case strings.HasPrefix(key, "drm-engine-capacity-"):
			if n, err := strconv.ParseFloat(value, 64); err == nil && n > 0 {
				c.capacity[strings.TrimPrefix(key, "drm-engine-capacity-")] = n
			}
		case strings.HasPrefix(key, "drm-engine-"):
			if number, unit, _ := strings.Cut(value, " "); unit == "ns" {
				if n, err := strconv.ParseUint(number, 10, 64); err == nil {
					c.engines[strings.TrimPrefix(key, "drm-engine-")] = n
				}
			}
		case strings.HasPrefix(key, "drm-resident-"):
			resident += parseDRMBytes(value)
		case strings.HasPrefix(key, "drm-memory-"):
			memory += parseDRMBytes(value)
		}
	}
	if c.id == "" {
		return c, false
	}
	c.memBytes = resident
	if c.memBytes == 0 {
		c.memBytes = memory
	}
	return c, true
}

func parseDRMBytes(value string) float64 {
	number, unit, _ := strings.Cut(value, " ")
	n, err := strconv.ParseFloat(number, 64)
	if err != nil {
		return 0
	}
	switch unit {
	case "KiB":
		return n * 1024
	case "MiB":
		return n * 1024 * 1024
	case "GiB":
		return n * 1024 * 1024 * 1024
	}
	return n
}

type drmSampler struct {
	root   string // "/" in production, a fixture tree in tests
	last   map[string]uint64
	lastAt time.Time
}

func (d *drmSampler) path(parts ...string) string {
	return filepath.Join(append([]string{d.root}, parts...)...)
}

// cards lists the device folders of the machine's real GPUs.
func (d *drmSampler) cards() map[string]string {
	found := map[string]string{}
	matches, _ := filepath.Glob(d.path("sys", "class", "drm", "card*", "device", "driver"))
	for _, link := range matches {
		target, err := os.Readlink(link)
		if err != nil {
			continue
		}
		if driver := filepath.Base(target); gpuDrivers[driver] {
			found[filepath.Dir(link)] = driver
		}
	}
	return found
}

// clients finds every DRM client and the first process holding it: a client
// shared by several processes or descriptors counts once.
func (d *drmSampler) clients() map[int32]map[string]drmClient {
	out := map[int32]map[string]drmClient{}
	seen := map[string]bool{}
	entries, err := os.ReadDir(d.path("proc"))
	if err != nil {
		return out
	}
	for _, entry := range entries {
		pid, err := strconv.ParseInt(entry.Name(), 10, 32)
		if err != nil {
			continue
		}
		fds, err := os.ReadDir(d.path("proc", entry.Name(), "fd"))
		if err != nil {
			continue // the process ended, or is not ours to read
		}
		for _, fd := range fds {
			target, err := os.Readlink(d.path("proc", entry.Name(), "fd", fd.Name()))
			if err != nil || !strings.HasPrefix(target, "/dev/dri/") {
				continue
			}
			text, err := os.ReadFile(d.path("proc", entry.Name(), "fdinfo", fd.Name()))
			if err != nil {
				continue
			}
			client, ok := parseDRMFdinfo(string(text))
			if !ok || seen[client.pdev+"|"+client.id] {
				continue
			}
			seen[client.pdev+"|"+client.id] = true
			if out[int32(pid)] == nil {
				out[int32(pid)] = map[string]drmClient{}
			}
			out[int32(pid)][client.pdev+"|"+client.id] = client
		}
	}
	return out
}

func readSysfsNumber(path string) (float64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	n, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
	return n, err == nil
}

// sample returns the minute's reading. The first call only sets the baseline
// for the engine counters, as the first collect does on Windows.
func (d *drmSampler) sample(at time.Time) gpuReading {
	cards := d.cards()
	if len(cards) == 0 {
		return gpuReading{}
	}
	clients := d.clients()
	current := map[string]uint64{}
	engineLoad := map[string]float64{}
	byPID := map[int32]float64{}
	first := d.last == nil
	elapsed := float64(at.Sub(d.lastAt).Nanoseconds())
	var clientMemory float64
	for pid, held := range clients {
		for key, client := range held {
			clientMemory += client.memBytes
			for engine, ns := range client.engines {
				counter := key + "|" + engine
				current[counter] = ns
				if first || elapsed <= 0 {
					continue
				}
				// A client new since the last minute did all its work inside it.
				previous := d.last[counter]
				if ns < previous {
					continue
				}
				load := float64(ns-previous) / elapsed * 100
				if capacity := client.capacity[engine]; capacity > 1 {
					load /= capacity
				}
				engineLoad[client.pdev+"|"+engine] += load
				if load > byPID[pid] {
					byPID[pid] = load
				}
			}
		}
	}
	d.last, d.lastAt = current, at

	var reading gpuReading
	if len(engineLoad) > 0 {
		var busy float64
		for _, load := range engineLoad {
			if load > busy {
				busy = load
			}
		}
		busy = clampPercent(busy)
		reading.busy = &busy
		for pid, value := range byPID {
			byPID[pid] = clampPercent(value)
		}
		reading.byPID = byPID
	}

	// amdgpu's own figures: its memory, and its load when no client shows one.
	var sysfsBusy, sysfsMemory float64
	var hasBusy, hasMemory bool
	for dir, driver := range cards {
		if driver != "amdgpu" {
			continue
		}
		if value, ok := readSysfsNumber(filepath.Join(dir, "gpu_busy_percent")); ok {
			hasBusy = true
			if value > sysfsBusy {
				sysfsBusy = value
			}
		}
		for _, name := range []string{"mem_info_vram_used", "mem_info_gtt_used"} {
			if value, ok := readSysfsNumber(filepath.Join(dir, name)); ok {
				hasMemory = true
				sysfsMemory += value
			}
		}
	}
	if reading.busy == nil && hasBusy {
		busy := clampPercent(sysfsBusy)
		reading.busy = &busy
	}
	if hasMemory {
		mb := float64(int64(sysfsMemory/(1024*1024) + 0.5))
		reading.memMB = &mb
	} else if clientMemory > 0 {
		mb := float64(int64(clientMemory/(1024*1024) + 0.5))
		reading.memMB = &mb
	}
	return reading
}

// ── NVIDIA ──────────────────────────────────────────────────────────────────
// Its proprietary driver publishes neither fdinfo nor sysfs load; nvidia-smi,
// which ships with the driver, is the supported way to ask.

// parseNvidiaGPUs reads "utilization.gpu, memory.used" lines, one per GPU.
func parseNvidiaGPUs(output string) (busy, memoryMB float64, ok bool) {
	for _, line := range strings.Split(output, "\n") {
		load, memory, found := strings.Cut(line, ",")
		if !found {
			continue
		}
		l, err1 := strconv.ParseFloat(strings.TrimSpace(load), 64)
		m, err2 := strconv.ParseFloat(strings.TrimSpace(memory), 64)
		if err1 != nil || err2 != nil {
			continue // "[N/A]" on a GPU that does not report it
		}
		ok = true
		memoryMB += m
		if l > busy {
			busy = l
		}
	}
	return clampPercent(busy), memoryMB, ok
}

// parseNvidiaProcesses reads `nvidia-smi pmon -s u`: gpu pid type sm mem enc dec ...
// A process's figure is its busiest engine.
func parseNvidiaProcesses(output string) map[int32]float64 {
	out := map[int32]float64{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 7 || strings.HasPrefix(fields[0], "#") {
			continue
		}
		pid, err := strconv.ParseInt(fields[1], 10, 32)
		if err != nil {
			continue
		}
		for _, field := range []string{fields[3], fields[5], fields[6]} { // sm, enc, dec
			if value, err := strconv.ParseFloat(field, 64); err == nil && value > out[int32(pid)] {
				out[int32(pid)] = clampPercent(value)
			}
		}
	}
	return out
}
