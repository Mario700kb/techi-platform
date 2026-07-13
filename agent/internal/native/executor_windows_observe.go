//go:build windows

package native

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// ObserveRemoteSupport probes the reduced Remote Support state on a real device
// so the standalone bootstrap can plan without an --observation fixture. It
// fills the fields it can detect natively and leaves the rest at their safe
// zero value; anything it cannot determine defaults to the non-destructive
// interpretation. It never mutates.
func ObserveRemoteSupport(p ExecuteParams) (RSObservation, error) {
	var obs RSObservation
	var servicePID uint32

	if fi, err := os.Stat(p.ExpectedExePath); err == nil && !fi.IsDir() {
		obs.ExeExists = true
		obs.ExeVersion = fileVersion(p.ExpectedExePath)
	}

	snapshot, err := captureServiceSnapshot(p.ServiceName)
	if err != nil {
		return obs, fmt.Errorf("observe service: %w", err)
	}
	obs.ServiceExists = snapshot.Exists
	obs.ServiceRunning = snapshot.Running
	obs.ServiceImageOK = snapshot.Exists && equalWindowsPath(snapshot.BinaryPath, p.ExpectedExePath)
	servicePID = snapshot.ProcessID
	_, _, taskRunning := queryTrayTask(p.TrayTaskName)
	obs.TrayRunning = taskRunning

	obs.PendingReboot = pendingRebootDetected()
	obs.StaleTmpFiles = hasStaleTmp(p.InstallDir)
	obs.OldUninstallReg = hasLegacyRustDeskUninstall()
	obs.LegacyCombined = obs.OldUninstallReg

	for _, cp := range effectiveConfigPaths(p) {
		if _, err := os.Stat(cp); err == nil {
			obs.ConfigPresent = true
			break
		}
	}

	// An exact-image process outside the service PID is the tray/runtime process
	// that can hold install files. This is conservative and never matches by
	// process name alone.
	if pids, err := pidsForExactImage(p.ExpectedExePath); err == nil {
		for _, pid := range pids {
			if pid != servicePID {
				obs.TrayRunning = true
				break
			}
		}
	} else {
		return obs, fmt.Errorf("observe exact-image processes: %w", err)
	}
	lockers, err := lockingPIDsUnder(p.InstallDir)
	if err != nil {
		return obs, fmt.Errorf("observe install locks: %w", err)
	}
	for pid := range lockers {
		if pid != 0 && pid != servicePID {
			obs.FilesLocked = true
			break
		}
	}

	if fi, err := os.Stat(p.PayloadPath); err == nil && !fi.IsDir() && fi.Size() > 0 {
		obs.PayloadAvailable = true
		if _, verr := VerifyPayload(p.PayloadPath, p.PayloadSHA); verr == nil {
			obs.PayloadSHAMatch = true
		}
	}
	return obs, nil
}

const (
	rmMaxAppName     = 255
	rmMaxServiceName = 63
	rmSessionKeyLen  = 32
)

type rmUniqueProcess struct {
	ProcessID        uint32
	ProcessStartTime windows.Filetime
}

type rmProcessInfo struct {
	Process          rmUniqueProcess
	AppName          [rmMaxAppName + 1]uint16
	ServiceShortName [rmMaxServiceName + 1]uint16
	ApplicationType  uint32
	AppStatus        uint32
	TSSessionID      uint32
	Restartable      int32
}

var (
	restartManagerDLL   = windows.NewLazySystemDLL("rstrtmgr.dll")
	rmStartSession      = restartManagerDLL.NewProc("RmStartSession")
	rmRegisterResources = restartManagerDLL.NewProc("RmRegisterResources")
	rmGetList           = restartManagerDLL.NewProc("RmGetList")
	rmEndSession        = restartManagerDLL.NewProc("RmEndSession")
)

// lockingPIDsUnder uses Windows Restart Manager's read-only resource query to
// identify processes holding any installed runtime file. The caller excludes
// the known service PID, leaving tray/unrelated lockers without guessing by
// process name.
func lockingPIDsUnder(root string) (result map[uint32]bool, err error) {
	result = map[uint32]bool{}
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return result, nil
	}
	var paths []string
	err = filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.Mode()&os.ModeSymlink != 0 || isReparsePoint(path) {
			return fmt.Errorf("reparse path in install tree: %s", path)
		}
		if info.Mode().IsRegular() {
			paths = append(paths, path)
		}
		return nil
	})
	if err != nil || len(paths) == 0 {
		return result, err
	}

	var handle uint32
	var key [rmSessionKeyLen + 1]uint16
	if ret, _, _ := rmStartSession.Call(uintptr(unsafe.Pointer(&handle)), 0, uintptr(unsafe.Pointer(&key[0]))); ret != 0 {
		return nil, fmt.Errorf("RmStartSession error %d", ret)
	}
	defer func() {
		if ret, _, _ := rmEndSession.Call(uintptr(handle)); ret != 0 && err == nil {
			err = fmt.Errorf("RmEndSession error %d", ret)
		}
	}()

	wide := make([]*uint16, len(paths))
	for i, path := range paths {
		wide[i], err = windows.UTF16PtrFromString(path)
		if err != nil {
			return nil, err
		}
	}
	if ret, _, _ := rmRegisterResources.Call(
		uintptr(handle), uintptr(len(wide)), uintptr(unsafe.Pointer(&wide[0])), 0, 0, 0, 0,
	); ret != 0 {
		return nil, fmt.Errorf("RmRegisterResources error %d", ret)
	}
	var needed, count, reasons uint32
	ret, _, _ := rmGetList.Call(uintptr(handle), uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&count)), 0, uintptr(unsafe.Pointer(&reasons)))
	if ret == 0 && needed == 0 {
		runtime.KeepAlive(wide)
		return result, nil
	}
	if ret != uintptr(windows.ERROR_MORE_DATA) {
		return nil, fmt.Errorf("RmGetList sizing error %d", ret)
	}
	infos := make([]rmProcessInfo, needed)
	count = needed
	ret, _, _ = rmGetList.Call(uintptr(handle), uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&count)), uintptr(unsafe.Pointer(&infos[0])), uintptr(unsafe.Pointer(&reasons)))
	if ret != 0 {
		return nil, fmt.Errorf("RmGetList error %d", ret)
	}
	for i := uint32(0); i < count; i++ {
		result[infos[i].Process.ProcessID] = true
	}
	runtime.KeepAlive(wide)
	return result, nil
}

func hasStaleTmp(installDir string) bool {
	entries, err := os.ReadDir(installDir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		n := strings.ToLower(e.Name())
		if strings.HasPrefix(n, "tbd") && strings.HasSuffix(n, ".tmp") {
			return true
		}
	}
	return false
}

func pendingRebootDetected() bool {
	// PendingFileRenameOperations is the signal MSI uses for the TBD*.tmp
	// replace-on-reboot state at the heart of the incident.
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SYSTEM\CurrentControlSet\Control\Session Manager`, registry.QUERY_VALUE)
	if err == nil {
		defer k.Close()
		if v, _, err := k.GetStringsValue("PendingFileRenameOperations"); err == nil && len(v) > 0 {
			return true
		}
	}
	k2, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`, registry.QUERY_VALUE)
	if err == nil {
		k2.Close()
		return true
	}
	return false
}

func hasLegacyRustDeskUninstall() bool {
	for _, root := range []registry.Key{registry.LOCAL_MACHINE} {
		base := `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
		k, err := registry.OpenKey(root, base, registry.ENUMERATE_SUB_KEYS)
		if err != nil {
			continue
		}
		names, _ := k.ReadSubKeyNames(-1)
		k.Close()
		for _, n := range names {
			ln := strings.ToLower(n)
			if strings.Contains(ln, "rustdesk") {
				return true
			}
		}
	}
	return false
}

// fileVersion reads the FileVersion / ProductVersion from a Windows PE's
// version resource. Returns "" on any failure (the classifier then treats an
// unknown version conservatively). Defensive throughout: no panic on malformed
// resources.
func fileVersion(path string) string {
	var handle windows.Handle
	size, err := windows.GetFileVersionInfoSize(path, &handle)
	if err != nil || size == 0 {
		return ""
	}
	buf := make([]byte, size)
	if err := windows.GetFileVersionInfo(path, 0, size, unsafe.Pointer(&buf[0])); err != nil {
		return ""
	}
	var fixed *windows.VS_FIXEDFILEINFO
	var fixedLen uint32
	if err := windows.VerQueryValue(unsafe.Pointer(&buf[0]), `\`,
		unsafe.Pointer(&fixed), &fixedLen); err != nil || fixed == nil {
		return ""
	}
	// Version is packed as two 32-bit words (MS/LS) of 16-bit fields.
	major := fixed.FileVersionMS >> 16 & 0xffff
	minor := fixed.FileVersionMS & 0xffff
	patch := fixed.FileVersionLS >> 16 & 0xffff
	return itoa(major) + "." + itoa(minor) + "." + itoa(patch)
}

func itoa(v uint32) string {
	if v == 0 {
		return "0"
	}
	var b [12]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	return string(b[i:])
}
