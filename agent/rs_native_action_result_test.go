package main

import (
	"errors"
	"strings"
	"testing"

	"techi-platform/agent/internal/native"
)

func TestParseNativeRemoteSupportRepairResultPreservesRootCause(t *testing.T) {
	result := native.NewResult("repair-remote-support", native.ExitError)
	result.Message = "restore_config failed: ERROR_INVALID_OWNER"

	_, err := parseNativeRemoteSupportRepairResult([]byte(result.JSON()), errors.New("exit status 1"))
	if err == nil {
		t.Fatal("expected native repair failure")
	}
	want := "native Remote Support repair failed: restore_config failed: ERROR_INVALID_OWNER"
	if err.Error() != want {
		t.Fatalf("unexpected propagated error: got %q want %q", err, want)
	}
}

func TestParseNativeRemoteSupportRepairResultPreservesInvalidOutput(t *testing.T) {
	output := []byte("failed to replace app.so: Access is denied")

	_, err := parseNativeRemoteSupportRepairResult(output, errors.New("exit status 1"))
	if err == nil {
		t.Fatal("expected invalid native result failure")
	}
	for _, want := range []string{"decode JSON", "exit status 1", string(output)} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("propagated error %q does not contain %q", err, want)
		}
	}
}

func TestParseNativeRemoteSupportRepairResultSuccess(t *testing.T) {
	result := native.NewResult("repair-remote-support", native.ExitOK)
	result.Message = "Remote Support recovered"

	got, err := parseNativeRemoteSupportRepairResult([]byte(result.JSON()), nil)
	if err != nil {
		t.Fatalf("unexpected success error: %v", err)
	}
	if got.Message != result.Message {
		t.Fatalf("message changed: got %q want %q", got.Message, result.Message)
	}
}

func TestNativeRemoteSupportUILaunchFailureUsesFullDiagnosticStderr(t *testing.T) {
	diagnostic := `ui_launch_failed: start_ui diagnostics: agent_session_id=0; active_interactive_session_id=7; created_process_pid=41; visible_windows=[handle=0x101 width=16 height=16 visible=true result="width 16 < 200"]`
	result := native.OperationResult{Message: diagnostic, Code: native.ExitValidationError}
	failure := nativeRemoteSupportActionFailure(result, errors.New("native Remote Support repair failed: "+diagnostic))

	if got := failure.err.Error(); got != "native Remote Support repair failed: ui_launch_failed (see start_ui diagnostics)" {
		t.Fatalf("summary error = %q", got)
	}
	if failure.stderr != diagnostic {
		t.Fatalf("diagnostic stderr was lost: %q", failure.stderr)
	}
	if !strings.Contains(failure.output, `"message":"ui_launch_failed: start_ui diagnostics:`) {
		t.Fatalf("native JSON output lost diagnostic: %q", failure.output)
	}
}
