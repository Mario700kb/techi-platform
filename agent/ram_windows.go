//go:build windows

package main

import "unsafe"

var procGetPhysicallyInstalledSystemMemory = modKernel32.NewProc("GetPhysicallyInstalledSystemMemory")

// installedRAMBytes is the RAM fitted in the machine, as Windows shows it under
// System > About ("Installed RAM 4.00 GB"), read from the firmware tables.
// 0 when Windows cannot tell (some virtual machines).
func installedRAMBytes() uint64 {
	var kb uint64
	if ok, _, _ := procGetPhysicallyInstalledSystemMemory.Call(uintptr(unsafe.Pointer(&kb))); ok == 0 {
		return 0
	}
	return kb * 1024
}
