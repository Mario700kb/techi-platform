//go:build !windows && !darwin

package main

import (
	"context"
	"errors"
)

func platformProtocolURI(_ []string) (string, error) {
	return "", errors.New("unsupported_platform")
}

func cleanupPlatformHandoffs() error {
	return errors.New("unsupported_platform")
}

func securePlatformHandoff(_ context.Context, _ string, _ []byte) error {
	return errors.New("unsupported_platform")
}

func showBridgeError(_ string) {}
