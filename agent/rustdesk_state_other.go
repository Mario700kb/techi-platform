//go:build !windows

package main

func classifyRustDeskWindowsState(installStatus, runtimeStatus, _ string) (string, string) {
	return installStatus, runtimeStatus
}
