//go:build !windows && !linux

package main

// Service monitors watch Windows services and systemd units; elsewhere nothing is watched.
func stoppedWatchedServices(string) ([]string, bool) { return nil, false }
