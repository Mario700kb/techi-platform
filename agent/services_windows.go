//go:build windows

package main

import (
	"log"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// collectWindowsServices lists the Win32 services from the Service Control
// Manager: the set `wmic service` used to return, which newer Windows 11
// builds no longer ship.
func collectWindowsServices() []ServiceInfo {
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT|windows.SC_MANAGER_ENUMERATE_SERVICE)
	if err != nil {
		log.Printf("services: open service manager failed: %v", err)
		return nil
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
			log.Printf("services: enumeration failed: %v", err)
			return nil
		}
		buf = make([]byte, needed)
	}
	if returned == 0 {
		return nil
	}

	entries := unsafe.Slice((*windows.ENUM_SERVICE_STATUS_PROCESS)(unsafe.Pointer(&buf[0])), int(returned))
	services := make([]ServiceInfo, 0, len(entries))
	for _, e := range entries {
		name := windows.UTF16PtrToString(e.ServiceName)
		services = append(services, ServiceInfo{
			Name:        name,
			DisplayName: windows.UTF16PtrToString(e.DisplayName),
			Status:      inventoryServiceState(e.ServiceStatusProcess.CurrentState),
			StartupType: serviceStartType(scm, name),
		})
	}
	return services
}

func serviceStartType(scm windows.Handle, name string) string {
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return ""
	}
	service, err := windows.OpenService(scm, namePtr, windows.SERVICE_QUERY_CONFIG)
	if err != nil {
		return ""
	}
	defer windows.CloseServiceHandle(service)

	var buf []byte
	var needed uint32
	for {
		var config *windows.QUERY_SERVICE_CONFIG
		if len(buf) > 0 {
			config = (*windows.QUERY_SERVICE_CONFIG)(unsafe.Pointer(&buf[0]))
		}
		err = windows.QueryServiceConfig(service, config, uint32(len(buf)), &needed)
		if err == nil {
			return inventoryServiceStartType(config.StartType)
		}
		if err != windows.ERROR_INSUFFICIENT_BUFFER || needed <= uint32(len(buf)) {
			return ""
		}
		buf = make([]byte, needed)
	}
}
