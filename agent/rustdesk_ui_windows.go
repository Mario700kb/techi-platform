//go:build windows

package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const rustDeskUILaunchTaskName = "TECHI Remote Support UI Launch"

var (
	errRustDeskUILaunchFailed = errors.New(rustDeskStatusUILaunchFailed)

	user32ForRustDeskUI       = windows.NewLazySystemDLL("user32.dll")
	procRustDeskGetWindowRect = user32ForRustDeskUI.NewProc("GetWindowRect")
	procRustDeskShowWindow    = user32ForRustDeskUI.NewProc("ShowWindow")
	procRustDeskSetForeground = user32ForRustDeskUI.NewProc("SetForegroundWindow")
)

func rustDeskWindowsStatusForInstallPath(installPath string) string {
	pids, _ := exactImagePIDs(rustDeskApprovedUIPaths(installPath)...)
	hasMainWindow := false
	if len(pids) > 0 {
		_, hasMainWindow = rustDeskMainWindow(pids)
	}

	primaryServiceStatus := rustDeskPrimaryServiceStatus()
	legacyServiceRunning := rustDeskLegacyServiceRunning()
	return classifyRustDeskUIRuntime(hasMainWindow, len(pids), primaryServiceStatus, legacyServiceRunning)
}

func rustDeskApprovedUIPaths(installPath string) []string {
	seen := map[string]bool{}
	paths := []string{}
	for _, path := range []string{installPath, rustdeskDefaultInstallPath, rustdeskLegacyExePath} {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		key := strings.ToLower(filepath.Clean(path))
		if seen[key] {
			continue
		}
		seen[key] = true
		paths = append(paths, path)
	}
	return paths
}

func rustDeskPrimaryServiceStatus() string {
	output, err := exec.Command(scPath(), "query", rustdeskServiceName).Output()
	if err != nil {
		return ""
	}
	lower := strings.ToLower(string(output))
	if strings.Contains(lower, "running") {
		return "running"
	}
	if strings.Contains(lower, "stopped") {
		return "stopped"
	}
	return ""
}

func rustDeskLegacyServiceRunning() bool {
	for _, svc := range []string{"RustDesk", "rustdesk"} {
		output, err := exec.Command(scPath(), "query", svc).Output()
		if err == nil && strings.Contains(strings.ToLower(string(output)), "running") {
			return true
		}
	}
	return false
}

func openRustDeskDesktopUI(installPath string) error {
	installPath = strings.TrimSpace(installPath)
	if installPath == "" {
		installPath = rustdeskDefaultInstallPath
	}
	if _, err := os.Stat(installPath); err != nil {
		return fmt.Errorf("remote support executable unavailable: %w", err)
	}

	if restoreRustDeskMainWindow(installPath) {
		return nil
	}
	if err := runRustDeskUILaunchTask(installPath); err != nil {
		return fmt.Errorf("%w: %v", errRustDeskUILaunchFailed, err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if restoreRustDeskMainWindow(installPath) {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return errRustDeskUILaunchFailed
}

func restoreRustDeskMainWindow(installPath string) bool {
	pids, err := exactImagePIDs(rustDeskApprovedUIPaths(installPath)...)
	if err != nil || len(pids) == 0 {
		return false
	}
	hwnd, ok := rustDeskMainWindow(pids)
	if !ok {
		return false
	}
	_, _, _ = procRustDeskShowWindow.Call(uintptr(hwnd), uintptr(windows.SW_RESTORE))
	_, _, _ = procRustDeskSetForeground.Call(uintptr(hwnd))
	return true
}

func rustDeskMainWindow(pids []uint32) (windows.HWND, bool) {
	owned := map[uint32]bool{}
	for _, pid := range pids {
		owned[pid] = true
	}

	var found windows.HWND
	callback := windows.NewCallback(func(hwnd windows.HWND, _ uintptr) uintptr {
		if !windows.IsWindowVisible(hwnd) {
			return 1
		}
		var pid uint32
		windows.GetWindowThreadProcessId(hwnd, &pid)
		if !owned[pid] {
			return 1
		}
		width, height, ok := rustDeskWindowSize(hwnd)
		if !ok || !rustDeskMainWindowSizeUsable(width, height) {
			return 1
		}
		found = hwnd
		return 0
	})
	_ = windows.EnumWindows(callback, nil)
	return found, found != 0
}

func rustDeskWindowSize(hwnd windows.HWND) (int32, int32, bool) {
	var rect windows.Rect
	ret, _, _ := procRustDeskGetWindowRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&rect)))
	if ret == 0 {
		return 0, 0, false
	}
	return rect.Right - rect.Left, rect.Bottom - rect.Top, true
}

func runRustDeskUILaunchTask(installPath string) error {
	xmlPath := filepath.Join(os.TempDir(), "techi-rs-ui-launch-task.xml")
	if err := os.WriteFile(xmlPath, encodeUTF16LEWithBOM(rsUITaskXML(installPath)), 0600); err != nil {
		return err
	}
	defer os.Remove(xmlPath)

	if out, err := exec.Command(schtasksPath(), "/Create", "/TN", rustDeskUILaunchTaskName, "/XML", xmlPath, "/F").CombinedOutput(); err != nil {
		return fmt.Errorf("task create: %w: %s", err, strings.TrimSpace(string(out)))
	}
	defer deleteScheduledTask(rustDeskUILaunchTaskName)

	if out, err := exec.Command(schtasksPath(), "/Run", "/TN", rustDeskUILaunchTaskName).CombinedOutput(); err != nil {
		return fmt.Errorf("task run: %w: %s", err, strings.TrimSpace(string(out)))
	}
	log.Printf("[rustdesk_ui] desktop UI launch task triggered")
	return nil
}

func rsUITaskXML(rsExe string) string {
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals>
    <Principal id="Author">
      <GroupId>S-1-5-32-545</GroupId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>` + xmlEscape(rsExe) + `</Command>
    </Exec>
  </Actions>
</Task>
`
}
