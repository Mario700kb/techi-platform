package main

// GPU use (2.1.48), the same figures on Windows and Linux, read the way Task
// Manager reads them: each process's share of each engine (3D, video decode,
// copy, ...). An engine's load is the sum over its processes, and the GPU's is
// its busiest engine, so a machine decoding video at 90% on the decode engine
// shows 90%, not an average diluted by idle engines. A process's figure is its
// busiest engine. Linux: telemetry_gpu_drm.go.
//
// A machine without the counters sends nothing: null on the platform, never 0.

import (
	"log"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const (
	// topBusyGPU makes a minute "busy" for the top processes, as CPU and memory do.
	topBusyGPU = 15.0
	// A read that hangs turns GPU sampling off until the agent restarts, so it
	// can never hold up the rest of the sample: telemetry matters more.
	gpuReadTimeout = 5 * time.Second
)

// gpuGuard runs a platform's read with that time limit.
type gpuGuard struct {
	off atomic.Bool
}

func (g *gpuGuard) run(read func() gpuReading) gpuReading {
	if g.off.Load() {
		return gpuReading{}
	}
	done := make(chan gpuReading, 1)
	go func() { done <- read() }()
	select {
	case reading := <-done:
		return reading
	case <-time.After(gpuReadTimeout):
		g.off.Store(true)
		log.Printf("[telemetry] GPU read took over %s; GPU sampling off until restart", gpuReadTimeout)
		return gpuReading{}
	}
}

type gpuReading struct {
	busy  *float64
	memMB *float64
	byPID map[int32]float64
}

// parseGPUEngine splits an instance name such as
// "pid_1234_luid_0x0_0xC5D7_phys_0_eng_3_engtype_VideoDecode" into its process
// and the engine it ran on (the same text for every process on that engine).
func parseGPUEngine(instance string) (pid int32, engine string, ok bool) {
	const prefix, marker, typeMark = "pid_", "_luid_", "_engtype_"
	if !strings.HasPrefix(instance, prefix) {
		return 0, "", false
	}
	at := strings.Index(instance, marker)
	end := strings.LastIndex(instance, typeMark)
	if at <= len(prefix) || end <= at {
		return 0, "", false
	}
	n, err := strconv.ParseInt(instance[len(prefix):at], 10, 32)
	if err != nil {
		return 0, "", false
	}
	return int32(n), instance[at+1 : end], true
}

// summarizeGPU turns per-instance utilization into the GPU's load and each
// process's, both 0-100. ok is false when no instance could be read.
func summarizeGPU(instances map[string]float64) (busy float64, byPID map[int32]float64, ok bool) {
	engines := map[string]float64{}
	byPID = map[int32]float64{}
	for instance, value := range instances {
		pid, engine, parsed := parseGPUEngine(instance)
		if !parsed {
			continue
		}
		ok = true
		engines[engine] += value
		if value > byPID[pid] {
			byPID[pid] = value
		}
	}
	for _, load := range engines {
		if load > busy {
			busy = load
		}
	}
	for pid, value := range byPID {
		byPID[pid] = clampPercent(value)
	}
	return clampPercent(busy), byPID, ok
}
