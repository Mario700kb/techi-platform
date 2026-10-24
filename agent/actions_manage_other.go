//go:build !windows

package main

import (
	"context"
	"fmt"
)

// Ending a process, controlling a service and uninstalling an app from the
// console are Windows actions (actions_manage_windows.go).

func handleKillProcess(_ context.Context, _ *Config, _ map[string]interface{}) actionResult {
	return windowsOnlyAction("kill_process")
}

func handleServiceControl(_ context.Context, _ *Config, _ map[string]interface{}) actionResult {
	return windowsOnlyAction("service_control")
}

func handleUninstallSoftware(_ context.Context, _ *Config, _ map[string]interface{}) actionResult {
	return windowsOnlyAction("uninstall_software")
}

func windowsOnlyAction(action string) actionResult {
	return actionResult{err: fmt.Errorf("%s: supported on Windows only", action)}
}
