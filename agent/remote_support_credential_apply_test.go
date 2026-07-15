package main

import (
	"errors"
	"fmt"
	"testing"
)

func TestApplyRemoteSupportCredentialStepsTreatsTrayReloadAsBestEffort(t *testing.T) {
	var calls []string
	err := applyRemoteSupportCredentialSteps(
		"DevicePassword99",
		func(string) error { calls = append(calls, "write"); return nil },
		func() error { calls = append(calls, "service"); return nil },
		func() error { calls = append(calls, "tray"); return errors.New("tray unavailable") },
	)
	if err != nil {
		t.Fatalf("tray reload must not reject a verified service credential: %v", err)
	}
	if got, want := len(calls), 3; got != want {
		t.Fatalf("steps called = %d, want %d", got, want)
	}
	for index, want := range []string{"write", "service", "tray"} {
		if calls[index] != want {
			t.Fatalf("step %d = %q, want %q", index, calls[index], want)
		}
	}
}

func TestCredentialApplyFailureStatusPreservesConflict(t *testing.T) {
	if got := credentialApplyFailureStatus(fmt.Errorf("inspect profiles: %w", errRemoteSupportCredentialConflict)); got != "conflicted" {
		t.Fatalf("conflict status = %q, want conflicted", got)
	}
	if got := credentialApplyFailureStatus(errors.New("service failed")); got != "failed" {
		t.Fatalf("ordinary failure status = %q, want failed", got)
	}
}

func TestApplyRemoteSupportCredentialStepsFailsClosedOnWriteOrService(t *testing.T) {
	tests := []struct {
		name    string
		write   func(string) error
		service func() error
	}{
		{name: "profile write", write: func(string) error { return errors.New("write failed") }, service: func() error { return nil }},
		{name: "service reload", write: func(string) error { return nil }, service: func() error { return errors.New("service failed") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := applyRemoteSupportCredentialSteps("DevicePassword99", tt.write, tt.service, func() error { return nil }); err == nil {
				t.Fatal("expected credential application failure")
			}
		})
	}
}
