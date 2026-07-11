package main

import (
	"os"
	"strings"
	"testing"
)

func TestWindowsServiceInventoryUsesSCMNotWMIC(t *testing.T) {
	data, err := os.ReadFile("services_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	s := strings.ToLower(string(data))
	if !strings.Contains(s, "mgr.connect") || !strings.Contains(s, "listservices") {
		t.Fatal("SCM API contract missing")
	}
	if strings.Contains(s, "wmic") {
		t.Fatal("Windows service inventory must not invoke WMIC")
	}
}

func TestWindowsSoftwareInventoryIsMachineWide(t *testing.T) {
	data, err := os.ReadFile("processes.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	if strings.Contains(s, `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`) {
		t.Fatal("LocalSystem HKCU must not be queried")
	}
	for _, key := range []string{`HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`, `HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`} {
		if !strings.Contains(s, key) {
			t.Fatalf("machine-wide key missing: %s", key)
		}
	}
}
