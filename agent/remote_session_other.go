//go:build !windows

package main

// currentRemoteSessionState: Remote Support sessions are tracked on Windows
// only; elsewhere the heartbeat leaves the field out.
func currentRemoteSessionState() *bool {
	return nil
}
