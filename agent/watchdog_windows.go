//go:build windows

package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

const agentWatchdogTaskName = "TECHI Agent Watchdog"

var agentWatchdogOnce sync.Once

// ensureAgentServiceWatchdog registers (or refreshes) the "TECHI Agent
// Watchdog" scheduled task: every 5 minutes, SYSTEM runs
// `techi-agent.exe watchdog-check`, which recreates/starts the TechiAgent
// service if needed (see swap_windows.go).
//
// The task is registered with schtasks.exe and executes the agent binary
// directly — no PowerShell, so strict AV/AMSI policies cannot block it.
func ensureAgentServiceWatchdog() {
	agentWatchdogOnce.Do(func() {
		if err := installAgentServiceWatchdog(); err != nil {
			writeDeployLog("[watchdog-install]", "install failed: "+err.Error())
			log.Printf("[watchdog] install/update skipped: %v", err)
			return
		}
		writeDeployLog("[watchdog-install]", "scheduled task installed/updated (native)")
		log.Printf("[watchdog] %s scheduled task installed/updated", agentWatchdogTaskName)

		// The pre-2.1.2 watchdog ran through a PowerShell script; remove the
		// stale file so nothing script-based is left behind.
		_ = os.Remove(filepath.Join(agentProgramDataDir(), "techi-agent-watchdog.ps1"))
	})
}

// installAgentServiceWatchdog points the task at techi-agent-watchdog.exe, a
// copy of the agent, so the watchdog still runs when techi-agent.exe itself
// is gone and can put it back. It falls back to the agent exe when there is
// no copy, or when the copy cannot run (an application allow-list or
// antivirus blocking the new file name).
func installAgentServiceWatchdog() error {
	runner := agentTargetExePath()
	copyPath, err := refreshWatchdogCopy(runner)
	if err != nil {
		writeDeployLog("[watchdog-install]", "watchdog copy not refreshed: "+err.Error())
		if fileExists(agentWatchdogExePath()) {
			copyPath = agentWatchdogExePath()
		}
	}
	if copyPath != "" {
		if err := probeExeRuns(copyPath); err != nil {
			writeDeployLog("[watchdog-install]", "watchdog copy cannot run, task keeps the agent exe: "+err.Error())
		} else {
			runner = copyPath
		}
	}
	taskRun := `"` + runner + `" watchdog-check`
	return registerRecurringSystemTask(agentWatchdogTaskName, taskRun, 5)
}

// probeExeRuns starts exe with `swap-binary -help`, which only prints usage
// and exits 1 without touching anything. Any exit code proves Windows let it
// run; a start error (access denied, blocked by policy) or a hang does not.
func probeExeRuns(exe string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	err := exec.CommandContext(ctx, exe, "swap-binary", "-help").Run()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var exitErr *exec.ExitError
	if err == nil || errors.As(err, &exitErr) {
		return nil
	}
	return err
}

// refreshWatchdogCopy makes techi-agent-watchdog.exe a copy of agentExe. It
// writes a temp file and renames it over the copy, so a watchdog run that
// holds the old copy only delays the refresh to the next agent start.
func refreshWatchdogCopy(agentExe string) (string, error) {
	dst := agentWatchdogExePath()
	same, err := sameFileContent(agentExe, dst)
	if err == nil && same {
		return dst, nil
	}
	tmp := dst + ".new"
	if err := copyFileSync(agentExe, tmp); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return dst, nil
}

func sameFileContent(a string, b string) (bool, error) {
	ia, err := os.Stat(a)
	if err != nil {
		return false, err
	}
	ib, err := os.Stat(b)
	if err != nil {
		return false, err
	}
	if ia.Size() != ib.Size() {
		return false, nil
	}
	ha, err := fileSHA256Hex(a)
	if err != nil {
		return false, err
	}
	hb, err := fileSHA256Hex(b)
	if err != nil {
		return false, err
	}
	return ha == hb, nil
}
