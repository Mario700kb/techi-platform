package main

import (
	"fmt"
	"os"
	"runtime"
)

type UserSession struct {
	CurrentUser      string
	UserSource       string
	UserSessionState string
}

type OSInfo struct {
	Name               string
	Version            string
	Caption            string
	Build              string
	WindowsProductType int
}

type Inventory struct {
	Hostname           string `json:"hostname"`
	CurrentUser        string `json:"current_user"`
	UserSource         string `json:"user_source"`
	UserSessionState   string `json:"user_session_state"`
	Domain             string `json:"domain"`
	LocalIP            string `json:"local_ip"`
	PublicIP           string `json:"public_ip"`
	OSName             string `json:"os_name"`
	OSVersion          string `json:"os_version"`
	OSCaption          string `json:"os_caption,omitempty"`
	OSBuild            string `json:"os_build,omitempty"`
	WindowsProductType int    `json:"windows_product_type,omitempty"`
	Platform           string `json:"platform"`
	CPU                string `json:"cpu"`
	RAM                string `json:"ram"`
	Storage            string `json:"storage"`
	// Platform Expansion additive fields — populated only by platform-aware
	// implementations (Linux+); empty on Windows so its payload is unchanged.
	FQDN          string   `json:"fqdn,omitempty"`
	KernelVersion string   `json:"kernel_version,omitempty"`
	Architecture  string   `json:"architecture,omitempty"`
	MACAddress    string   `json:"mac_address,omitempty"`
	Timezone      string   `json:"timezone,omitempty"`
	LastBootAt    string   `json:"last_boot_at,omitempty"`
	Capabilities  []string `json:"capabilities,omitempty"`
}

func collectInventory(cfg *Config) (*Inventory, error) {
	hostname, err := os.Hostname()
	if err != nil {
		hostname = ""
	}

	userSession := buildUserSession()
	domain := buildDomain()
	localIP := getLocalIP()
	publicIP := getPublicIP(cfg.PublicIPService, cfg.TimeoutSeconds)
	osName, osVersion, osCaption, osBuild, windowsProductType := buildOSInfo()
	cpuInfo := buildCPUInfo()
	ramInfo := buildRAMInfo()
	storageInfo := buildStorageInfo()

	inventory := &Inventory{
		Hostname:           hostname,
		CurrentUser:        userSession.CurrentUser,
		UserSource:         userSession.UserSource,
		UserSessionState:   userSession.UserSessionState,
		Domain:             domain,
		LocalIP:            localIP,
		PublicIP:           publicIP,
		OSName:             osName,
		OSVersion:          osVersion,
		OSCaption:          osCaption,
		OSBuild:            osBuild,
		WindowsProductType: windowsProductType,
		Platform:           runtime.GOOS,
		CPU:                cpuInfo,
		RAM:                ramInfo,
		Storage:            storageInfo,
	}

	// Additive platform facts (empty on Windows/other → payload unchanged).
	// currentPlatform() is the build-tag-selected implementation for the OS this
	// agent was compiled for, so Linux-only inventory is collected only on a real
	// Linux Agent execution path.
	applyExpansionInventory(inventory, currentPlatform())

	return inventory, nil
}

func buildDomain() string {
	if domain := os.Getenv("USERDOMAIN"); domain != "" {
		return domain
	}
	if domain := os.Getenv("LOGONSERVER"); domain != "" {
		return domain
	}
	return ""
}

func buildOSInfo() (string, string, string, string, int) {
	osInfo := collectOSInfo()
	osName := osInfo.Name
	if osName == "" {
		osName = runtime.GOOS
	}
	osVersion := osInfo.Version
	if osVersion == "" {
		osVersion = os.Getenv("OS")
	}
	if osVersion == "" {
		osVersion = runtime.GOARCH
	}
	return osName, osVersion, osInfo.Caption, osInfo.Build, osInfo.WindowsProductType
}

func buildCPUInfo() string {
	if cpu := os.Getenv("PROCESSOR_IDENTIFIER"); cpu != "" {
		return cpu
	}
	return fmt.Sprintf("%d logical cores", runtime.NumCPU())
}
