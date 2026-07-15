//go:build windows

package native

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	remoteSupportUser32              = windows.NewLazySystemDLL("user32.dll")
	remoteSupportGetWindowRect       = remoteSupportUser32.NewProc("GetWindowRect")
	remoteSupportShowWindow          = remoteSupportUser32.NewProc("ShowWindow")
	remoteSupportSetForegroundWindow = remoteSupportUser32.NewProc("SetForegroundWindow")
)

func (*windowsExecutor) StartUI(p ExecuteParams) (UndoFunc, error) {
	if err := ensureSafeExe(p.ExpectedExePath); err != nil {
		return nil, err
	}
	if restoreRemoteSupportMainWindow(p.ExpectedExePath) {
		return nil, nil
	}
	xmlPath := filepath.Join(p.BackupRoot, "remote-support-ui-launch.xml")
	if err := os.WriteFile(xmlPath, encodeUTF16LEWithBOMRemoteSupport(remoteSupportUITaskXML(p.ExpectedExePath)), 0o600); err != nil {
		return nil, err
	}
	defer os.Remove(xmlPath)
	schtasks := system32("schtasks.exe")
	if err := runHidden(schtasks, "/Create", "/TN", remoteSupportUILaunchTaskName, "/XML", xmlPath, "/F"); err != nil {
		return nil, err
	}
	defer runHidden(schtasks, "/Delete", "/F", "/TN", remoteSupportUILaunchTaskName)
	if err := runHidden(schtasks, "/Run", "/TN", remoteSupportUILaunchTaskName); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if restoreRemoteSupportMainWindow(p.ExpectedExePath) {
			return nil, nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return nil, fmt.Errorf("Remote Support UI launch produced no usable main window")
}

func remoteSupportMainWindowAvailable(exe string) bool {
	pids, err := pidsForExactImage(exe)
	if err != nil || len(pids) == 0 {
		return false
	}
	_, ok := remoteSupportMainWindow(pids)
	return ok
}

func restoreRemoteSupportMainWindow(exe string) bool {
	pids, err := pidsForExactImage(exe)
	if err != nil || len(pids) == 0 {
		return false
	}
	hwnd, ok := remoteSupportMainWindow(pids)
	if !ok {
		return false
	}
	_, _, _ = remoteSupportShowWindow.Call(uintptr(hwnd), uintptr(windows.SW_RESTORE))
	_, _, _ = remoteSupportSetForegroundWindow.Call(uintptr(hwnd))
	return true
}

func remoteSupportMainWindow(pids []uint32) (windows.HWND, bool) {
	owned := make(map[uint32]bool, len(pids))
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
		var rect windows.Rect
		ret, _, _ := remoteSupportGetWindowRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&rect)))
		if ret == 0 || !remoteSupportMainWindowSizeUsable(rect.Right-rect.Left, rect.Bottom-rect.Top) {
			return 1
		}
		found = hwnd
		return 0
	})
	_ = windows.EnumWindows(callback, nil)
	return found, found != 0
}
