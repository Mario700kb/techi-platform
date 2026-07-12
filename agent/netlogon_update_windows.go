//go:build windows

package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// netlogonUpdateLockTTL bounds how long a single netlogon self-update lock is
// honoured. The detached swap task normally finishes in well under a minute;
// an interrupted run must not wedge every future scheduled deploy, so a lock
// older than this is treated as stale and reclaimed.
const netlogonUpdateLockTTL = 30 * time.Minute

// runNetlogonSelfUpdateCommand is the NETLOGON orchestration entry point:
//
//	techi-agent.exe netlogon-self-update -source <staged.exe>
//	    -expected-sha256 <hex> -expected-version <ver>
//
// It verifies the staged binary's identity, ensures only one update is active,
// stages it into the agent cache, then hands off to the existing native swap
// (swapAgentBinary). It never stops the service on a failed identity check.
func runNetlogonSelfUpdateCommand(args []string) int {
	fs := flag.NewFlagSet("netlogon-self-update", flag.ContinueOnError)
	source := fs.String("source", "", "path to the staged standalone agent exe to install")
	expectedSHA := fs.String("expected-sha256", "", "expected lowercase SHA256 of -source")
	expectedVersion := fs.String("expected-version", "", "approved rollout target version")
	if err := fs.Parse(args); err != nil {
		return netlogonUpdateBadArgs
	}

	// Identity gate first — before any service mutation. A mismatch here can
	// never stop the service.
	if code, err := verifyStagedAgentBinary(*source, *expectedSHA); err != nil {
		writeDeployLog("[netlogon_update]", fmt.Sprintf(
			"identity check failed target=%s: %v", *expectedVersion, err))
		return code
	}

	target := agentTargetExePath()
	staged := agentBinaryCachePath(*expectedVersion)
	srcAbs, _ := filepath.Abs(strings.TrimSpace(*source))
	stagedAbs, _ := filepath.Abs(staged)
	if !strings.EqualFold(srcAbs, stagedAbs) {
		if err := copyFileSync(*source, staged); err != nil {
			writeDeployLog("[netlogon_update]", "stage copy failed: "+err.Error())
			return netlogonUpdateError
		}
	}
	if strings.EqualFold(stagedAbs, mustAbs(target)) {
		writeDeployLog("[netlogon_update]", "refusing: staged path equals installed target path")
		return netlogonUpdateError
	}

	lock, ok := acquireNetlogonUpdateLock()
	if !ok {
		writeDeployLog("[netlogon_update]", "another self-update already in progress; lock="+lock)
		return netlogonUpdateBusy
	}

	writeDeployLog("[netlogon_update]", fmt.Sprintf(
		"staged=%s target=%s target_version=%s invoking native swap", staged, target, *expectedVersion))
	if err := swapAgentBinary(staged); err != nil {
		_ = os.RemoveAll(lock)
		writeDeployLog("[netlogon_update]", "swap schedule failed: "+err.Error())
		return netlogonUpdateError
	}
	// The lock is intentionally left in place: the detached swap task runs
	// after this process exits, and the lock self-expires after
	// netlogonUpdateLockTTL. This blocks a second concurrent netlogon update
	// within the window without needing a live process to hold it.
	writeDeployLog("[netlogon_update]", "native self-update scheduled (detached swap task)")
	return netlogonUpdateOK
}

func mustAbs(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	return abs
}

// acquireNetlogonUpdateLock atomically creates a lock directory. It returns the
// lock path and whether it was acquired. A lock older than netlogonUpdateLockTTL
// is treated as stale and reclaimed.
func acquireNetlogonUpdateLock() (string, bool) {
	lockDir := filepath.Join(agentProgramDataDir(), "locks")
	_ = os.MkdirAll(lockDir, 0755)
	lock := filepath.Join(lockDir, "netlogon-self-update.lock")
	if info, err := os.Stat(lock); err == nil {
		if time.Since(info.ModTime()) > netlogonUpdateLockTTL {
			writeDeployLog("[netlogon_update]", "reclaiming stale self-update lock")
			_ = os.RemoveAll(lock)
		}
	}
	if err := os.Mkdir(lock, 0755); err != nil {
		return lock, false
	}
	return lock, true
}
