//go:build windows

package native

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// windowsExecutor is the real, side-effecting Executor. Every primitive is
// exact and bounded: services by exact name, processes by exact image path,
// files confined to the approved install directory, reparse points refused,
// never executing from %TEMP%, never a name-only taskkill, never the RS MSI.
type windowsExecutor struct{}

// NewWindowsExecutor returns the live Windows Executor.
func NewWindowsExecutor() Executor { return windowsExecutor{} }

func (windowsExecutor) VerifyPayload(path, sha string) error {
	if _, err := VerifyPayload(path, sha); err != nil {
		return err
	}
	return nil
}

// --- service control (exact name via SCM) ---------------------------------

func (windowsExecutor) StopService(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return nil // not present ⇒ nothing to stop
	}
	defer s.Close()
	st, err := s.Query()
	if err == nil && st.State == svc.Stopped {
		return nil
	}
	if _, err := s.Control(svc.Stop); err != nil {
		// ERROR_SERVICE_NOT_ACTIVE is fine.
		if !strings.Contains(err.Error(), "not been started") && !strings.Contains(err.Error(), "1062") {
			return err
		}
	}
	return waitServiceState(s, svc.Stopped, 30*time.Second)
}

func (windowsExecutor) StartService(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return err
	}
	defer s.Close()
	if err := s.Start(); err != nil && !strings.Contains(err.Error(), "already running") {
		return err
	}
	return waitServiceState(s, svc.Running, 30*time.Second)
}

func (e windowsExecutor) RemoveStaleService(name string) error {
	_ = e.StopService(name)
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return nil // already gone
	}
	defer s.Close()
	return s.Delete()
}

func (windowsExecutor) CreateService(name, exePath string) error {
	if err := ensureSafeExe(exePath); err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	if s, err := m.OpenService(name); err == nil {
		s.Close()
		return nil // already exists; do not clobber
	}
	s, err := m.CreateService(name, exePath, mgr.Config{
		StartType:   mgr.StartAutomatic,
		DisplayName: name,
	})
	if err != nil {
		return err
	}
	s.Close()
	return nil
}

func waitServiceState(s *mgr.Service, want svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		st, err := s.Query()
		if err != nil {
			return err
		}
		if st.State == want {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("service did not reach state %d within %s", want, timeout)
}

// --- tray scheduled task (exact task name) --------------------------------

func (windowsExecutor) StopTray(taskName string) error {
	if strings.TrimSpace(taskName) == "" {
		return nil // no tray task configured
	}
	schtasks := filepath.Join(os.Getenv("SystemRoot"), "System32", "schtasks.exe")
	// End a running instance then disable it so it cannot relaunch and re-lock
	// files mid-recovery. Missing task is not an error.
	_ = runHidden(schtasks, "/End", "/TN", taskName)
	if err := runHidden(schtasks, "/Change", "/TN", taskName, "/DISABLE"); err != nil {
		if strings.Contains(err.Error(), "cannot find") || strings.Contains(err.Error(), "does not exist") {
			return nil
		}
		return err
	}
	return nil
}

// --- exact-path process termination ---------------------------------------

func (windowsExecutor) StopProcessExact(exePath string, wait time.Duration) error {
	target, err := filepath.Abs(exePath)
	if err != nil {
		return err
	}
	pids, err := pidsForExactImage(target)
	if err != nil {
		return err
	}
	for _, pid := range pids {
		h, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, pid)
		if err != nil {
			continue
		}
		_ = windows.TerminateProcess(h, 1)
		if wait > 0 {
			_, _ = windows.WaitForSingleObject(h, uint32(wait/time.Millisecond))
		}
		windows.CloseHandle(h)
	}
	// Confirm none survive.
	if survivors, _ := pidsForExactImage(target); len(survivors) > 0 {
		return fmt.Errorf("%d process(es) still hold %s", len(survivors), target)
	}
	return nil
}

// pidsForExactImage returns PIDs whose FULL image path equals target exactly
// (case-insensitive). It never matches on image name alone.
func pidsForExactImage(target string) ([]uint32, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snap)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	var pids []uint32
	for err = windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
		pid := entry.ProcessID
		if pid == 0 {
			continue
		}
		full, ferr := fullImagePath(pid)
		if ferr != nil {
			continue
		}
		if strings.EqualFold(full, target) {
			pids = append(pids, pid)
		}
	}
	return pids, nil
}

func fullImagePath(pid uint32) (string, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_PATH)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &size); err != nil {
		return "", err
	}
	return windows.UTF16ToString(buf[:size]), nil
}

// --- config preservation (exact files supplied by wiring) -----------------

func (windowsExecutor) PreserveConfig(installDir string) error { return nil }

func (windowsExecutor) RestoreConfig(installDir string) error { return nil }

// --- tmp cleanup confined to installDir -----------------------------------

func (windowsExecutor) CleanupTmp(installDir string) error {
	if err := ensureSafeDir(installDir); err != nil {
		return err
	}
	entries, err := os.ReadDir(installDir)
	if err != nil {
		return err
	}
	for _, ent := range entries {
		name := ent.Name()
		lower := strings.ToLower(name)
		if strings.HasSuffix(lower, ".tmp") && (strings.HasPrefix(name, "TBD") || strings.HasPrefix(lower, "tbd")) {
			p := filepath.Join(installDir, name)
			if isReparsePoint(p) {
				continue // never follow/delete through a reparse point
			}
			_ = os.Remove(p)
		}
	}
	return nil
}

// --- staging + atomic promotion + rollback --------------------------------

func (windowsExecutor) StagePayload(payloadPath, stagingDir string) error {
	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		return err
	}
	if err := restrictACL(stagingDir); err != nil {
		return err
	}
	// The approved RS payload is a native bundle delivered as a .zip; extract it
	// with zip-slip and reparse protection. A raw directory payload is copied.
	if strings.HasSuffix(strings.ToLower(payloadPath), ".zip") {
		return extractZipSafe(payloadPath, stagingDir)
	}
	return copyTreeSafe(payloadPath, stagingDir)
}

func (windowsExecutor) PromoteFiles(stagingDir, installDir string) error {
	if err := ensureSafeDir(installDir); err != nil {
		return err
	}
	// Back up the current install dir by rename (atomic on same volume), then
	// move staged files into place. Rollback renames the backup back.
	backup := installDir + ".techibak"
	_ = os.RemoveAll(backup)
	if _, err := os.Stat(installDir); err == nil {
		if isReparsePoint(installDir) {
			return fmt.Errorf("install dir is a reparse point; refusing to promote: %s", installDir)
		}
		if err := os.Rename(installDir, backup); err != nil {
			return err
		}
	}
	if err := os.Rename(stagingDir, installDir); err != nil {
		_ = os.Rename(backup, installDir) // best-effort undo
		return err
	}
	return nil
}

func (windowsExecutor) Rollback(installDir string) error {
	backup := installDir + ".techibak"
	if _, err := os.Stat(backup); err != nil {
		return nil // nothing to roll back
	}
	_ = os.RemoveAll(installDir)
	return os.Rename(backup, installDir)
}

// --- one bounded boot retry -----------------------------------------------

func (windowsExecutor) ScheduleBootRetry(command string) error {
	if strings.TrimSpace(command) == "" {
		return fmt.Errorf("empty boot-retry command")
	}
	schtasks := filepath.Join(os.Getenv("SystemRoot"), "System32", "schtasks.exe")
	// ONSTART one-shot; the command is responsible for deleting the task after
	// it runs so there is never more than one retry.
	return runHidden(schtasks, "/Create", "/F", "/RU", "SYSTEM", "/SC", "ONSTART",
		"/TN", "TechiRSBootRetry", "/TR", command)
}

// --- final validation ------------------------------------------------------

func (windowsExecutor) ValidateFinal(p ExecuteParams) error {
	if err := ensureSafeExe(p.ExpectedExePath); err != nil {
		return err
	}
	if _, err := os.Stat(p.ExpectedExePath); err != nil {
		return fmt.Errorf("expected EXE missing: %w", err)
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(p.ServiceName)
	if err != nil {
		return fmt.Errorf("service %s missing after recovery: %w", p.ServiceName, err)
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return err
	}
	if st.State != svc.Running {
		return fmt.Errorf("service %s not RUNNING (state=%d)", p.ServiceName, st.State)
	}
	cfg, err := s.Config()
	if err != nil {
		return err
	}
	if !imagePathMatches(cfg.BinaryPathName, p.ExpectedExePath) {
		return fmt.Errorf("service image path %q != expected %q", cfg.BinaryPathName, p.ExpectedExePath)
	}
	return nil
}

// --- safety helpers --------------------------------------------------------

func ensureSafeExe(exePath string) error {
	abs, err := filepath.Abs(exePath)
	if err != nil {
		return err
	}
	if IsRefusedInstallTarget(filepath.Dir(abs)) {
		return fmt.Errorf("refused unsafe exe location: %s", abs)
	}
	if isInTemp(abs) {
		return fmt.Errorf("refusing to run from TEMP: %s", abs)
	}
	if isReparsePoint(abs) {
		return fmt.Errorf("exe path is a reparse point: %s", abs)
	}
	return nil
}

func ensureSafeDir(dir string) error {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if IsRefusedInstallTarget(abs) {
		return fmt.Errorf("refused unsafe directory: %s", abs)
	}
	if isInTemp(abs) {
		return fmt.Errorf("refusing operation in TEMP: %s", abs)
	}
	if isReparsePoint(abs) {
		return fmt.Errorf("directory is a reparse point: %s", abs)
	}
	return nil
}

func isInTemp(path string) bool {
	lower := strings.ToLower(path)
	for _, t := range []string{os.Getenv("TEMP"), os.Getenv("TMP"), `\windows\temp\`, `\appdata\local\temp\`} {
		if t == "" {
			continue
		}
		if strings.Contains(lower, strings.ToLower(strings.TrimRight(t, `\`))+`\`) {
			return true
		}
	}
	return false
}

func isReparsePoint(path string) bool {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	attrs, err := windows.GetFileAttributes(p)
	if err != nil {
		return false
	}
	return attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

func imagePathMatches(binaryPathName, expectedExe string) bool {
	bp := strings.Trim(strings.TrimSpace(binaryPathName), `"`)
	// Strip any trailing service arguments.
	if idx := strings.Index(strings.ToLower(bp), ".exe"); idx >= 0 {
		bp = bp[:idx+4]
	}
	a, _ := filepath.Abs(bp)
	b, _ := filepath.Abs(expectedExe)
	return strings.EqualFold(a, b)
}

// extractZipSafe / copyTreeSafe / restrictACL / runHidden are implemented in
// executor_windows_fs.go to keep this file focused on the Executor contract.
