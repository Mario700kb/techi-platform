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

func runInstallerMarkerCommand(_ []string) int {
	fmt.Println("installer-marker is only supported on Windows")
	return 1
}

func runInstallerEnsureServiceCommand() int {
	fmt.Println("installer-ensure-service is only supported on Windows")
	return 1
}

func runInstallerStartServiceCommand() int {
	fmt.Println("installer-start-service is only supported on Windows")
	return 1
}
