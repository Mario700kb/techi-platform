//go:build !windows

package main

import "fmt"

func runBootstrapConfigCommand(_ []string) int {
	fmt.Println("bootstrap-config is only supported on Windows")
	return 1
}

func runRSTrayTaskCommand() int {
	fmt.Println("rs-tray-task is only supported on Windows")
	return 1
}

func runInstallerHealthCheckCommand() int {
	fmt.Println("installer-health-check is only supported on Windows")
	return 1
}
