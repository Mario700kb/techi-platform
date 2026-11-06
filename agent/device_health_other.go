//go:build !windows && !linux

package main

// The device health report is read on Windows and Linux.
func deviceHealthCollector() func() *DeviceHealth { return nil }
