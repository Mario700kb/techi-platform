//go:build !windows

package main

// lockdownConfigACL is a no-op outside Windows: os.WriteFile's 0600 mode
// already restricts the config file to its owner on Unix-like systems.
func lockdownConfigACL(_ string) {}
