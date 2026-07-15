//go:build windows

package main

import (
	"strings"
	"testing"
)

func TestRustDeskUILaunchTaskUsesNormalExecutable(t *testing.T) {
	xml := rsUITaskXML(`C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`)

	if !strings.Contains(xml, `<Command>C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe</Command>`) {
		t.Fatalf("UI launch task must target the normal Remote Support executable, got:\n%s", xml)
	}
	if strings.Contains(xml, "--tray") {
		t.Fatalf("UI launch task must not start the tray helper:\n%s", xml)
	}
}

func TestRustDeskApprovedUIPathsDeduplicatesInstallPath(t *testing.T) {
	paths := rustDeskApprovedUIPaths(rustdeskDefaultInstallPath)
	count := 0
	for _, path := range paths {
		if strings.EqualFold(path, rustdeskDefaultInstallPath) {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected default install path once, got %d in %v", count, paths)
	}
}
