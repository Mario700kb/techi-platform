//go:build windows

package native

import "fmt"

// LaunchRemoteSupportUI reuses the native interactive-session probe without
// exposing the Windows executor's other recovery mutations.
func LaunchRemoteSupportUI(exe string) (string, string, error) {
	executor := &windowsExecutor{}
	if _, err := executor.StartUI(ExecuteParams{ExpectedExePath: exe}); err != nil {
		return executor.uiStatus, executor.uiDiagnostic, err
	}
	if executor.uiStatus == remoteSupportUILaunchFailedStatus {
		return executor.uiStatus, executor.uiDiagnostic, fmt.Errorf("%s", executor.uiDiagnostic)
	}
	return executor.uiStatus, executor.uiDiagnostic, nil
}
