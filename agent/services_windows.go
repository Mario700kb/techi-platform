//go:build windows

package main

import (
	"fmt"
	"sort"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// collectWindowsServicesNative uses the supported Service Control Manager
// API. It intentionally has no command-line fallback.
func collectWindowsServicesNative() ([]ServiceInfo, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()
	names, err := m.ListServices()
	if err != nil {
		return nil, fmt.Errorf("list SCM services: %w", err)
	}
	result := make([]ServiceInfo, 0, len(names))
	for _, name := range names {
		s, err := m.OpenService(name)
		if err != nil {
			continue
		}
		item := ServiceInfo{Name: name}
		if cfg, cfgErr := s.Config(); cfgErr == nil {
			item.DisplayName = cfg.DisplayName
			switch cfg.StartType {
			case windows.SERVICE_AUTO_START:
				item.StartupType = "automatic"
			case windows.SERVICE_DEMAND_START:
				item.StartupType = "manual"
			case windows.SERVICE_DISABLED:
				item.StartupType = "disabled"
			case windows.SERVICE_BOOT_START:
				item.StartupType = "boot"
			case windows.SERVICE_SYSTEM_START:
				item.StartupType = "system"
			}
		}
		if st, statusErr := s.Query(); statusErr == nil {
			item.Status = inventoryServiceStateName(st.State)
		}
		s.Close()
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool { return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name) })
	return result, nil
}

func inventoryServiceStateName(state svc.State) string {
	switch state {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "start_pending"
	case svc.StopPending:
		return "stop_pending"
	case svc.Running:
		return "running"
	case svc.ContinuePending:
		return "continue_pending"
	case svc.PausePending:
		return "pause_pending"
	case svc.Paused:
		return "paused"
	default:
		return "unknown"
	}
}
