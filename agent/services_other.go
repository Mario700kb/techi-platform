//go:build !windows

package main

func collectWindowsServices() []ServiceInfo { return nil }
