//go:build windows

package native

import (
	"errors"
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
// exact and bounded and returns an UndoFunc so the orchestrator can roll back
// transactionally. NOTE: this code compiles for windows/amd64 and is structured
// to the contract, but its real side effects are UNPROVEN on a real device and
// require a disposable Windows lab run before any canary.
type configBackup struct {
	path          string
	backup        string
	sha256        string
	mode          os.FileMode
	mtime         time.Time
	sddl          string
	ownerFallback bool
	groupFallback bool
}

type windowsExecutor struct {
	preserved []configBackup
}

// NewWindowsExecutor returns the live Windows Executor.
func NewWindowsExecutor() Executor { return &windowsExecutor{} }

// Fixed managed roots (#9). Production refuses any target outside these.
const (
	managedInstallRoot = `C:\Program Files\TECHI Remote Support`
	managedStagingRoot = `C:\ProgramData\TechiAgent\staging`
	managedBackupRoot  = `C:\ProgramData\TechiAgent\backup`
	ownerMarkerName    = ".techi-owner"
)

func ensureManagedRoots(p ExecuteParams) error {
	if !strings.EqualFold(filepath.Clean(p.InstallDir), managedInstallRoot) {
		return fmt.Errorf("install dir %q is not the managed root", p.InstallDir)
	}
	if !strings.EqualFold(filepath.Clean(p.StagingRoot), managedStagingRoot) {
		return fmt.Errorf("staging root %q is not the managed staging root", p.StagingRoot)
	}
	if !strings.EqualFold(filepath.Clean(p.BackupRoot), managedBackupRoot) {
		return fmt.Errorf("backup root %q is not the managed backup root", p.BackupRoot)
	}
	return nil
}

// --- state capture ---------------------------------------------------------

func (*windowsExecutor) CaptureState(p ExecuteParams) (PriorState, error) {
	var st PriorState
	if err := ensureManagedRoots(p); err != nil {
		return st, err
	}
	if fi, err := os.Stat(p.InstallDir); err == nil && fi.IsDir() {
		st.InstallDirExists = true
	}
	var serviceErr error
	st.Service, serviceErr = captureServiceSnapshot(p.ServiceName)
	if serviceErr != nil {
		return st, serviceErr
	}
	st.TrayExists, st.TrayEnabled, st.TrayRunning = queryTrayTask(p.TrayTaskName)
	exists, owned, retryErr := queryRetryTask()
	if retryErr != nil {
		return st, retryErr
	}
	if exists && !owned {
		return st, fmt.Errorf("scheduled task TechiRSBootRetry exists but is not TECHI-owned")
	}
	if p.RetryOwner != "" {
		if p.RetryOwner != retryStateOwner || !exists || !owned {
			return st, fmt.Errorf("owned boot retry invocation has no matching TECHI-owned task")
		}
		rp, err := RetryStatePath(p.RetryRoot, p.Component)
		if err != nil {
			return st, err
		}
		if _, err := RecordBootRetryInvocation(rp, p.Component, p.ExpectedVersion); err != nil {
			return st, err
		}
	}
	if exists {
		st.RetryTaskExists = true
	}
	if rp, err := RetryStatePath(p.RetryRoot, p.Component); err == nil {
		if _, err := os.Stat(rp); err == nil {
			st.RetryTaskExists = true
		}
	}
	return st, nil
}

func (*windowsExecutor) VerifyPayload(path, sha string) error {
	if _, err := VerifyPayload(path, sha); err != nil {
		return err
	}
	return nil
}

func (*windowsExecutor) Health(p ExecuteParams) string {
	snap := queryServiceSnapshot(p.ServiceName)
	exe := "missing"
	if _, err := os.Stat(p.ExpectedExePath); err == nil {
		exe = "present"
	}
	return fmt.Sprintf("exe=%s service_exists=%t running=%t", exe, snap.Exists, snap.Running)
}

// --- config preservation (allowlist) --------------------------------------

func (e *windowsExecutor) PreserveConfig(p ExecuteParams) (UndoFunc, error) {
	// Only exact allowlisted files are captured; reparse points/unsafe paths are
	// refused. Config lives OUTSIDE the install dir, so promotion does not
	// disturb it — this snapshot exists so we can RESTORE if something removes
	// it, and VALIDATE survival afterward.
	backupDir := filepath.Join(p.BackupRoot, "config")
	undo := func() error {
		if err := e.restorePreservedConfig(); err != nil {
			return err
		}
		return removeOwnedDir(backupDir)
	}
	if _, err := os.Lstat(backupDir); err == nil {
		if err := removeOwnedDir(backupDir); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		return nil, err
	}
	if err := writeOwnerMarker(backupDir); err != nil {
		return undo, err
	}
	if err := restrictACL(backupDir); err != nil {
		return undo, err
	}
	e.preserved = nil
	identities := map[string]bool{}
	for _, src := range effectiveConfigPaths(p) {
		if err := validateApprovedConfigPath(src); err != nil {
			return undo, err
		}
		if hasReparseAncestor(src) {
			return undo, fmt.Errorf("refusing config through reparse path: %s", src)
		}
		info, err := os.Lstat(src)
		if err != nil {
			continue // absent is fine; nothing to preserve
		}
		if !info.Mode().IsRegular() {
			return undo, fmt.Errorf("config is not a regular file: %s", src)
		}
		data, err := os.ReadFile(src)
		if err != nil {
			return undo, err
		}
		identity, err := validatePreservableConfig(src, data)
		if err != nil {
			return undo, fmt.Errorf("unsafe config %s: %w", src, err)
		}
		if identity != "" {
			identities[identity] = true
			if len(identities) > 1 {
				return undo, fmt.Errorf("conflicting Remote Support profile identities")
			}
		}
		dst := filepath.Join(backupDir, HashBytesSHA256([]byte(strings.ToLower(src)))+".toml")
		if err := copyOneFile(src, dst); err != nil {
			return undo, err
		}
		h, err := HashFileSHA256(src)
		if err != nil {
			return undo, err
		}
		sddl, err := fileSecurityDescriptor(src)
		if err != nil {
			return undo, err
		}
		e.preserved = append(e.preserved, configBackup{path: src, backup: dst, sha256: h, mode: info.Mode().Perm(), mtime: info.ModTime(), sddl: sddl})
	}
	return undo, nil
}

func (e *windowsExecutor) RestoreConfig(ExecuteParams) (UndoFunc, error) {
	if err := e.restorePreservedConfig(); err != nil {
		return nil, err
	}
	return nil, nil
}

func (e *windowsExecutor) restorePreservedConfig() error {
	for i := range e.preserved {
		saved := &e.preserved[i]
		backupData, err := os.ReadFile(saved.backup)
		if err != nil {
			return err
		}
		if _, err := validatePreservableConfig(saved.path, backupData); err != nil {
			return fmt.Errorf("preserved backup failed semantic validation: %w", err)
		}
		current, err := HashFileSHA256(saved.path)
		if err == nil && strings.EqualFold(current, saved.sha256) {
			info, statErr := os.Stat(saved.path)
			if statErr != nil {
				return statErr
			}
			if info.Mode().Perm() != saved.mode {
				if err := os.Chmod(saved.path, saved.mode); err != nil {
					return err
				}
			}
			if !info.ModTime().Equal(saved.mtime) {
				if err := os.Chtimes(saved.path, saved.mtime, saved.mtime); err != nil {
					return err
				}
			}
			currentSDDL, err := fileSecurityDescriptor(saved.path)
			if err != nil {
				return err
			}
			if currentSDDL != saved.sddl {
				result, err := restoreFileSecurityDescriptor(saved.path, saved.sddl)
				if err != nil {
					return err
				}
				saved.ownerFallback = saved.ownerFallback || result.ownerFallback
				saved.groupFallback = saved.groupFallback || result.groupFallback
			}
			continue
		}
		if err := copyOneFile(saved.backup, saved.path); err != nil {
			return err
		}
		if err := os.Chmod(saved.path, saved.mode); err != nil {
			return err
		}
		if err := os.Chtimes(saved.path, saved.mtime, saved.mtime); err != nil {
			return err
		}
		result, err := restoreFileSecurityDescriptor(saved.path, saved.sddl)
		if err != nil {
			return err
		}
		saved.ownerFallback = saved.ownerFallback || result.ownerFallback
		saved.groupFallback = saved.groupFallback || result.groupFallback
		got, err := HashFileSHA256(saved.path)
		if err != nil || !strings.EqualFold(got, saved.sha256) {
			return fmt.Errorf("restored config hash mismatch: %s", saved.path)
		}
	}
	return nil
}

// --- service control (exact name + args) ----------------------------------

func (*windowsExecutor) StopService(p ExecuteParams, prior PriorState) (UndoFunc, error) {
	undo := func() error {
		if prior.Service.Exists && prior.Service.Running {
			return startServiceByName(p.ServiceName)
		}
		return nil
	}
	if err := stopServiceByName(p.ServiceName); err != nil {
		return undo, err
	}
	return undo, nil
}

func (*windowsExecutor) StartService(p ExecuteParams, prior PriorState) (UndoFunc, error) {
	wasRunning := queryServiceSnapshot(p.ServiceName).Running
	undo := func() error {
		if !wasRunning {
			return stopServiceByName(p.ServiceName)
		}
		return nil
	}
	if err := startServiceByName(p.ServiceName); err != nil {
		return undo, err
	}
	return undo, nil
}

func (*windowsExecutor) RemoveStaleService(p ExecuteParams, prior PriorState) (UndoFunc, error) {
	snap := prior.Service
	undo := func() error {
		if snap.Exists {
			return restoreServiceSnapshot(p.ServiceName, snap)
		}
		return nil
	}
	if snap.Exists && !restorableServiceAccount(snap.Account) {
		return nil, fmt.Errorf("cannot transactionally recreate service account %q without its credential", snap.Account)
	}
	if err := stopServiceByName(p.ServiceName); err != nil {
		return undo, err
	}
	if err := deleteServiceByName(p.ServiceName); err != nil {
		return undo, err
	}
	return undo, nil
}

func (*windowsExecutor) CreateService(p ExecuteParams, m *BundleManifest, prior PriorState) (UndoFunc, error) {
	if m == nil {
		return nil, fmt.Errorf("service creation requires a bound manifest")
	}
	// Validate the manifest's service arguments are exactly the approved set.
	if len(m.ServiceArguments) == 0 {
		return nil, fmt.Errorf("manifest has no service_arguments")
	}
	// The service binary is the manifest entrypoint under the install dir.
	exe := filepath.Join(p.InstallDir, filepath.FromSlash(m.EntrypointUnderRoot()))
	if err := ensureSafeExe(exe); err != nil {
		return nil, err
	}
	// Consult current state: a stale service may have just been deliberately
	// removed even though it existed in the pre-transaction snapshot.
	existed := queryServiceSnapshot(p.ServiceName).Exists
	undo := func() error {
		if existed && prior.Service.Exists {
			return restoreExistingServiceConfig(p.ServiceName, prior.Service)
		}
		if prior.Service.Exists {
			// Files have not rolled back yet. Restore the original service
			// configuration stopped; the earlier StopService undo restarts it
			// only after promotion/config rollback has restored the old files.
			stopped := prior.Service
			stopped.Running = false
			return restoreServiceSnapshot(p.ServiceName, stopped)
		}
		return deleteServiceByName(p.ServiceName)
	}
	if existed {
		if err := scReconfigure(p.ServiceName, exe, m.ServiceArguments); err != nil {
			return undo, err
		}
	} else {
		if err := scCreate(p.ServiceName, exe, m.ServiceArguments); err != nil {
			return undo, err
		}
	}
	return undo, nil
}

// --- tray scheduled task ---------------------------------------------------

func (*windowsExecutor) StopTray(p ExecuteParams, prior PriorState) (UndoFunc, error) {
	if strings.TrimSpace(p.TrayTaskName) == "" || !prior.TrayExists {
		return nil, nil
	}
	schtasks := system32("schtasks.exe")
	undo := func() error {
		if prior.TrayEnabled {
			if err := runHidden(schtasks, "/Change", "/TN", p.TrayTaskName, "/ENABLE"); err != nil {
				return err
			}
		}
		if prior.TrayRunning {
			return runHidden(schtasks, "/Run", "/TN", p.TrayTaskName)
		}
		return nil
	}
	if prior.TrayRunning {
		if err := runHidden(schtasks, "/End", "/TN", p.TrayTaskName); err != nil {
			return undo, err
		}
	}
	if err := runHidden(schtasks, "/Change", "/TN", p.TrayTaskName, "/DISABLE"); err != nil {
		if !strings.Contains(err.Error(), "cannot find") && !strings.Contains(err.Error(), "does not exist") {
			return undo, err
		}
	}
	return undo, nil
}

// --- exact-path process termination (#10) ---------------------------------

func (*windowsExecutor) StopProcessExact(exePath string, wait time.Duration) (UndoFunc, error) {
	target, err := filepath.Abs(exePath)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(wait)
	pids, err := pidsForExactImage(target)
	if err != nil {
		return nil, err
	}
	terminated := 0
	irreversibleUndo := func() error {
		return fmt.Errorf("%d exact-image process(es) were terminated and cannot be automatically recreated", terminated)
	}
	for _, pid := range pids {
		// One handle with query + terminate + synchronize rights; validate the
		// image path on THAT handle immediately before terminating (closes the
		// PID-reuse race #10).
		h, oerr := windows.OpenProcess(
			windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE,
			false, pid)
		if oerr != nil {
			if terminated > 0 {
				return irreversibleUndo, fmt.Errorf("cannot reopen identified pid %d: %w", pid, oerr)
			}
			return nil, fmt.Errorf("cannot reopen identified pid %d: %w", pid, oerr)
		}
		full, perr := fullImagePathFromHandle(h)
		if perr != nil || !strings.EqualFold(full, target) {
			windows.CloseHandle(h)
			continue // PID was reused / not our target — never kill it
		}
		if err := windows.TerminateProcess(h, 1); err != nil {
			windows.CloseHandle(h)
			if terminated > 0 {
				return irreversibleUndo, fmt.Errorf("terminate pid %d: %w", pid, err)
			}
			return nil, fmt.Errorf("terminate pid %d: %w", pid, err)
		}
		terminated++
		remaining := time.Until(deadline)
		if remaining <= 0 {
			windows.CloseHandle(h)
			return irreversibleUndo, fmt.Errorf("global process termination deadline exceeded")
		}
		waitResult, waitErr := windows.WaitForSingleObject(h, uint32(remaining/time.Millisecond))
		windows.CloseHandle(h)
		if waitErr != nil {
			return irreversibleUndo, fmt.Errorf("wait pid %d: %w", pid, waitErr)
		}
		if waitResult != windows.WAIT_OBJECT_0 {
			return irreversibleUndo, fmt.Errorf("pid %d did not exit before global deadline", pid)
		}
	}
	if survivors, err := pidsForExactImage(target); err != nil {
		if terminated > 0 {
			return irreversibleUndo, err
		}
		return nil, err
	} else if len(survivors) > 0 {
		if terminated > 0 {
			return irreversibleUndo, fmt.Errorf("%d process(es) still hold %s", len(survivors), target)
		}
		return nil, fmt.Errorf("%d process(es) still hold %s", len(survivors), target)
	}
	if terminated > 0 {
		return irreversibleUndo, nil
	}
	return nil, nil
}

// --- tmp cleanup -----------------------------------------------------------

func (*windowsExecutor) CleanupTmp(p ExecuteParams) (UndoFunc, error) {
	if err := ensureSafeDir(p.InstallDir); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(p.InstallDir)
	if err != nil {
		return nil, nil // nothing to clean
	}
	quarantine := filepath.Join(p.BackupRoot, "tmp-"+time.Now().UTC().Format("20060102T150405.000000000"))
	var moved [][2]string
	quarantineOwned := false
	undo := func() error {
		for i := len(moved) - 1; i >= 0; i-- {
			if err := os.Rename(moved[i][1], moved[i][0]); err != nil {
				return err
			}
		}
		if quarantineOwned {
			return removeOwnedDir(quarantine)
		}
		return nil
	}
	for _, ent := range entries {
		low := strings.ToLower(ent.Name())
		if strings.HasSuffix(low, ".tmp") && strings.HasPrefix(low, "tbd") {
			fp := filepath.Join(p.InstallDir, ent.Name())
			if hasReparseAncestor(fp) {
				return undo, fmt.Errorf("refusing reparse tmp file: %s", fp)
			}
			if len(moved) == 0 {
				if err := writeOwnerMarker(quarantine); err != nil {
					return undo, err
				}
				quarantineOwned = true
			}
			dst := filepath.Join(quarantine, ent.Name())
			if err := os.Rename(fp, dst); err != nil {
				return undo, err
			}
			moved = append(moved, [2]string{fp, dst})
		}
	}
	if len(moved) == 0 {
		return nil, nil
	}
	return undo, nil
}

// --- staging + promotion (product_root aware) + rollback ------------------

func (*windowsExecutor) StagePayload(p ExecuteParams, stagingDir string, bundle *BoundBundle) (UndoFunc, error) {
	undo := func() error { return removeOwnedDir(stagingDir) }
	if !IsNativeBundleFilename(p.PayloadPath) {
		return nil, fmt.Errorf("native payload must be a .zip bundle, not %s", p.PayloadPath)
	}
	if err := ensureManagedRoots(p); err != nil {
		return nil, err
	}
	if bundle == nil || bundle.Manifest == nil || len(bundle.PayloadBytes) == 0 {
		return nil, fmt.Errorf("staging requires exact bound bundle bytes")
	}
	if _, err := os.Stat(stagingDir); err == nil {
		if err := removeOwnedDir(stagingDir); err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		return nil, err
	}
	if err := writeOwnerMarker(stagingDir); err != nil {
		return undo, err
	}
	if err := restrictACL(stagingDir); err != nil {
		return undo, err
	}
	if err := ExtractZipBytesSafe(bundle.PayloadBytes, stagingDir); err != nil {
		return undo, err
	}
	if err := VerifyExtractedBundle(stagingDir, bundle.Manifest); err != nil {
		return undo, err
	}
	return undo, nil
}

func (*windowsExecutor) PromoteFiles(p ExecuteParams, stagingDir string, m *BundleManifest) (UndoFunc, error) {
	if err := ensureSafeDir(p.InstallDir); err != nil {
		return nil, err
	}
	if isReparsePoint(p.InstallDir) {
		return nil, fmt.Errorf("install dir is a reparse point; refusing to promote")
	}
	src, err := PromoteSourceDir(stagingDir, m)
	if err != nil {
		return nil, err
	}
	// Same-volume requirement for atomic rename.
	if !sameVolume(src, p.InstallDir) || !sameVolume(p.InstallDir, p.BackupRoot) {
		return nil, fmt.Errorf("staging/backup/install must share a volume for atomic promotion")
	}
	backup := filepath.Join(p.BackupRoot, "install-"+time.Now().UTC().Format("20060102T150405"))
	if err := os.MkdirAll(p.BackupRoot, 0o700); err != nil {
		return nil, err
	}
	if err := writeOwnerMarker(p.BackupRoot); err != nil {
		return nil, err
	}
	hadInstall := false
	if _, err := os.Stat(p.InstallDir); err == nil {
		hadInstall = true
		if err := os.Rename(p.InstallDir, backup); err != nil {
			return nil, err
		}
	}
	if err := os.Rename(src, p.InstallDir); err != nil {
		if hadInstall {
			if restoreErr := os.Rename(backup, p.InstallDir); restoreErr != nil {
				return func() error { return os.Rename(backup, p.InstallDir) },
					fmt.Errorf("promotion failed: %v; immediate restore failed: %w", err, restoreErr)
			}
		}
		return nil, err
	}
	undo := func() error {
		if err := writeOwnerMarker(p.InstallDir); err != nil {
			return err
		}
		if err := removeOwnedDir(p.InstallDir); err != nil {
			return err
		}
		if hadInstall {
			return os.Rename(backup, p.InstallDir)
		}
		return nil
	}
	return undo, nil
}

// --- one bounded, self-deleting boot retry (#4) ----------------------------

func (*windowsExecutor) ScheduleBootRetry(p ExecuteParams) (UndoFunc, error) {
	if strings.TrimSpace(p.BootRetryCmd) == "" {
		return nil, fmt.Errorf("empty boot-retry command")
	}
	rp, err := RetryStatePath(p.RetryRoot, p.Component)
	if err != nil {
		return nil, err
	}
	schtasks := system32("schtasks.exe")
	existed, owned, qerr := queryRetryTask()
	if qerr != nil {
		return nil, qerr
	}
	if existed && !owned {
		return nil, fmt.Errorf("refusing to replace non-owned TechiRSBootRetry task")
	}
	priorState, readErr := os.ReadFile(rp)
	stateExisted := readErr == nil
	if readErr != nil && !os.IsNotExist(readErr) {
		return nil, readErr
	}
	created := false
	deletedExisting := false
	undo := func() error {
		if created {
			if err := runHidden(schtasks, "/Delete", "/F", "/TN", "TechiRSBootRetry"); err != nil {
				return err
			}
		}
		if deletedExisting {
			if err := runHidden(schtasks, "/Create", "/RU", "SYSTEM", "/SC", "ONSTART", "/TN", "TechiRSBootRetry", "/TR", p.BootRetryCmd); err != nil {
				return err
			}
		}
		if stateExisted {
			return os.WriteFile(rp, priorState, 0o600)
		}
		return ClearRetryState(rp)
	}
	state, err := InitializeRetryState(rp, p.Component, p.ExpectedVersion)
	if err != nil {
		return undo, err
	}
	if state.Exhausted() {
		// Budget spent: self-delete the task + clear state, never loop.
		if existed {
			if err := runHidden(schtasks, "/Delete", "/F", "/TN", "TechiRSBootRetry"); err != nil {
				return undo, err
			}
			deletedExisting = true
		}
		if err := ClearRetryState(rp); err != nil {
			return undo, err
		}
		return nil, fmt.Errorf("boot retry budget exhausted; task self-cleaned")
	}
	if !existed {
		if err := runHidden(schtasks, "/Create", "/RU", "SYSTEM", "/SC", "ONSTART",
			"/TN", "TechiRSBootRetry", "/TR", p.BootRetryCmd); err != nil {
			return undo, err
		}
		created = true
	}
	return undo, nil
}

// --- final validation (#7) -------------------------------------------------

func (e *windowsExecutor) ValidateFinal(p ExecuteParams, m *BundleManifest) error {
	if m == nil {
		return fmt.Errorf("final validation requires a bound manifest")
	}
	// 1) Install dir matches the manifest file set exactly (hash+size, no extras).
	if err := VerifyInstallDirAgainstManifest(p.InstallDir, m); err != nil {
		return err
	}
	// 2) Entrypoint exists, version matches target.
	exe := filepath.Join(p.InstallDir, filepath.FromSlash(m.EntrypointUnderRoot()))
	if err := ensureSafeExe(exe); err != nil {
		return err
	}
	if v := fileVersion(exe); v == "" || CompareVersions(v, p.ExpectedVersion) != 0 {
		return fmt.Errorf("entrypoint version %s != target %s", v, p.ExpectedVersion)
	}
	// 3) Service exists, RUNNING, exact binary path + arguments.
	snap := queryServiceSnapshot(p.ServiceName)
	if !snap.Exists {
		return fmt.Errorf("service %s missing after recovery", p.ServiceName)
	}
	if !snap.Running {
		return fmt.Errorf("service %s not RUNNING", p.ServiceName)
	}
	if !strings.EqualFold(filepath.Clean(snap.BinaryPath), filepath.Clean(exe)) {
		return fmt.Errorf("service image path %q != expected %q", snap.BinaryPath, exe)
	}
	if !argsEqual(snap.Arguments, m.ServiceArguments) {
		return fmt.Errorf("service arguments %v != manifest %v", snap.Arguments, m.ServiceArguments)
	}
	if snap.ProcessID == 0 {
		return fmt.Errorf("running service has no process id")
	}
	if image, err := imagePathForPID(snap.ProcessID); err != nil || !strings.EqualFold(filepath.Clean(image), filepath.Clean(exe)) {
		return fmt.Errorf("service pid %d image %q does not match %q: %v", snap.ProcessID, image, exe, err)
	}
	// 4) No leftover TBD*.tmp in the managed dir.
	entries, err := os.ReadDir(p.InstallDir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		low := strings.ToLower(e.Name())
		if strings.HasPrefix(low, "tbd") && strings.HasSuffix(low, ".tmp") {
			return fmt.Errorf("leftover %s in install dir", e.Name())
		}
	}
	// 5) An owned boot retry self-cleans after success. Never delete a task whose
	// action does not carry our ownership marker, and verify deletion.
	if exists, owned, err := queryRetryTask(); err != nil {
		return err
	} else if exists && !owned {
		return fmt.Errorf("TechiRSBootRetry exists but is not TECHI-owned")
	} else if exists {
		if err := runHidden(system32("schtasks.exe"), "/Delete", "/F", "/TN", "TechiRSBootRetry"); err != nil {
			return err
		}
		if still, _, err := queryRetryTask(); err != nil || still {
			return fmt.Errorf("owned retry task did not self-clean: %v", err)
		}
	}
	if rp, err := RetryStatePath(p.RetryRoot, p.Component); err != nil {
		return err
	} else if err := ClearRetryState(rp); err != nil {
		return err
	}
	// 6) Config/identity still present (where observable).
	for _, saved := range e.preserved {
		got, err := HashFileSHA256(saved.path)
		if err != nil || !strings.EqualFold(got, saved.sha256) {
			return fmt.Errorf("preserved config hash mismatch after recovery: %s", saved.path)
		}
		info, err := os.Stat(saved.path)
		if err != nil || info.Mode().Perm() != saved.mode || !info.ModTime().Equal(saved.mtime) {
			return fmt.Errorf("preserved config metadata mismatch after recovery: %s", saved.path)
		}
		if sddl, err := fileSecurityDescriptor(saved.path); err != nil || !preservedSecurityMatches(saved.sddl, sddl, saved.ownerFallback, saved.groupFallback) {
			return fmt.Errorf("preserved config ACL/owner mismatch after recovery: %s", saved.path)
		}
	}
	return nil
}

// --- live observation (#8) -------------------------------------------------
// implemented in executor_windows_observe.go

// ===== helpers =============================================================

func system32(name string) string {
	return filepath.Join(os.Getenv("SystemRoot"), "System32", name)
}

func queryServiceSnapshot(name string) ServiceSnapshot {
	s, _ := captureServiceSnapshot(name)
	return s
}

func captureServiceSnapshot(name string) (ServiceSnapshot, error) {
	var s ServiceSnapshot
	m, err := mgr.Connect()
	if err != nil {
		return s, err
	}
	defer m.Disconnect()
	svcH, err := m.OpenService(name)
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return s, nil
		}
		return s, err
	}
	defer svcH.Close()
	s.Exists = true
	if cfg, err := svcH.Config(); err == nil {
		exe, args := parseServiceBinPath(cfg.BinaryPathName)
		s.BinaryPath = exe
		s.Arguments = args
		s.StartType = startTypeName(cfg.StartType)
		s.Account = cfg.ServiceStartName
	} else {
		return s, err
	}
	if st, err := svcH.Query(); err == nil {
		s.Running = st.State == svc.Running
		s.ProcessID = st.ProcessId
	} else {
		return s, err
	}
	return s, nil
}

func startTypeName(t uint32) string {
	switch t {
	case mgr.StartAutomatic:
		return "auto"
	case mgr.StartManual:
		return "manual"
	case mgr.StartDisabled:
		return "disabled"
	default:
		return "unknown"
	}
}

// parseServiceBinPath splits a service BinaryPathName into the EXE path and its
// arguments, honouring a leading quoted path.
func parseServiceBinPath(bp string) (string, []string) {
	bp = strings.TrimSpace(bp)
	if bp == "" {
		return "", nil
	}
	if strings.HasPrefix(bp, `"`) {
		if end := strings.Index(bp[1:], `"`); end >= 0 {
			exe := bp[1 : end+1]
			rest := strings.TrimSpace(bp[end+2:])
			return exe, splitArgs(rest)
		}
	}
	parts := strings.Fields(bp)
	if len(parts) == 0 {
		return "", nil
	}
	return parts[0], parts[1:]
}

func splitArgs(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return strings.Fields(s)
}

func argsEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !strings.EqualFold(a[i], b[i]) {
			return false
		}
	}
	return true
}

func buildBinPath(exe string, args []string) string {
	bp := `"` + exe + `"`
	for _, a := range args {
		bp += " " + a
	}
	return bp
}

func scCreate(name, exe string, args []string) error {
	sc := system32("sc.exe")
	binPath := buildBinPath(exe, args)
	if err := runHidden(sc, "create", name, "binPath=", binPath, "start=", "auto",
		"DisplayName=", name); err != nil {
		return err
	}
	return runHidden(sc, "failure", name, "reset=", "86400",
		"actions=", "restart/15000/restart/15000/restart/60000")
}

func scReconfigure(name, exe string, args []string) error {
	sc := system32("sc.exe")
	binPath := buildBinPath(exe, args)
	return runHidden(sc, "config", name, "binPath=", binPath, "start=", "auto")
}

func stopServiceByName(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return nil
		}
		return err
	}
	defer s.Close()
	if st, err := s.Query(); err == nil && st.State == svc.Stopped {
		return nil
	}
	if _, err := s.Control(svc.Stop); err != nil {
		if !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
			return err
		}
	}
	return waitServiceState(s, svc.Stopped, 30*time.Second)
}

func startServiceByName(name string) error {
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
	if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return err
	}
	return waitServiceState(s, svc.Running, 30*time.Second)
}

func deleteServiceByName(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return nil
		}
		return err
	}
	if err := s.Delete(); err != nil {
		s.Close()
		return err
	}
	if err := s.Close(); err != nil {
		return err
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		probe, openErr := m.OpenService(name)
		if openErr != nil {
			if errors.Is(openErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
				return nil
			}
			return openErr
		}
		probe.Close()
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("service %s remained marked for deletion", name)
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

func queryTrayTask(taskName string) (exists, enabled, running bool) {
	if strings.TrimSpace(taskName) == "" {
		return false, false, false
	}
	out, err := runHiddenOut(system32("schtasks.exe"), "/Query", "/TN", taskName, "/V", "/FO", "LIST")
	if err != nil {
		return false, false, false
	}
	exists = true
	low := strings.ToLower(out)
	enabled = !strings.Contains(low, "disabled")
	running = strings.Contains(low, "running")
	return exists, enabled, running
}

func queryRetryTask() (exists, owned bool, err error) {
	out, qerr := runHiddenOut(system32("schtasks.exe"), "/Query", "/TN", "TechiRSBootRetry", "/XML")
	if qerr != nil {
		low := strings.ToLower(qerr.Error())
		if strings.Contains(low, "cannot find") || strings.Contains(low, "does not exist") {
			return false, false, nil
		}
		return false, false, qerr
	}
	low := strings.ToLower(out)
	return true, strings.Contains(low, "--retry-owner") && strings.Contains(low, "techi-bootstrap"), nil
}

// --- process image path via handle ----------------------------------------

func fullImagePathFromHandle(h windows.Handle) (string, error) {
	buf := make([]uint16, windows.MAX_PATH)
	for {
		size := uint32(len(buf))
		err := windows.QueryFullProcessImageName(h, 0, &buf[0], &size)
		if err == nil {
			return windows.UTF16ToString(buf[:size]), nil
		}
		if err == windows.ERROR_INSUFFICIENT_BUFFER && len(buf) < 32768 {
			buf = make([]uint16, len(buf)*2)
			continue
		}
		return "", err
	}
}

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
		h, oerr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
		if oerr != nil {
			continue
		}
		full, ferr := fullImagePathFromHandle(h)
		windows.CloseHandle(h)
		if ferr == nil && strings.EqualFold(full, target) {
			pids = append(pids, pid)
		}
	}
	return pids, nil
}

func imagePathForPID(pid uint32) (string, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	return fullImagePathFromHandle(h)
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
	if hasReparseAncestor(abs) {
		return fmt.Errorf("exe path or ancestor is a reparse point: %s", abs)
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
	if hasReparseAncestor(abs) {
		return fmt.Errorf("directory or ancestor is a reparse point: %s", abs)
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
	bp, _ := parseServiceBinPath(binaryPathName)
	a, _ := filepath.Abs(bp)
	b, _ := filepath.Abs(expectedExe)
	return strings.EqualFold(a, b)
}

func sameVolume(a, b string) bool {
	va := strings.ToUpper(filepath.VolumeName(filepath.Clean(a)))
	vb := strings.ToUpper(filepath.VolumeName(filepath.Clean(b)))
	if va == "" || vb == "" {
		return false
	}
	return va == vb
}

func restorableServiceAccount(account string) bool {
	a := strings.ToLower(strings.TrimSpace(account))
	return a == "" || a == "localsystem" || a == `nt authority\system` ||
		a == `nt authority\localservice` || a == `nt authority\networkservice`
}

func restoreServiceSnapshot(name string, snap ServiceSnapshot) error {
	if !snap.Exists {
		return deleteServiceByName(name)
	}
	if !restorableServiceAccount(snap.Account) {
		return fmt.Errorf("cannot restore service account %q without its credential", snap.Account)
	}
	if err := stopServiceByName(name); err != nil {
		return err
	}
	if err := deleteServiceByName(name); err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	cfg := mgr.Config{
		StartType:        startTypeValue(snap.StartType),
		DisplayName:      name,
		ServiceStartName: snap.Account,
	}
	s, err := m.CreateService(name, snap.BinaryPath, cfg, snap.Arguments...)
	if err != nil {
		return err
	}
	s.Close()
	if snap.Running {
		return startServiceByName(name)
	}
	return nil
}

func restoreExistingServiceConfig(name string, snap ServiceSnapshot) error {
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
	cfg, err := s.Config()
	if err != nil {
		return err
	}
	cfg.BinaryPathName = buildBinPath(snap.BinaryPath, snap.Arguments)
	cfg.StartType = startTypeValue(snap.StartType)
	return s.UpdateConfig(cfg)
}

func startTypeValue(name string) uint32 {
	switch strings.ToLower(name) {
	case "auto":
		return mgr.StartAutomatic
	case "disabled":
		return mgr.StartDisabled
	default:
		return mgr.StartManual
	}
}

func writeOwnerMarker(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if hasReparseAncestor(dir) {
		return fmt.Errorf("refusing owner marker for reparse directory: %s", dir)
	}
	marker := dir + ownerMarkerName
	f, err := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		if _, err = f.Write([]byte(retryStateOwner + "\n")); err != nil {
			f.Close()
			_ = os.Remove(marker)
			return err
		}
		return f.Close()
	}
	if !os.IsExist(err) {
		return err
	}
	info, statErr := os.Lstat(marker)
	if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("unsafe owner marker: %s", marker)
	}
	data, readErr := os.ReadFile(marker)
	if readErr != nil || strings.TrimSpace(string(data)) != retryStateOwner {
		return fmt.Errorf("owner marker collision: %s", marker)
	}
	return nil
}

// removeOwnedDir refuses to delete a directory that does not carry the TECHI
// ownership marker (#9): we never RemoveAll an unmarked directory.
func removeOwnedDir(dir string) error {
	marker := dir + ownerMarkerName
	info, statErr := os.Lstat(marker)
	if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || hasReparseAncestor(dir) {
		return fmt.Errorf("refusing to remove unsafe marked dir: %s", dir)
	}
	data, err := os.ReadFile(marker)
	if err != nil || strings.TrimSpace(string(data)) != retryStateOwner {
		return fmt.Errorf("refusing to remove unmarked dir: %s", dir)
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return os.Remove(marker)
}

func copyOneFile(src, dst string) error {
	if hasReparseAncestor(src) {
		return fmt.Errorf("refusing reparse source: %s", src)
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	if hasReparseAncestor(filepath.Dir(dst)) {
		return fmt.Errorf("refusing reparse destination: %s", dst)
	}
	if info, err := os.Lstat(dst); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing unsafe destination: %s", dst)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.WriteFile(dst, data, 0o600)
}

const configSecurityInformation = windows.OWNER_SECURITY_INFORMATION |
	windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION

type configSecurityRestoreResult struct {
	ownerFallback bool
	groupFallback bool
}

var setNamedSecurityInfoFunc = windows.SetNamedSecurityInfo

func fileSecurityDescriptor(path string) (string, error) {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, configSecurityInformation)
	if err != nil {
		return "", err
	}
	sddl := sd.String()
	if sddl == "" {
		return "", fmt.Errorf("empty security descriptor for %s", path)
	}
	return sddl, nil
}

func restoreFileSecurityDescriptor(path, sddl string) (configSecurityRestoreResult, error) {
	var result configSecurityRestoreResult
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return result, err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return result, err
	}
	group, _, err := sd.Group()
	if err != nil {
		return result, err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return result, err
	}
	if err := setNamedSecurityInfoFunc(path, windows.SE_FILE_OBJECT, configSecurityInformation, owner, group, dacl, nil); err == nil {
		return result, nil
	} else if !isInvalidOwnerAssignment(err) {
		return result, err
	}
	result.ownerFallback = true
	if err := setNamedSecurityInfoFunc(path, windows.SE_FILE_OBJECT, windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION, nil, group, dacl, nil); err == nil {
		return result, nil
	} else if !isInvalidOwnerAssignment(err) {
		return result, err
	}
	result.groupFallback = true
	if err := setNamedSecurityInfoFunc(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return result, err
	}
	return result, nil
}

func isInvalidOwnerAssignment(err error) bool {
	if errors.Is(err, windows.ERROR_INVALID_OWNER) {
		return true
	}
	return strings.Contains(err.Error(), "This security ID may not be assigned as the owner of this object")
}

func preservedSecurityMatches(want, got string, ownerFallback, groupFallback bool) bool {
	if !ownerFallback && !groupFallback {
		return want == got
	}
	if sddlSection(want, "D:") == "" || sddlSection(want, "D:") != sddlSection(got, "D:") {
		return false
	}
	if !groupFallback && sddlSection(want, "G:") != sddlSection(got, "G:") {
		return false
	}
	return true
}

func sddlSection(sddl, prefix string) string {
	start := strings.Index(sddl, prefix)
	if start < 0 {
		return ""
	}
	end := len(sddl)
	for _, marker := range []string{"O:", "G:", "D:", "S:"} {
		if marker == prefix {
			continue
		}
		if idx := strings.Index(sddl[start+len(prefix):], marker); idx >= 0 && start+len(prefix)+idx < end {
			end = start + len(prefix) + idx
		}
	}
	return sddl[start:end]
}

var approvedConfigNames = map[string]bool{
	"agent.config.json":         true,
	"techi remote support.toml": true, "techi remote support2.toml": true,
	"techi remote support_local.toml": true, "techi remote support2_local.toml": true,
	"rustdesk.toml": true, "rustdesk2.toml": true,
}

func validateApprovedConfigPath(path string) error {
	clean := filepath.Clean(path)
	if !approvedConfigNames[strings.ToLower(filepath.Base(clean))] {
		return fmt.Errorf("config filename is not approved: %s", path)
	}
	if strings.EqualFold(filepath.Base(clean), "agent.config.json") {
		if normalizeWindowsPath(clean) != normalizeWindowsPath(`C:\ProgramData\TechiAgent\agent.config.json`) {
			return fmt.Errorf("agent config path outside approved root: %s", path)
		}
		return nil
	}
	root := normalizeWindowsPath(filepath.Dir(clean))
	root = strings.TrimSuffix(root, `\config`)
	approved := root == normalizeWindowsPath(`C:\ProgramData\TECHI Remote Support`) ||
		root == normalizeWindowsPath(`C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\TECHI Remote Support`) ||
		root == normalizeWindowsPath(`C:\Windows\ServiceProfiles\NetworkService\AppData\Roaming\TECHI Remote Support`) ||
		root == normalizeWindowsPath(`C:\Windows\System32\config\systemprofile\AppData\Roaming\TECHI Remote Support`) ||
		approvedInteractiveUserRoot(root)
	if !approved {
		return fmt.Errorf("config path outside approved roots: %s", path)
	}
	return nil
}

func approvedInteractiveUserRoot(root string) bool {
	if !strings.HasPrefix(root, `c:\users\`) {
		return false
	}
	rest := strings.TrimPrefix(root, `c:\users\`)
	parts := strings.Split(rest, `\`)
	if len(parts) != 4 || skippedWindowsProfile(parts[0]) {
		return false
	}
	return strings.EqualFold(parts[1], "appdata") &&
		(strings.EqualFold(parts[2], "roaming") || strings.EqualFold(parts[2], "local")) &&
		strings.EqualFold(parts[3], "techi remote support")
}
func effectiveConfigPaths(p ExecuteParams) []string {
	if len(p.ConfigPaths) > 0 {
		return append([]string(nil), p.ConfigPaths...)
	}
	manifest := &BundleManifest{
		ConfigPathsToPreserve: append([]string(nil), requiredPreserveRoots...),
		NeverOverwrite:        []string{"*.toml", "agent.config.json"},
	}
	paths, err := ResolveManifestConfigPaths(manifest)
	if err != nil {
		return nil
	}
	return paths
}
func hasReparseAncestor(path string) bool {
	cur := filepath.Clean(path)
	for {
		if isReparsePoint(cur) {
			return true
		}
		parent := filepath.Dir(cur)
		if parent == cur || filepath.VolumeName(cur) == cur {
			return false
		}
		cur = parent
	}
}
