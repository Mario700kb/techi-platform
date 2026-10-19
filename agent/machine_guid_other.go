//go:build !windows

package main

// machineGUID is Windows-only: Remote Support's uuid elsewhere is not a GUID.
func machineGUID() string { return "" }
