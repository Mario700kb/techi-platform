//go:build linux

package main

import (
	"context"
	"os/exec"
	"time"
)

// runLinuxTool runs a standard system tool with a time limit. A missing tool or
// a failure is ok=false: that reading stays unknown.
func runLinuxTool(timeout time.Duration, name string, args ...string) (string, bool) {
	path, err := exec.LookPath(name)
	if err != nil {
		return "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, args...).Output()
	return string(out), err == nil
}

// runLinuxToolOutput keeps the output of a tool whose exit code carries meaning:
// smartctl and needs-restarting report their finding through it.
func runLinuxToolOutput(timeout time.Duration, name string, args ...string) ([]byte, bool) {
	path, err := exec.LookPath(name)
	if err != nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, args...).Output()
	return out, err == nil
}
