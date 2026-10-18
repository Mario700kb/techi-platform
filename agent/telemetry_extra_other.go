//go:build !windows

package main

import "time"

// Disk counters and pings are read on Windows only; elsewhere the sample
// carries none of them.

func readDiskCounters(string) (diskCounters, bool) { return diskCounters{}, false }

func defaultGateway() string { return "" }

func pingHost(string, int, time.Duration) ([]float64, int) { return nil, 0 }
