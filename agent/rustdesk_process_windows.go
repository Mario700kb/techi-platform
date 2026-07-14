//go:build windows

package main

import (
	"fmt"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func processImagePath(handle windows.Handle) (string, error) {
	buffer := make([]uint16, windows.MAX_PATH)
	for {
		size := uint32(len(buffer))
		err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size)
		if err == nil {
			return windows.UTF16ToString(buffer[:size]), nil
		}
		if err == windows.ERROR_INSUFFICIENT_BUFFER && len(buffer) < 32768 {
			buffer = make([]uint16, len(buffer)*2)
			continue
		}
		return "", err
	}
}

func exactImagePIDs(approvedPaths ...string) ([]uint32, error) {
	approved := make(map[string]bool, len(approvedPaths))
	for _, path := range approvedPaths {
		approved[strings.ToLower(path)] = true
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snapshot)

	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	var pids []uint32
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		if entry.ProcessID == 0 {
			continue
		}
		handle, openErr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessID)
		if openErr != nil {
			continue
		}
		path, pathErr := processImagePath(handle)
		windows.CloseHandle(handle)
		if pathErr == nil && approved[strings.ToLower(path)] {
			pids = append(pids, entry.ProcessID)
		}
	}
	return pids, nil
}

func terminateExactImageProcesses(approvedPaths ...string) error {
	pids, err := exactImagePIDs(approvedPaths...)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(15 * time.Second)
	for _, pid := range pids {
		handle, openErr := windows.OpenProcess(
			windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE,
			false,
			pid,
		)
		if openErr != nil {
			return fmt.Errorf("open Remote Support pid %d: %w", pid, openErr)
		}
		path, pathErr := processImagePath(handle)
		approved := false
		for _, expected := range approvedPaths {
			approved = approved || (pathErr == nil && strings.EqualFold(path, expected))
		}
		if !approved {
			windows.CloseHandle(handle)
			continue
		}
		if err := windows.TerminateProcess(handle, 1); err != nil {
			windows.CloseHandle(handle)
			return fmt.Errorf("terminate Remote Support pid %d: %w", pid, err)
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			windows.CloseHandle(handle)
			return fmt.Errorf("Remote Support process termination deadline exceeded")
		}
		result, waitErr := windows.WaitForSingleObject(handle, uint32(remaining/time.Millisecond))
		windows.CloseHandle(handle)
		if waitErr != nil || result != windows.WAIT_OBJECT_0 {
			return fmt.Errorf("wait for Remote Support pid %d", pid)
		}
	}
	return nil
}
