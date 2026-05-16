//go:build !windows

package main

import "fmt"

func isServiceCommand(command string) bool {
	switch command {
	case "install", "uninstall", "start", "stop", "status":
		return true
	default:
		return false
	}
}

func runServiceCommand(command string, _ string, _ string) error {
	return fmt.Errorf("%q is only supported on Windows", command)
}

func runWindowsService(_ string, _ string) (bool, error) {
	return false, nil
}
