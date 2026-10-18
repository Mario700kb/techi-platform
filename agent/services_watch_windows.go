//go:build windows

package main

import (
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// stoppedWatchedServices reads every Win32 service's state in one call and
// reports the watched automatic ones that are stopped.
func stoppedWatchedServices(target string) ([]string, bool) {
	patterns := parseServicePatterns(target)
	if len(patterns) == 0 {
		return nil, false
	}
	states, ok := enumerateServiceStates()
	if !ok {
		return nil, false
	}
	automatic := serviceStartTypes.get(time.Now(), readAutomaticServices)
	services := make([]serviceState, 0, len(states))
	for name, state := range states {
		services = append(services, serviceState{
			name:      name,
			stopped:   state == windows.SERVICE_STOPPED,
			automatic: automatic[strings.ToLower(name)],
		})
	}
	return watchedStopped(patterns, services)
}

// enumerateServiceStates maps each Win32 service name to its current state.
func enumerateServiceStates() (map[string]uint32, bool) {
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT|windows.SC_MANAGER_ENUMERATE_SERVICE)
	if err != nil {
		return nil, false
	}
	defer windows.CloseServiceHandle(scm)
	var buf []byte
	var needed, returned uint32
	for {
		var p *byte
		if len(buf) > 0 {
			p = &buf[0]
		}
		err = windows.EnumServicesStatusEx(scm, windows.SC_ENUM_PROCESS_INFO, windows.SERVICE_WIN32,
			windows.SERVICE_STATE_ALL, p, uint32(len(buf)), &needed, &returned, nil, nil)
		if err == nil {
			break
		}
		if err != syscall.ERROR_MORE_DATA || needed <= uint32(len(buf)) {
			return nil, false
		}
		buf = make([]byte, needed)
	}
	out := make(map[string]uint32, returned)
	if returned == 0 {
		return out, true
	}
	entries := unsafe.Slice((*windows.ENUM_SERVICE_STATUS_PROCESS)(unsafe.Pointer(&buf[0])), int(returned))
	for _, e := range entries {
		out[windows.UTF16PtrToString(e.ServiceName)] = e.ServiceStatusProcess.CurrentState
	}
	return out, true
}

// readAutomaticServices: the lower-case names of the services whose start
// type is automatic (delayed start included).
func readAutomaticServices() map[string]bool {
	states, ok := enumerateServiceStates()
	if !ok {
		return nil
	}
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return nil
	}
	defer windows.CloseServiceHandle(scm)
	out := make(map[string]bool, len(states))
	for name := range states {
		if serviceStartType(scm, name) == "automatic" {
			out[strings.ToLower(name)] = true
		}
	}
	return out
}
