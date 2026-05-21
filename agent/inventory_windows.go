//go:build windows

package main

import (
	"encoding/json"
	"os/exec"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

var (
	modWtsapi32                      = syscall.NewLazyDLL("wtsapi32.dll")
	modKernel32                      = syscall.NewLazyDLL("kernel32.dll")
	procWTSQuerySessionInformationW  = modWtsapi32.NewProc("WTSQuerySessionInformationW")
	procWTSFreeMemory                = modWtsapi32.NewProc("WTSFreeMemory")
	procWTSGetActiveConsoleSessionId = modKernel32.NewProc("WTSGetActiveConsoleSessionId")
)

const (
	wtsUserName       = 5 // WTSUserName
	wtsWinStationName = 6 // WTSWinStationName
	wtsConnectState   = 8 // WTSConnectState
	wtsActive         = 0 // WTSActive
	wtsDisconnected   = 4 // WTSDisconnected
)

type windowsCIMOperatingSystem struct {
	Caption     string `json:"Caption"`
	Version     string `json:"Version"`
	ProductType int    `json:"ProductType"`
}

func collectOSInfo() OSInfo {
	info := collectWindowsOSInfoFromCIM()
	if info.Caption == "" || info.Build == "" || info.WindowsProductType == 0 {
		fallback := collectWindowsOSInfoFromRegistry()
		if info.Caption == "" {
			info.Caption = fallback.Caption
		}
		if info.Build == "" {
			info.Build = fallback.Build
		}
		if info.WindowsProductType == 0 {
			info.WindowsProductType = fallback.WindowsProductType
		}
	}
	if info.Name == "" {
		info.Name = "windows"
	}
	if info.Version == "" {
		info.Version = info.Caption
	}
	if info.Version == "" {
		info.Version = info.Build
	}
	return info
}

func collectWindowsOSInfoFromCIM() OSInfo {
	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		"Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 Caption,Version,ProductType | ConvertTo-Json -Compress",
	)
	output, err := cmd.Output()
	if err != nil {
		return OSInfo{Name: "windows"}
	}
	var cim windowsCIMOperatingSystem
	if err := json.Unmarshal(output, &cim); err != nil {
		return OSInfo{Name: "windows"}
	}
	caption := strings.TrimSpace(cim.Caption)
	build := strings.TrimSpace(cim.Version)
	return OSInfo{
		Name:               "windows",
		Version:            firstNonEmpty(caption, build),
		Caption:            caption,
		Build:              build,
		WindowsProductType: cim.ProductType,
	}
}

func collectWindowsOSInfoFromRegistry() OSInfo {
	info := OSInfo{Name: "windows"}
	const currentVersionKey = `SOFTWARE\Microsoft\Windows NT\CurrentVersion`
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, currentVersionKey, registry.QUERY_VALUE)
	if err == nil {
		defer k.Close()
		productName, _, _ := k.GetStringValue("ProductName")
		displayVersion, _, _ := k.GetStringValue("DisplayVersion")
		currentBuild, _, _ := k.GetStringValue("CurrentBuild")
		info.Caption = strings.TrimSpace(productName)
		info.Build = firstNonEmpty(strings.TrimSpace(displayVersion), strings.TrimSpace(currentBuild))
		info.Version = firstNonEmpty(info.Caption, info.Build)
	}

	const productOptionsKey = `SYSTEM\CurrentControlSet\Control\ProductOptions`
	productOptions, err := registry.OpenKey(registry.LOCAL_MACHINE, productOptionsKey, registry.QUERY_VALUE)
	if err == nil {
		defer productOptions.Close()
		productType, _, _ := productOptions.GetStringValue("ProductType")
		switch strings.ToLower(strings.TrimSpace(productType)) {
		case "winnt":
			info.WindowsProductType = 1
		case "lanmannt":
			info.WindowsProductType = 2
		case "servernt":
			info.WindowsProductType = 3
		}
	}
	return info
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// wtsQueryString calls WTSQuerySessionInformationW for a string info class and returns
// the result, or "" on failure. The caller must not free the buffer.
func wtsQueryString(sessionID uintptr, infoClass uintptr) string {
	var buf uintptr
	var bytesReturned uint32
	ret, _, _ := procWTSQuerySessionInformationW.Call(
		0, // WTS_CURRENT_SERVER_HANDLE
		sessionID,
		infoClass,
		uintptr(unsafe.Pointer(&buf)),
		uintptr(unsafe.Pointer(&bytesReturned)),
	)
	if ret == 0 || buf == 0 {
		return ""
	}
	defer procWTSFreeMemory.Call(buf)
	nChars := bytesReturned / 2
	if nChars == 0 {
		return ""
	}
	return strings.TrimSpace(syscall.UTF16ToString((*[1 << 20]uint16)(unsafe.Pointer(buf))[:nChars]))
}

// wtsQueryConnectState maps the raw WTSConnectState integer to a human-readable string.
func wtsQueryConnectState(sessionID uintptr) string {
	var buf uintptr
	var bytesReturned uint32
	ret, _, _ := procWTSQuerySessionInformationW.Call(
		0,
		sessionID,
		wtsConnectState,
		uintptr(unsafe.Pointer(&buf)),
		uintptr(unsafe.Pointer(&bytesReturned)),
	)
	if ret == 0 || buf == 0 || bytesReturned < 4 {
		return "unknown"
	}
	defer procWTSFreeMemory.Call(buf)
	state := *(*int32)(unsafe.Pointer(buf))
	switch state {
	case wtsActive, 2: // WTSActive, WTSConnected
		return "active"
	case wtsDisconnected: // WTSDisconnected
		return "disconnected"
	default:
		return "unknown"
	}
}

// buildUserSession detects who is logged into the physical console or an RDP session.
// When the agent runs as a Windows Service (session 0), os/user.Current() would return
// the service account. This avoids that by querying WTS for the real interactive user.
func buildUserSession() UserSession {
	noUser := UserSession{
		CurrentUser:      "No interactive user",
		UserSource:       "no_interactive_user",
		UserSessionState: "unknown",
	}

	// Check the physical console session first.
	sessionID, _, _ := procWTSGetActiveConsoleSessionId.Call()
	consoleID := uint32(sessionID)

	if consoleID != ^uint32(0) { // 0xFFFFFFFF = no console session
		name := wtsQueryString(uintptr(consoleID), wtsUserName)
		if name != "" && !isMachineAccount(name) {
			state := wtsQueryConnectState(uintptr(consoleID))
			return UserSession{
				CurrentUser:      name,
				UserSource:       "interactive_console",
				UserSessionState: state,
			}
		}
	}

	// No console user found — try sessions 1-9 looking for an RDP session.
	for id := uint32(1); id <= 9; id++ {
		if id == consoleID {
			continue
		}
		name := wtsQueryString(uintptr(id), wtsUserName)
		if name == "" || isMachineAccount(name) {
			continue
		}
		winStation := strings.ToUpper(wtsQueryString(uintptr(id), wtsWinStationName))
		if !strings.Contains(winStation, "RDP") && !strings.Contains(winStation, "TCPIP") {
			continue
		}
		state := wtsQueryConnectState(uintptr(id))
		return UserSession{
			CurrentUser:      name,
			UserSource:       "rdp_session",
			UserSessionState: state,
		}
	}

	// Step 3: registry fallback — last logged-on user recorded by Windows.
	if user := buildRegistryLastLogonUser(); user != "" {
		return UserSession{
			CurrentUser:      user,
			UserSource:       "registry_last_logon",
			UserSessionState: "unknown",
		}
	}

	return noUser
}

// buildRegistryLastLogonUser reads the last logged-on user from the Windows
// LogonUI registry key, which is updated at lock screen / logon and is readable
// from the LocalSystem context without impersonation.
func buildRegistryLastLogonUser() string {
	const keyPath = `SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\LogonUI`
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, keyPath, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()

	// Prefer SAMUser (DOMAIN\user format), fall back to User, then DisplayName.
	for _, valueName := range []string{"LastLoggedOnSAMUser", "LastLoggedOnUser", "LastLoggedOnDisplayName"} {
		raw, _, err := k.GetStringValue(valueName)
		if err != nil || raw == "" {
			continue
		}
		if norm := normalizeLogonUIValue(raw); norm != "" {
			return norm
		}
	}
	return ""
}
