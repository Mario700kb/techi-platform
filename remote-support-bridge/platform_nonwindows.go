//go:build !windows

package main

import (
	"context"
	"errors"
)

func secureWindowsHandoff(_ context.Context, _ string, _ []byte) error {
	return errors.New("unsupported_platform")
}

func showBridgeError(_ string) {}
