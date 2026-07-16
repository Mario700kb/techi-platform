//go:build windows

package native

import (
	"fmt"
	"os"
	"os/exec"
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
	interactiveUserSession           = activeInteractiveUserSession
	runUIProbeInSession              = runRemoteSupportUIProbeInSession
)

func (e *windowsExecutor) StartUI(p ExecuteParams) (UndoFunc, error) {
	if err := ensureSafeExe(p.ExpectedExePath); err != nil {
		return nil, err
	}
	sessionID, ok, err := interactiveUserSession()
	if err != nil {
		e.uiStatus = remoteSupportUILaunchFailedStatus
		return nil, nil
	}
	if !ok || sessionID == 0 {
		e.uiStatus = remoteSupportUIPendingLoginStatus
		return nil, nil
	}
	if err := runUIProbeInSession(sessionID, p.ExpectedExePath, true); err != nil {
		e.uiStatus = remoteSupportUILaunchFailedStatus
		return nil, nil
	}
	e.uiStatus = remoteSupportUIHealthyStatus
	return nil, nil
}

func (e *windowsExecutor) CompletionStatus() string { return e.uiStatus }

func remoteSupportMainWindowAvailable(exe string) bool {
	sessionID, ok, err := interactiveUserSession()
	return err == nil && ok && runUIProbeInSession(sessionID, exe, false) == nil
}

// RunRemoteSupportUISessionProbe runs inside the selected interactive user
// session. Window enumeration is intentionally performed here, never by the
// Session 0 service process.
func RunRemoteSupportUISessionProbe(exe string, expectedSession uint32, launch bool) error {
	if err := ensureSafeExe(exe); err != nil {
		return err
	}
	currentSession, err := currentProcessSessionID()
	if err != nil {
		return err
	}
	if currentSession == 0 || currentSession != expectedSession {
		return fmt.Errorf("UI probe session mismatch: current=%d expected=%d", currentSession, expectedSession)
	}
	if launch && restoreRemoteSupportMainWindowInSession(exe, currentSession) {
		return nil
	}
	if !launch {
		if remoteSupportMainWindowAvailableInSession(exe, currentSession) {
			return nil
		}
		return fmt.Errorf("no usable Remote Support main window in session %d", currentSession)
	}
	cmd := exec.Command(exe)
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if restoreRemoteSupportMainWindowInSession(exe, currentSession) {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("Remote Support UI launch produced no usable main window in session %d", currentSession)
}

func activeInteractiveUserSession() (uint32, bool, error) {
	var sessions *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &sessions, &count); err != nil {
		return 0, false, err
	}
	if sessions != nil {
		defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(sessions)))
	}
	candidates := make([]uiSessionCandidate, 0, count)
	for _, session := range unsafe.Slice(sessions, count) {
		candidate := uiSessionCandidate{id: session.SessionID, active: session.State == windows.WTSActive}
		if candidate.id != 0 && candidate.active {
			var token windows.Token
			if err := windows.WTSQueryUserToken(candidate.id, &token); err == nil {
				candidate.hasUser = true
				token.Close()
			}
		}
		candidates = append(candidates, candidate)
	}
	sessionID, ok := selectInteractiveSession(candidates, windows.WTSGetActiveConsoleSessionId())
	return sessionID, ok, nil
}

func currentProcessSessionID() (uint32, error) {
	var sessionID uint32
	if err := windows.ProcessIdToSessionId(uint32(os.Getpid()), &sessionID); err != nil {
		return 0, err
	}
	return sessionID, nil
}

func runRemoteSupportUIProbeInSession(sessionID uint32, exe string, launch bool) error {
	if sessionID == 0 {
		return fmt.Errorf("refusing to launch desktop UI in Session 0")
	}
	var token windows.Token
	if err := windows.WTSQueryUserToken(sessionID, &token); err != nil {
		return err
	}
	defer token.Close()

	self, err := os.Executable()
	if err != nil {
		return err
	}
	args := []string{self, "remote-support-ui-session", "--exe", exe, "--session-id", fmt.Sprint(sessionID)}
	if launch {
		args = append(args, "--launch")
	}
	app, err := windows.UTF16PtrFromString(self)
	if err != nil {
		return err
	}
	commandLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(args))
	if err != nil {
		return err
	}
	desktop, _ := windows.UTF16PtrFromString(`winsta0\default`)
	currentDir, _ := windows.UTF16PtrFromString(filepath.Dir(self))
	var environment *uint16
	if err := windows.CreateEnvironmentBlock(&environment, token, false); err != nil {
		return err
	}
	defer windows.DestroyEnvironmentBlock(environment)
	startup := windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{})), Desktop: desktop}
	var process windows.ProcessInformation
	if err := windows.CreateProcessAsUser(
		token, app, commandLine, nil, nil, false,
		windows.CREATE_UNICODE_ENVIRONMENT|windows.CREATE_NEW_PROCESS_GROUP|windows.CREATE_NO_WINDOW,
		environment, currentDir, &startup, &process,
	); err != nil {
		return err
	}
	defer windows.CloseHandle(process.Process)
	defer windows.CloseHandle(process.Thread)
	wait, err := windows.WaitForSingleObject(process.Process, 20_000)
	if err != nil {
		return err
	}
	if wait != windows.WAIT_OBJECT_0 {
		_ = windows.TerminateProcess(process.Process, 1)
		return fmt.Errorf("interactive UI probe timed out")
	}
	var exitCode uint32
	if err := windows.GetExitCodeProcess(process.Process, &exitCode); err != nil {
		return err
	}
	if exitCode != 0 {
		return fmt.Errorf("interactive UI probe exited with %d", exitCode)
	}
	return nil
}

func remoteSupportMainWindowAvailableInSession(exe string, sessionID uint32) bool {
	pids, err := pidsForExactImageSession(exe, sessionID)
	if err != nil || len(pids) == 0 {
		return false
	}
	_, ok := remoteSupportMainWindow(pids)
	return ok
}

func restoreRemoteSupportMainWindowInSession(exe string, sessionID uint32) bool {
	pids, err := pidsForExactImageSession(exe, sessionID)
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

func pidsForExactImageSession(exe string, sessionID uint32) ([]uint32, error) {
	pids, err := pidsForExactImage(exe)
	if err != nil {
		return nil, err
	}
	result := make([]uint32, 0, len(pids))
	for _, pid := range pids {
		var processSession uint32
		if err := windows.ProcessIdToSessionId(pid, &processSession); err == nil && processSession == sessionID {
			result = append(result, pid)
		}
	}
	return result, nil
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
