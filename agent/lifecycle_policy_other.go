//go:build !windows

package main

func markWindowsServiceRuntime() {}

func canWriteOperationalLifecycle() bool {
	return true
}
