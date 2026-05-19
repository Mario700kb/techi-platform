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

type Inventory struct {
	Hostname         string `json:"hostname"`
	CurrentUser      string `json:"current_user"`
	UserSource       string `json:"user_source"`
	UserSessionState string `json:"user_session_state"`
	Domain           string `json:"domain"`
	LocalIP          string `json:"local_ip"`
	PublicIP         string `json:"public_ip"`
	OSName           string `json:"os_name"`
	OSVersion        string `json:"os_version"`
	Platform         string `json:"platform"`
	CPU              string `json:"cpu"`
	RAM              string `json:"ram"`
	Storage          string `json:"storage"`
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
	osName, osVersion := buildOSInfo()
	cpuInfo := buildCPUInfo()
	ramInfo := buildRAMInfo()
	storageInfo := buildStorageInfo()

	inventory := &Inventory{
		Hostname:         hostname,
		CurrentUser:      userSession.CurrentUser,
		UserSource:       userSession.UserSource,
		UserSessionState: userSession.UserSessionState,
		Domain:           domain,
		LocalIP:     localIP,
		PublicIP:    publicIP,
		OSName:      osName,
		OSVersion:   osVersion,
		Platform:    runtime.GOOS,
		CPU:         cpuInfo,
		RAM:         ramInfo,
		Storage:     storageInfo,
	}

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

func buildOSInfo() (string, string) {
	osName := runtime.GOOS
	osVersion := os.Getenv("OS")
	if osVersion == "" {
		osVersion = runtime.GOARCH
	}
	return osName, osVersion
}

func buildCPUInfo() string {
	if cpu := os.Getenv("PROCESSOR_IDENTIFIER"); cpu != "" {
		return cpu
	}
	return fmt.Sprintf("%d logical cores", runtime.NumCPU())
}
