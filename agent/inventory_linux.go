//go:build linux

package main

import (
	"os/user"
	"runtime"
)

// collectOSInfo reports the Linux distribution as OSName/OSVersion/OSCaption
// from /etc/os-release, with the kernel as OSBuild. WindowsProductType stays 0
// (the backend's Linux adapter classifies server vs desktop from these fields).
func collectOSInfo() OSInfo {
	name := osReleaseField("NAME")
	if name == "" {
		name = "Linux"
	}
	version := osReleaseField("VERSION_ID")
	if version == "" {
		version = runtime.GOARCH
	}
	caption := osReleaseField("PRETTY_NAME")
	if caption == "" {
		caption = name
	}
	return OSInfo{
		Name:    name,
		Version: version,
		Caption: caption,
		Build:   linuxKernelVersion(),
	}
}

func buildUserSession() UserSession {
	name := ""
	if u, err := user.Current(); err == nil {
		name = u.Username
	}
	return UserSession{
		CurrentUser:      name,
		UserSource:       "fallback",
		UserSessionState: "unknown",
	}
}
