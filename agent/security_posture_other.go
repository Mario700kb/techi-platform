//go:build !windows

package main

// securityPostureCollector is nil off Windows: the part is never collected
// and the heartbeat carries no security_posture.
func securityPostureCollector() func() *SecurityPosture { return nil }
