//go:build windows

package main

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

const agentWatchdogTaskName = "TECHI Agent Watchdog"

var agentWatchdogOnce sync.Once

func reconcileAgentServiceWatchdog(enabled bool) {
	if enabled {
		ensureAgentServiceWatchdog()
		return
	}
	disableAgentServiceWatchdog()
}

func disableAgentServiceWatchdog() {
	agentWatchdogOnce.Do(func() {
		query := exec.Command(schtasksPath(), "/Query", "/TN", agentWatchdogTaskName)
		if err := query.Run(); err != nil {
			return
		}
		remove := exec.Command(schtasksPath(), "/Delete", "/TN", agentWatchdogTaskName, "/F")
		if out, err := remove.CombinedOutput(); err != nil {
			log.Printf("[watchdog] disable failed: %v: %s", err, string(out))
			return
		}
		_ = os.Remove(filepath.Join(agentProgramDataDir(), "techi-agent-watchdog.ps1"))
		writeDeployLog("[watchdog]", "scheduled task removed; runtime watchdog is disabled")
		log.Printf("[watchdog] %s scheduled task removed", agentWatchdogTaskName)
	})
}

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

func installAgentServiceWatchdog() error {
	taskRun := `"` + agentTargetExePath() + `" watchdog-check`
	return registerRecurringSystemTask(agentWatchdogTaskName, taskRun, 5)
}
