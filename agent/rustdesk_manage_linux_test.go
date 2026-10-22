//go:build linux

package main

import (
	"errors"
	"testing"
)

func TestRustDeskPasswordResult(t *testing.T) {
	if err := rustDeskPasswordResult("Done!\n", nil); err != nil {
		t.Errorf("Done! must be success, got %v", err)
	}
	if err := rustDeskPasswordResult("", nil); err != nil {
		t.Errorf("silent exit 0 must be success, got %v", err)
	}
	if err := rustDeskPasswordResult("Installation and administrative privileges required!", nil); err == nil {
		t.Error("a refusal printed with exit 0 must be an error")
	}
	if err := rustDeskPasswordResult("", errors.New("exit status 1")); err == nil {
		t.Error("a failed run must be an error")
	}
}
