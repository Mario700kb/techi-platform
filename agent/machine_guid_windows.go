//go:build windows

package main

import (
	"strings"
	"sync"

	"golang.org/x/sys/windows/registry"
)

var machineGUIDOnce struct {
	once  sync.Once
	value string
}

// machineGUID is HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid, the
// value TECHI Remote Support sends (base64) as its uuid: the platform uses it
// to tie the client's own ID report to this device.
func machineGUID() string {
	machineGUIDOnce.once.Do(func() {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Cryptography`,
			registry.QUERY_VALUE|registry.WOW64_64KEY)
		if err != nil {
			return
		}
		defer k.Close()
		value, _, err := k.GetStringValue("MachineGuid")
		if err != nil {
			return
		}
		machineGUIDOnce.value = strings.ToLower(strings.Trim(strings.TrimSpace(value), "{}"))
	})
	return machineGUIDOnce.value
}
