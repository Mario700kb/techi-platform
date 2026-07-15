//go:build windows

package main

import (
	"fmt"

	"techi-platform/agent/internal/native"
)

const remoteSupportRepairLockRoot = `C:\ProgramData\TechiAgent`

func acquireRemoteSupportRepairLock() (func(), error) {
	lock, code, err := native.AcquireExecutionLock(remoteSupportRepairLockRoot)
	if err != nil {
		return nil, fmt.Errorf("remote support repair busy (%s): %w", code.String(), err)
	}
	return lock.Release, nil
}
