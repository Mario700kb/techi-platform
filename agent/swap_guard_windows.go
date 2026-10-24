//go:build windows

package main

// Self-update safety net (RISK-UPDATE-001).
//
// On 2026-10-22, 12 of 792 Windows PCs lost the agent in the 2.1.20 → 2.1.35
// update, all at one client. The swap deleted its backup after a 30 s
// "service Running" check, the watchdog task ran the very exe it protects,
// and nothing put back an exe that had disappeared. The rules now:
//
//   - The swap keeps the previous exe (techi-agent-old.exe); the next swap
//     replaces it.
//   - After the swap the helper watches the new agent for up to
//     swapConfirmWindow. Only a definite failure rolls back: the exe vanished
//     (antivirus), the agent reported Faulted, or the service stayed down past
//     the SCM restart delays. A first heartbeat that cannot reach the platform
//     (PC offline, HeartbeatGuard 503) is not a failure: the new version stays,
//     and so does the backup.
//   - The watchdog task runs its own copy of the agent
//     (techi-agent-watchdog.exe), so it still runs when techi-agent.exe is
//     gone, and puts an exe back when the service is registered but its exe is
//     missing. A missing service and a missing exe mean the agent was
//     uninstalled: the watchdog removes its task and never brings it back.
//   - While a swap runs it leaves a marker file; the watchdog leaves the agent
//     service alone while the marker is fresh, so it cannot start the old exe
//     in the middle of a swap, and a second swap refuses to start.

import (
	"os"
	"path/filepath"
	"time"
)

const (
	agentWatchdogExeName = "techi-agent-watchdog.exe"
	swapMarkerName       = "swap.inprogress"

	swapConfirmWindow    = 10 * time.Minute
	swapServiceDownLimit = 3 * time.Minute // SCM restarts after 1 min, twice
	swapPollInterval     = 5 * time.Second
	swapMarkerMaxAge     = 20 * time.Minute

	// Antivirus scanning a freshly written exe can hold it for a few seconds.
	swapCopyAttempts   = 6
	swapCopyRetryDelay = 5 * time.Second
)

func agentBackupExePath() string {
	return filepath.Join(agentProgramDataDir(), agentBackupExeName)
}

func agentWatchdogExePath() string {
	return filepath.Join(agentProgramDataDir(), agentWatchdogExeName)
}

func swapMarkerPath() string {
	return filepath.Join(agentProgramDataDir(), swapMarkerName)
}

// ------------------------------------------------------------------ //
// post-swap confirmation                                              //
// ------------------------------------------------------------------ //

type swapVerdict int

const (
	swapPending swapVerdict = iota
	swapConfirmed
	swapFailed
	swapUnconfirmed
)

// swapObservation is one look at the machine after the new exe was installed.
type swapObservation struct {
	Now            time.Time
	ExeExists      bool
	ServiceRunning bool
	Lifecycle      *lifecycleStatus // nil when agent.state.json is unreadable
}

// swapWatch turns successive observations into a verdict. Lifecycle entries
// written before installedAt belong to the previous exe and are ignored.
type swapWatch struct {
	installedAt time.Time
	deadline    time.Time
	downSince   time.Time
}

func newSwapWatch(installedAt time.Time, window time.Duration) *swapWatch {
	return &swapWatch{installedAt: installedAt, deadline: installedAt.Add(window)}
}

func (w *swapWatch) observe(o swapObservation) (swapVerdict, string) {
	if !o.ExeExists {
		return swapFailed, "agent exe disappeared after the swap (antivirus?)"
	}
	if o.Lifecycle != nil && !o.Lifecycle.UpdatedAt.Before(w.installedAt) {
		switch o.Lifecycle.State {
		case stateOperational:
			return swapConfirmed, "new agent reached the platform"
		case stateFaulted:
			return swapFailed, "new agent faulted: " + o.Lifecycle.Detail
		}
	}
	if o.ServiceRunning {
		w.downSince = time.Time{}
	} else {
		if w.downSince.IsZero() {
			w.downSince = o.Now
		}
		if o.Now.Sub(w.downSince) >= swapServiceDownLimit {
			return swapFailed, "agent service not running for " + o.Now.Sub(w.downSince).Round(time.Second).String()
		}
	}
	if !o.Now.Before(w.deadline) {
		return swapUnconfirmed, "no heartbeat from the new agent yet"
	}
	return swapPending, ""
}

// ------------------------------------------------------------------ //
// restore source and swap marker                                      //
// ------------------------------------------------------------------ //

// agentExeRestoreSource picks what to copy over a missing techi-agent.exe:
// the previous exe kept by the last swap (it has already run on this PC and
// survived its antivirus), else the exe running this check. "" when neither
// exists.
func agentExeRestoreSource(backup string, self string, exists func(string) bool) string {
	if backup != "" && exists(backup) {
		return backup
	}
	if self != "" && exists(self) {
		return self
	}
	return ""
}

func writeSwapMarker() {
	_ = os.WriteFile(swapMarkerPath(), []byte(time.Now().UTC().Format(time.RFC3339)), 0644)
}

func clearSwapMarker() {
	_ = os.Remove(swapMarkerPath())
}

// swapMarkerFresh reports whether a swap started less than swapMarkerMaxAge
// ago. A marker left behind by a killed swap stops counting after that.
func swapMarkerFresh(now time.Time, modTime time.Time, exists bool) bool {
	return exists && now.Sub(modTime) < swapMarkerMaxAge
}

func swapInProgress() bool {
	info, err := os.Stat(swapMarkerPath())
	if err != nil {
		return false
	}
	return swapMarkerFresh(time.Now(), info.ModTime(), true)
}

// copyFileWithRetry is copyFileSync with a few retries for a target that
// antivirus or a dying process still holds.
func copyFileWithRetry(src string, dst string, tag string) error {
	var err error
	for attempt := 1; attempt <= swapCopyAttempts; attempt++ {
		if err = copyFileSync(src, dst); err == nil {
			return nil
		}
		if attempt < swapCopyAttempts {
			writeDeployLog(tag, "copy "+filepath.Base(src)+" -> "+filepath.Base(dst)+" failed, retrying: "+err.Error())
			time.Sleep(swapCopyRetryDelay)
		}
	}
	return err
}
