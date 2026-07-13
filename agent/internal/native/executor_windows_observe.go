//go:build windows

package native

import (
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// ObserveRemoteSupport probes the reduced Remote Support state on a real device
// so the standalone bootstrap can plan without an --observation fixture. It
// fills the fields it can detect natively and leaves the rest at their safe
// zero value; anything it cannot determine defaults to the non-destructive
// interpretation. It never mutates.
func ObserveRemoteSupport(p ExecuteParams) (RSObservation, error) {
	var obs RSObservation

	if fi, err := os.Stat(p.ExpectedExePath); err == nil && !fi.IsDir() {
		obs.ExeExists = true
		obs.ExeVersion = fileVersion(p.ExpectedExePath)
	}

	if m, err := mgr.Connect(); err == nil {
		defer m.Disconnect()
		if s, err := m.OpenService(p.ServiceName); err == nil {
			obs.ServiceExists = true
			if st, err := s.Query(); err == nil {
				obs.ServiceRunning = st.State == svc.Running
			}
			if cfg, err := s.Config(); err == nil {
				obs.ServiceImageOK = imagePathMatches(cfg.BinaryPathName, p.ExpectedExePath)
			}
			s.Close()
		}
	}

	obs.PendingReboot = pendingRebootDetected()
	obs.StaleTmpFiles = hasStaleTmp(p.InstallDir)
	obs.OldUninstallReg = hasLegacyRustDeskUninstall()
	obs.LegacyCombined = obs.OldUninstallReg

	for _, cp := range p.ConfigPaths {
		if _, err := os.Stat(cp); err == nil {
			obs.ConfigPresent = true
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
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}
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
	_ = p
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
