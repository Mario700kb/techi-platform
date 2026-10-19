//go:build windows

package main

import (
	"strings"
	"testing"
)

func TestTheHealthScriptReadsOnlyCriticalErrorAndWarningEvents(t *testing.T) {
	// NTFS 98 is written at every mount as Information ("is healthy").
	if !strings.Contains(windowsDeviceHealthScript, "Level = @(1, 2, 3)") ||
		!strings.Contains(windowsDeviceHealthScript, "win_level = [int]$e.Level") {
		t.Fatal("the health script must filter System events by level and send it")
	}
}
