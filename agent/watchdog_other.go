//go:build !windows

package main

func reconcileAgentServiceWatchdog(bool) {}
func ensureAgentServiceWatchdog()        {}
