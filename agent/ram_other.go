//go:build !windows

package main

// installedRAMBytes: only Windows tells installed from usable memory.
func installedRAMBytes() uint64 { return 0 }
