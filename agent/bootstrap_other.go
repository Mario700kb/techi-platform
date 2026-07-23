//go:build !windows

package main

import "fmt"

func runBootstrapConfigCommand(_ []string) int {
	fmt.Println("bootstrap-config is only supported on Windows")
	return 1
}

func runRemoveTrayArtifactsCommand() int {
	fmt.Println("remove-tray-artifacts is only supported on Windows")
	return 1
}

func runStopRemoteSupportRuntimeCommand() int {
	fmt.Println("stop-remote-support-runtime is only supported on Windows")
	return 1
}
