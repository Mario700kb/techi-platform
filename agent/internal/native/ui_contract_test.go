package native

import (
	"strings"
	"testing"
)

func TestRemoteSupportMainWindowRejectsTrayHelper(t *testing.T) {
	if remoteSupportMainWindowSizeUsable(16, 16) {
		t.Fatal("16x16 tray helper must not satisfy UI validation")
	}
	if !remoteSupportMainWindowSizeUsable(800, 600) {
		t.Fatal("normal main window must satisfy UI validation")
	}
}

func TestRemoteSupportUILaunchTaskRunsNormalExecutableOnce(t *testing.T) {
	xml := remoteSupportUITaskXML(`C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`)
	for _, required := range []string{"TECHI Remote Support.exe", "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>", "S-1-5-32-545"} {
		if !strings.Contains(xml, required) {
			t.Fatalf("UI task XML missing %q", required)
		}
	}
	if strings.Contains(xml, "--tray") || strings.Contains(xml, "--service") {
		t.Fatal("UI launch task must run the normal desktop executable without background-role arguments")
	}
}
