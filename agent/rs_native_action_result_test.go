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
