//go:build !windows

package main

// Service monitors watch Windows services; elsewhere nothing is watched.
func stoppedWatchedServices(string) ([]string, bool) { return nil, false }
