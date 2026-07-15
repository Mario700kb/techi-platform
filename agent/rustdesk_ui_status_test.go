package main

import "testing"

func TestRustDeskMainWindowSizeRejectsTrayHelper(t *testing.T) {
	if rustDeskMainWindowSizeUsable(16, 16) {
		t.Fatal("16x16 tray/helper window must not satisfy Remote Support UI health")
	}
}

func TestRustDeskMainWindowSizeAcceptsNormalWindow(t *testing.T) {
	if !rustDeskMainWindowSizeUsable(800, 600) {
		t.Fatal("normal desktop window dimensions should satisfy Remote Support UI health")
	}
}

func TestRustDeskUIRuntimeHealthyRequiresMainWindow(t *testing.T) {
	got := classifyRustDeskUIRuntime(true, 1, "running", false)
	if got != rustDeskStatusRunning {
		t.Fatalf("expected healthy running state with valid main window, got %q", got)
	}
}

func TestRustDeskUIRuntimeTrayOnlyForTrayProcessWithoutMainWindow(t *testing.T) {
	got := classifyRustDeskUIRuntime(false, 1, "", false)
	if got != rustDeskStatusTrayOnly {
		t.Fatalf("expected tray_only for process without valid main window, got %q", got)
	}
}

func TestRustDeskUIRuntimeTrayOnlyForServerServiceWithoutMainWindow(t *testing.T) {
	got := classifyRustDeskUIRuntime(false, 0, "running", false)
	if got != rustDeskStatusTrayOnly {
		t.Fatalf("expected tray_only for running service without valid main window, got %q", got)
	}
}

func TestRustDeskUIRuntimeStoppedWithoutProcessOrMainWindow(t *testing.T) {
	got := classifyRustDeskUIRuntime(false, 0, "stopped", false)
	if got != "stopped" {
		t.Fatalf("expected stopped, got %q", got)
	}
}
