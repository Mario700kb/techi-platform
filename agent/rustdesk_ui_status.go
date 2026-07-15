package main

const (
	rustDeskStatusRunning        = "running"
	rustDeskStatusTrayOnly       = "tray_only"
	rustDeskStatusUILaunchFailed = "ui_launch_failed"
)

func rustDeskMainWindowSizeUsable(width, height int32) bool {
	return width >= 200 && height >= 120
}

func classifyRustDeskUIRuntime(hasMainWindow bool, processCount int, primaryServiceStatus string, legacyServiceRunning bool) string {
	if hasMainWindow {
		return rustDeskStatusRunning
	}
	if processCount > 0 || primaryServiceStatus == "running" || legacyServiceRunning {
		return rustDeskStatusTrayOnly
	}
	if primaryServiceStatus == "stopped" {
		return "stopped"
	}
	return "not_running"
}
