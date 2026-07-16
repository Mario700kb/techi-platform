package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRemoteSupportUISessionCommandWritesFailureDiagnostics(t *testing.T) {
	diagnostics := filepath.Join(t.TempDir(), "start-ui.diag")
	code := runRemoteSupportUISessionCommand([]string{
		"--exe", `C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`,
		"--session-id", "4294967295",
		"--launch",
		"--diagnostics-file", diagnostics,
	})
	if code == 0 {
		t.Fatal("expected UI probe to fail outside the requested Windows session")
	}
	data, err := os.ReadFile(diagnostics)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(data)) == "" {
		t.Fatal("UI probe failure diagnostic file is empty")
	}
}
