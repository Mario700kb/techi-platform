package main

import (
    "fmt"
    "os"
    "os/user"
    "runtime"
)

type Inventory struct {
    Hostname    string `json:"hostname"`
    CurrentUser string `json:"current_user"`
    Domain      string `json:"domain"`
    LocalIP     string `json:"local_ip"`
    PublicIP    string `json:"public_ip"`
    OSName      string `json:"os_name"`
    OSVersion   string `json:"os_version"`
    Platform    string `json:"platform"`
    CPU         string `json:"cpu"`
    RAM         string `json:"ram"`
    Storage     string `json:"storage"`
}

func collectInventory(cfg *Config) (*Inventory, error) {
    hostname, err := os.Hostname()
    if err != nil {
        hostname = ""
    }

    currentUser := buildCurrentUser()
    domain := buildDomain()
    localIP := getLocalIP()
    publicIP := getPublicIP(cfg.PublicIPService, cfg.TimeoutSeconds)
    osName, osVersion := buildOSInfo()
    cpuInfo := buildCPUInfo()
    ramInfo := buildRAMInfo()
    storageInfo := buildStorageInfo()

    inventory := &Inventory{
        Hostname:    hostname,
        CurrentUser: currentUser,
        Domain:      domain,
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

func buildCurrentUser() string {
    if userInfo, err := user.Current(); err == nil {
        return userInfo.Username
    }
    return ""
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
