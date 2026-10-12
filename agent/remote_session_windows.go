//go:build windows

package main

// currentRemoteSessionState reports whether a Remote Support session is live.
func currentRemoteSessionState() *bool {
	return remoteSessionReport(brandedRemoteSupportCmdlines())
}
