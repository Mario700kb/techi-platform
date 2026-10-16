//go:build !linux && !windows

package main

import "context"

// The agent command channel runs on Linux and Windows (command_channel.go).
// This no-op keeps runAgent platform-independent — the call site does not
// need a build tag — and guarantees no other platform (macOS) links the
// websocket client or opens a persistent connection.
func runCommandChannel(_ context.Context, _ string) {}
