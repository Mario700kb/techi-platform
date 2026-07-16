//go:build windows

package native

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	remoteSupportUser32              = windows.NewLazySystemDLL("user32.dll")
	remoteSupportGetWindowRect       = remoteSupportUser32.NewProc("GetWindowRect")
	remoteSupportGetWindowTextLength = remoteSupportUser32.NewProc("GetWindowTextLengthW")
	remoteSupportGetWindowText       = remoteSupportUser32.NewProc("GetWindowTextW")
	remoteSupportShowWindow          = remoteSupportUser32.NewProc("ShowWindow")
	remoteSupportSetForegroundWindow = remoteSupportUser32.NewProc("SetForegroundWindow")
	interactiveUserSession           = activeInteractiveUserSession
	runUIProbeInSession              = runRemoteSupportUIProbeInSession
)

const (
	remoteSupportUIWindowTimeout = 10 * time.Second
	remoteSupportUIHelperTimeout = 20 * time.Second
)

type interactiveSessionInfo struct {
	id            uint32
	username      string
	sid           string
	identityError string
}

type remoteSupportWindowDiagnostic struct {
	handle    windows.HWND
	pid       uint32
	title     string
	rect      windows.Rect
	visible   bool
	rejection string
}

func (w remoteSupportWindowDiagnostic) String() string {
	width := w.rect.Right - w.rect.Left
	height := w.rect.Bottom - w.rect.Top
	rejection := w.rejection
	if rejection == "" {
		rejection = "accepted"
	}
	return fmt.Sprintf(
		"handle=0x%X pid=%d title=%q rect=(%d,%d)-(%d,%d) width=%d height=%d visible=%t result=%q",
		uintptr(w.handle), w.pid, w.title, w.rect.Left, w.rect.Top, w.rect.Right, w.rect.Bottom,
		width, height, w.visible, rejection,
	)
}

func (e *windowsExecutor) StartUI(p ExecuteParams) (UndoFunc, error) {
	if err := ensureSafeExe(p.ExpectedExePath); err != nil {
		return nil, err
	}
	agentSessionID, agentSessionErr := currentProcessSessionID()
	session, ok, err := interactiveUserSession()
	if err != nil {
		e.uiStatus = remoteSupportUILaunchFailedStatus
		e.uiDiagnostic = formatStartUIDiagnostic(agentSessionID, agentSessionErr, session, false, p.ExpectedExePath, err)
		return nil, nil
	}
	if !ok || session.id == 0 {
		e.uiStatus = remoteSupportUIPendingLoginStatus
		e.uiDiagnostic = formatStartUIDiagnostic(agentSessionID, agentSessionErr, session, true, p.ExpectedExePath, nil)
		return nil, nil
	}
	if err := runUIProbeInSession(session.id, p.ExpectedExePath, true); err != nil {
		e.uiStatus = remoteSupportUILaunchFailedStatus
		e.uiDiagnostic = formatStartUIDiagnostic(agentSessionID, agentSessionErr, session, false, p.ExpectedExePath, err)
		return nil, nil
	}
	e.uiStatus = remoteSupportUIHealthyStatus
	return nil, nil
}

func (e *windowsExecutor) CompletionStatus() string { return e.uiStatus }
func (e *windowsExecutor) CompletionDetail() string { return e.uiDiagnostic }

func formatStartUIDiagnostic(agentSessionID uint32, agentSessionErr error, session interactiveSessionInfo, noSession bool, exe string, failure error) string {
	agentSession := fmt.Sprint(agentSessionID)
	if agentSessionErr != nil {
		agentSession = "unknown (" + agentSessionErr.Error() + ")"
	}
	interactiveSession := "none"
	if session.id != 0 {
		interactiveSession = fmt.Sprint(session.id)
	}
	reason := "none"
	if failure != nil {
		reason = failure.Error()
	}
	return fmt.Sprintf(
		"start_ui diagnostics: agent_session_id=%s; active_interactive_session_id=%s; interactive_username=%q; interactive_sid=%q; interactive_identity_error=%q; no_interactive_session=%t; launch_method=%q; executable_path=%q; arguments=[]; timeout=%s; detail={%s}",
		agentSession, interactiveSession, session.username, session.sid, session.identityError, noSession,
		"CreateProcessAsUser interactive helper -> normal executable launch", exe, remoteSupportUIWindowTimeout, reason,
	)
}

func remoteSupportMainWindowAvailable(exe string) bool {
	session, ok, err := interactiveUserSession()
	return err == nil && ok && runUIProbeInSession(session.id, exe, false) == nil
}

// RunRemoteSupportUISessionProbe runs inside the selected interactive user
// session. Window enumeration is intentionally performed here, never by the
// Session 0 service process.
func RunRemoteSupportUISessionProbe(exe string, expectedSession uint32, launch bool) error {
	if err := ensureSafeExe(exe); err != nil {
		return fmt.Errorf("executable_path=%q; arguments=[]; failure_reason=%q", exe, err)
	}
	currentSession, err := currentProcessSessionID()
	if err != nil {
		return fmt.Errorf("probe_session_id=unknown; expected_session_id=%d; executable_path=%q; arguments=[]; failure_reason=%q", expectedSession, exe, err)
	}
	if currentSession == 0 || currentSession != expectedSession {
		return fmt.Errorf(
			"probe_session_id=%d; expected_session_id=%d; launch_method=%q; executable_path=%q; arguments=[]; created_process_pid=none; created_process_session_id=none; process_exit_code=not_created; timeout=%s; visible_windows=[]; failure_reason=%q",
			currentSession, expectedSession, "normal executable launch", exe, remoteSupportUIWindowTimeout,
			fmt.Sprintf("UI probe session mismatch: current=%d expected=%d", currentSession, expectedSession),
		)
	}
	initialWindows, initialUsable := remoteSupportWindowSnapshotInSession(exe, currentSession)
	if launch && initialUsable != 0 {
		_, _, _ = remoteSupportShowWindow.Call(uintptr(initialUsable), uintptr(windows.SW_RESTORE))
		_, _, _ = remoteSupportSetForegroundWindow.Call(uintptr(initialUsable))
		return nil
	}
	if !launch {
		if initialUsable != 0 {
			return nil
		}
		return remoteSupportUIProbeError(currentSession, expectedSession, exe, 0, 0, "not_created", 0, initialWindows, "no usable Remote Support main window")
	}
	cmd := exec.Command(exe)
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		return remoteSupportUIProbeError(currentSession, expectedSession, exe, 0, 0, "not_created", remoteSupportUIWindowTimeout, initialWindows, "start executable: "+err.Error())
	}
	createdPID := uint32(cmd.Process.Pid)
	var createdSession uint32
	if err := windows.ProcessIdToSessionId(createdPID, &createdSession); err != nil {
		createdSession = 0
	}
	processHandle, processHandleErr := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, createdPID)
	_ = cmd.Process.Release()
	if processHandleErr == nil {
		defer windows.CloseHandle(processHandle)
	}
	processExitCode := "still_running_at_timeout"
	if processHandleErr != nil {
		processExitCode = "not_observed (OpenProcess: " + processHandleErr.Error() + ")"
	}
	windowsByHandle := make(map[windows.HWND]remoteSupportWindowDiagnostic)
	for _, found := range initialWindows {
		windowsByHandle[found.handle] = found
	}
	deadline := time.Now().Add(remoteSupportUIWindowTimeout)
	for time.Now().Before(deadline) {
		windowsFound, usable := remoteSupportWindowSnapshotInSession(exe, currentSession)
		for _, found := range windowsFound {
			windowsByHandle[found.handle] = found
		}
		if usable != 0 {
			_, _, _ = remoteSupportShowWindow.Call(uintptr(usable), uintptr(windows.SW_RESTORE))
			_, _, _ = remoteSupportSetForegroundWindow.Call(uintptr(usable))
			return nil
		}
		if processHandleErr == nil {
			if wait, waitErr := windows.WaitForSingleObject(processHandle, 0); waitErr == nil && wait == windows.WAIT_OBJECT_0 {
				var exitCode uint32
				if err := windows.GetExitCodeProcess(processHandle, &exitCode); err == nil {
					processExitCode = fmt.Sprint(exitCode)
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	windowsFound := make([]remoteSupportWindowDiagnostic, 0, len(windowsByHandle))
	for _, found := range windowsByHandle {
		windowsFound = append(windowsFound, found)
	}
	sort.Slice(windowsFound, func(i, j int) bool { return uintptr(windowsFound[i].handle) < uintptr(windowsFound[j].handle) })
	return remoteSupportUIProbeError(
		currentSession, expectedSession, exe, createdPID, createdSession, processExitCode,
		remoteSupportUIWindowTimeout, windowsFound, "Remote Support UI launch produced no usable main window",
	)
}

func remoteSupportUIProbeError(currentSession, expectedSession uint32, exe string, createdPID, createdSession uint32, exitCode string, timeout time.Duration, windowsFound []remoteSupportWindowDiagnostic, reason string) error {
	pid := "none"
	processSession := "none"
	if createdPID != 0 {
		pid = fmt.Sprint(createdPID)
	}
	if createdSession != 0 {
		processSession = fmt.Sprint(createdSession)
	}
	observations := make([]string, 0, len(windowsFound))
	for _, found := range windowsFound {
		observations = append(observations, found.String())
	}
	return fmt.Errorf(
		"probe_session_id=%d; expected_session_id=%d; launch_method=%q; executable_path=%q; arguments=[]; created_process_pid=%s; created_process_session_id=%s; process_exit_code=%s; timeout=%s; visible_windows=[%s]; failure_reason=%q",
		currentSession, expectedSession, "exec.Command normal launch", exe, pid, processSession, exitCode,
		timeout, strings.Join(observations, " | "), reason,
	)
}

func activeInteractiveUserSession() (interactiveSessionInfo, bool, error) {
	var sessions *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &sessions, &count); err != nil {
		return interactiveSessionInfo{}, false, err
	}
	if sessions != nil {
		defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(sessions)))
	}
	candidates := make([]uiSessionCandidate, 0, count)
	details := make(map[uint32]interactiveSessionInfo)
	for _, session := range unsafe.Slice(sessions, count) {
		candidate := uiSessionCandidate{id: session.SessionID, active: session.State == windows.WTSActive}
		if candidate.id != 0 && candidate.active {
			var token windows.Token
			if err := windows.WTSQueryUserToken(candidate.id, &token); err == nil {
				candidate.hasUser = true
				detail := interactiveSessionInfo{id: candidate.id}
				if user, userErr := token.GetTokenUser(); userErr == nil && user.User.Sid != nil {
					detail.sid = user.User.Sid.String()
					if account, domain, _, lookupErr := user.User.Sid.LookupAccount(""); lookupErr == nil {
						detail.username = account
						if domain != "" {
							detail.username = domain + `\` + account
						}
					} else {
						detail.identityError = "LookupAccountSid: " + lookupErr.Error()
					}
				} else if userErr != nil {
					detail.identityError = "GetTokenUser: " + userErr.Error()
				} else {
					detail.identityError = "GetTokenUser returned no SID"
				}
				details[candidate.id] = detail
				token.Close()
			}
		}
		candidates = append(candidates, candidate)
	}
	sessionID, ok := selectInteractiveSession(candidates, windows.WTSGetActiveConsoleSessionId())
	if !ok {
		return interactiveSessionInfo{}, false, nil
	}
	detail := details[sessionID]
	detail.id = sessionID
	return detail, true, nil
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
		return fmt.Errorf("helper_pid=not_created; helper_process_session_id=none; helper_exit_code=not_created; helper_timeout=%s; failure_reason=%q", remoteSupportUIHelperTimeout, "refusing to launch desktop UI in Session 0")
	}
	var token windows.Token
	if err := windows.WTSQueryUserToken(sessionID, &token); err != nil {
		return fmt.Errorf("helper_pid=not_created; helper_process_session_id=none; helper_exit_code=not_created; helper_timeout=%s; failure_reason=%q", remoteSupportUIHelperTimeout, "WTSQueryUserToken: "+err.Error())
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
	diagnosticsPath, diagnosticsSetupErr := createRemoteSupportUIDiagnosticsFile(token)
	if diagnosticsPath != "" {
		defer os.Remove(diagnosticsPath)
		args = append(args, "--diagnostics-file", diagnosticsPath)
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
		return fmt.Errorf("helper_pid=not_created; helper_process_session_id=none; helper_exit_code=not_created; helper_timeout=%s; helper_executable=%q; helper_arguments=%q; diagnostics_setup_error=%q; failure_reason=%q", remoteSupportUIHelperTimeout, self, args[1:], errorString(diagnosticsSetupErr), "CreateProcessAsUser: "+err.Error())
	}
	defer windows.CloseHandle(process.Process)
	defer windows.CloseHandle(process.Thread)
	var helperSession uint32
	_ = windows.ProcessIdToSessionId(process.ProcessId, &helperSession)
	wait, err := windows.WaitForSingleObject(process.Process, uint32(remoteSupportUIHelperTimeout/time.Millisecond))
	if err != nil {
		return fmt.Errorf("helper_pid=%d; helper_process_session_id=%d; helper_exit_code=unknown; helper_timeout=%s; helper_executable=%q; helper_arguments=%q; diagnostics_setup_error=%q; failure_reason=%q", process.ProcessId, helperSession, remoteSupportUIHelperTimeout, self, args[1:], errorString(diagnosticsSetupErr), "wait for helper: "+err.Error())
	}
	if wait != windows.WAIT_OBJECT_0 {
		_ = windows.TerminateProcess(process.Process, 1)
		output := readRemoteSupportUIDiagnostics(diagnosticsPath)
		return fmt.Errorf("helper_pid=%d; helper_process_session_id=%d; helper_exit_code=terminated; helper_timeout=%s; helper_executable=%q; helper_arguments=%q; diagnostics_setup_error=%q; helper_diagnostics={%s}; failure_reason=%q", process.ProcessId, helperSession, remoteSupportUIHelperTimeout, self, args[1:], errorString(diagnosticsSetupErr), output, "interactive UI probe timed out")
	}
	output := readRemoteSupportUIDiagnostics(diagnosticsPath)
	var exitCode uint32
	if err := windows.GetExitCodeProcess(process.Process, &exitCode); err != nil {
		return fmt.Errorf("helper_pid=%d; helper_process_session_id=%d; helper_exit_code=unknown; helper_timeout=%s; helper_executable=%q; helper_arguments=%q; diagnostics_setup_error=%q; helper_diagnostics={%s}; failure_reason=%q", process.ProcessId, helperSession, remoteSupportUIHelperTimeout, self, args[1:], errorString(diagnosticsSetupErr), output, "read helper exit code: "+err.Error())
	}
	if exitCode != 0 {
		return fmt.Errorf("helper_pid=%d; helper_process_session_id=%d; helper_exit_code=%d; helper_timeout=%s; helper_executable=%q; helper_arguments=%q; diagnostics_setup_error=%q; helper_diagnostics={%s}; failure_reason=%q", process.ProcessId, helperSession, exitCode, remoteSupportUIHelperTimeout, self, args[1:], errorString(diagnosticsSetupErr), output, "interactive UI probe failed")
	}
	return nil
}

func createRemoteSupportUIDiagnosticsFile(token windows.Token) (string, error) {
	profile, err := token.GetUserProfileDirectory()
	if err != nil {
		return "", err
	}
	file, err := os.CreateTemp(filepath.Join(profile, "AppData", "Local", "Temp"), "techi-rs-ui-*.diag")
	if err != nil {
		return "", err
	}
	path := file.Name()
	if err := file.Close(); err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
}

func readRemoteSupportUIDiagnostics(path string) string {
	if path == "" {
		return "unavailable"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "read failed: " + err.Error()
	}
	if detail := strings.TrimSpace(string(data)); detail != "" {
		return detail
	}
	return "empty"
}

func errorString(err error) string {
	if err == nil {
		return "none"
	}
	return err.Error()
}

func remoteSupportMainWindowAvailableInSession(exe string, sessionID uint32) bool {
	_, usable := remoteSupportWindowSnapshotInSession(exe, sessionID)
	return usable != 0
}

func restoreRemoteSupportMainWindowInSession(exe string, sessionID uint32) bool {
	_, hwnd := remoteSupportWindowSnapshotInSession(exe, sessionID)
	if hwnd == 0 {
		return false
	}
	_, _, _ = remoteSupportShowWindow.Call(uintptr(hwnd), uintptr(windows.SW_RESTORE))
	_, _, _ = remoteSupportSetForegroundWindow.Call(uintptr(hwnd))
	return true
}

func remoteSupportWindowSnapshotInSession(exe string, sessionID uint32) ([]remoteSupportWindowDiagnostic, windows.HWND) {
	pids, err := pidsForExactImageSession(exe, sessionID)
	if err != nil || len(pids) == 0 {
		return nil, 0
	}
	return remoteSupportWindowSnapshot(pids)
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
	_, found := remoteSupportWindowSnapshot(pids)
	return found, found != 0
}

func remoteSupportWindowSnapshot(pids []uint32) ([]remoteSupportWindowDiagnostic, windows.HWND) {
	owned := make(map[uint32]bool, len(pids))
	for _, pid := range pids {
		owned[pid] = true
	}
	var found windows.HWND
	var observations []remoteSupportWindowDiagnostic
	callback := windows.NewCallback(func(hwnd windows.HWND, _ uintptr) uintptr {
		if !windows.IsWindowVisible(hwnd) {
			return 1
		}
		var pid uint32
		windows.GetWindowThreadProcessId(hwnd, &pid)
		if !owned[pid] {
			return 1
		}
		observation := remoteSupportWindowDiagnostic{
			handle:  hwnd,
			pid:     pid,
			title:   remoteSupportWindowTitle(hwnd),
			visible: true,
		}
		var rect windows.Rect
		ret, _, callErr := remoteSupportGetWindowRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&rect)))
		if ret == 0 {
			observation.rejection = "GetWindowRect failed"
			if callErr != nil && callErr != windows.ERROR_SUCCESS {
				observation.rejection += ": " + callErr.Error()
			}
			observations = append(observations, observation)
			return 1
		}
		observation.rect = rect
		observation.rejection = remoteSupportMainWindowRejectionReason(rect.Right-rect.Left, rect.Bottom-rect.Top)
		observations = append(observations, observation)
		if observation.rejection == "" && found == 0 {
			found = hwnd
		}
		return 1
	})
	_ = windows.EnumWindows(callback, nil)
	return observations, found
}

func remoteSupportWindowTitle(hwnd windows.HWND) string {
	length, _, _ := remoteSupportGetWindowTextLength.Call(uintptr(hwnd))
	if length == 0 {
		return ""
	}
	buffer := make([]uint16, int(length)+1)
	read, _, _ := remoteSupportGetWindowText.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if read == 0 {
		return ""
	}
	return windows.UTF16ToString(buffer[:read])
}
