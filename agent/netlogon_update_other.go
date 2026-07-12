//go:build !windows

package main

import "fmt"

// runNetlogonSelfUpdateCommand is Windows-only (it drives the SCM service swap).
func runNetlogonSelfUpdateCommand(_ []string) int {
	fmt.Println("netlogon-self-update is only supported on Windows")
	return netlogonUpdateError
}
