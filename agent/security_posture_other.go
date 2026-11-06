//go:build !windows && !linux

package main

// securityPostureCollector is nil elsewhere: the part is never collected and
// the heartbeat carries no security_posture.
func securityPostureCollector() func() *SecurityPosture { return nil }
