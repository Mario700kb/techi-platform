//go:build !windows

package main

func collectWindowsServicesNative() ([]ServiceInfo, error) { return nil, nil }
