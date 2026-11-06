//go:build linux

package main

import (
	"context"
	"log"
	"os/exec"
	"time"
)

const (
	nvidiaTimeout = 3 * time.Second
	gpuProbeEvery = time.Hour // a driver loaded later is noticed without a restart
)

type gpuSampler struct {
	gpuGuard
	drm       drmSampler
	nvidia    string
	nextProbe time.Time
	found     bool
	logged    bool
}

func (g *gpuSampler) sample() gpuReading { return g.run(g.read) }

func (g *gpuSampler) read() gpuReading {
	now := time.Now()
	if g.drm.root == "" {
		g.drm.root = "/"
	}
	if !g.found && !now.Before(g.nextProbe) {
		g.nextProbe = now.Add(gpuProbeEvery)
		g.nvidia = nvidiaSMIPath()
		g.found = g.nvidia != "" || len(g.drm.cards()) > 0
	}
	if !g.found {
		return gpuReading{} // no real GPU: nothing is walked or started
	}
	started := now
	var reading gpuReading
	if g.nvidia != "" {
		reading = readNvidia(g.nvidia)
	} else {
		reading = g.drm.sample(now)
	}
	if !g.logged && reading.busy != nil {
		g.logged = true
		log.Printf("[telemetry] GPU read in %d ms", time.Since(started).Milliseconds())
	}
	return reading
}

func nvidiaSMIPath() string {
	if path, err := exec.LookPath("nvidia-smi"); err == nil {
		return path
	}
	return ""
}

func runNvidia(path string, args ...string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), nvidiaTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, args...).Output()
	return string(out), err == nil
}

func readNvidia(path string) gpuReading {
	out, ok := runNvidia(path, "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits")
	if !ok {
		return gpuReading{}
	}
	busy, memory, parsed := parseNvidiaGPUs(out)
	if !parsed {
		return gpuReading{}
	}
	reading := gpuReading{busy: &busy, memMB: &memory}
	if procs, ok := runNvidia(path, "pmon", "-c", "1", "-s", "u"); ok {
		reading.byPID = parseNvidiaProcesses(procs)
	}
	return reading
}
