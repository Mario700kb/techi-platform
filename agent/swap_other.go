//go:build !windows

package main

import "fmt"

func runBinarySwapCommand(_ []string) int {
	fmt.Println("swap-binary is only supported on Windows")
	return 1
}

func runWatchdogCheckCommand() int {
	fmt.Println("watchdog-check is only supported on Windows")
	return 1
}
