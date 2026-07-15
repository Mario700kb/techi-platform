//go:build !windows

package main

import "techi-platform/agent/internal/native"

func executeNativeRemoteSupport(
	_ *native.Policy, _, _, _, _ string, asJSON bool,
) int {
	r := native.NewResult("repair-remote-support", native.ExitBadArgs)
	r.Component = "remote_support"
	r.Message = "live Remote Support recovery is Windows-only"
	return emitResult(r, asJSON)
}
