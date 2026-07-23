//go:build !windows

package main

import "errors"

// Non-Windows stubs. rustDeskWindowsStatus is only reached on Windows (see
// discoverRustDesk); these exist so the shared discovery/classification code in
// rustdesk.go stays cross-platform and unit-testable off Windows.

func remoteSupportServiceState() (string, error) {
	return "", errors.New("Windows Service Control Manager unavailable on this platform")
}

func legacyRemoteSupportServiceRunning() bool { return false }

func collectRemoteSupportProcessSignals() remoteSupportProcessSignals {
	return remoteSupportProcessSignals{}
}

func removeManagedTrayArtifacts() trayArtifactRemoval { return trayArtifactRemoval{} }

func stopRemoteSupportTrayProcesses() int { return 0 }
