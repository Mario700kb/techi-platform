package main

import (
	"flag"
	"fmt"
	"os"

	"techi-platform/agent/internal/native"
)

func runRemoteSupportUISessionCommand(args []string) int {
	fs := flag.NewFlagSet("remote-support-ui-session", flag.ContinueOnError)
	exe := fs.String("exe", "", "Remote Support executable")
	sessionID := fs.Uint("session-id", 0, "expected interactive Windows session")
	launch := fs.Bool("launch", false, "launch the normal desktop application if needed")
	diagnosticsFile := fs.String("diagnostics-file", "", "internal UI diagnostics output")
	if err := fs.Parse(args); err != nil || *exe == "" || *sessionID == 0 {
		return 2
	}
	if err := native.RunRemoteSupportUISessionProbe(*exe, uint32(*sessionID), *launch); err != nil {
		if *diagnosticsFile != "" {
			_ = os.WriteFile(*diagnosticsFile, []byte(err.Error()), 0o600)
		}
		fmt.Printf("remote-support-ui-session: %v\n", err)
		return 1
	}
	return 0
}
