//go:build windows

package main

import "sync/atomic"

var windowsServiceRuntime atomic.Bool

func markWindowsServiceRuntime() {
	windowsServiceRuntime.Store(true)
}

func canWriteOperationalLifecycle() bool {
	return windowsServiceRuntime.Load()
}
