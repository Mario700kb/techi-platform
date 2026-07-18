//go:build !windows

package main

import "strings"

func classifyRustDeskWindowsState(installStatus, runtimeStatus, _, _ string) (string, string) {
	return installStatus, runtimeStatus
}

func sameWindowsExecutable(left, right string) bool {
	return strings.TrimSpace(left) == strings.TrimSpace(right)
}
