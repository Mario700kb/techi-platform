//go:build !windows

package main

func captureFileSecurity(string) (string, error) { return "", nil }
func restoreFileSecurity(string, string) error   { return nil }
