//go:build !windows

package main

import "os/user"

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
