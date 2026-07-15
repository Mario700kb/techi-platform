//go:build !windows

package main

func rustDeskWindowsStatusForInstallPath(_ string) string {
	return "not_running"
}
