//go:build linux

package main

import "time"

const systemctlTimeout = 10 * time.Second

// stoppedWatchedServices asks systemd, which the installer requires, about the
// watched services. "Automatic" on Linux means enabled to start at boot.
func stoppedWatchedServices(target string) ([]string, bool) {
	patterns := parseServicePatterns(target)
	if len(patterns) == 0 {
		return nil, false
	}
	text, ok := runLinuxTool(systemctlTimeout, "systemctl", "list-units", "--type=service", "--all", "--plain", "--no-legend", "--no-pager")
	if !ok {
		return nil, false
	}
	enabled := serviceStartTypes.get(time.Now(), func() map[string]bool {
		out, ok := runLinuxTool(systemctlTimeout, "systemctl", "list-unit-files", "--type=service", "--state=enabled", "--no-legend", "--no-pager")
		if !ok {
			return nil
		}
		return parseEnabledUnits(out)
	})
	return watchedStopped(patterns, mergeServiceStates(parseSystemdUnits(text), enabled))
}
