package main

import "time"

// boundedOneShot runs work with a hard wall-clock bound. It returns
// (work's code, false) when work finishes within limit, or (timeoutCode, true)
// when it does not. It NEVER waits past limit.
//
// This is the safety net for one-shot maintenance subcommands that run as
// SYNCHRONOUS MSI custom actions: msiexec waits for the process to exit, so an
// unbounded command blocks the whole install and locks Windows Installer. The
// subcommands are dispatched via os.Exit(...) in main(), which terminates the
// process (and any goroutine still stuck in a syscall) the instant this returns
// — so returning here always ends the process, even if work never completes.
func boundedOneShot(limit time.Duration, timeoutCode int, work func() int) (int, bool) {
	done := make(chan int, 1)
	go func() { done <- work() }()
	select {
	case code := <-done:
		return code, false
	case <-time.After(limit):
		return timeoutCode, true
	}
}
