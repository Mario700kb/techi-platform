//go:build !linux

package main

import "context"

// The agent command channel is Linux-only by decision, not by limitation
// (owner instruction, 2026-08-04: Windows is healthy on the heartbeat path and
// must not be touched). This no-op keeps runAgent platform-independent — the
// call site does not need a build tag — and guarantees no other platform links
// the websocket client or opens a persistent connection.
//
// Windows also cannot use what the channel accelerates: handleOpenTerminal is
// a stub there (actions_windows.go) that reports "not supported on Windows".
func runCommandChannel(_ context.Context, _ *Config) {}
