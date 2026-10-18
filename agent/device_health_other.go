//go:build !windows

package main

// The device health report is read on Windows only.
func deviceHealthCollector() func() *DeviceHealth { return nil }
