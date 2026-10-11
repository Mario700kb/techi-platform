package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

const (
	powerStateShutdown = "shutdown"
	powerStateSleep    = "sleep"

	powerEventPath = "/api/v1/agent/power-event"
)

var errHeartbeatsPaused = errors.New("heartbeats paused: machine is shutting down or going to sleep")

// The backend marks a device online while it handles a heartbeat, so a
// heartbeat that lands after the power event would undo it and the device
// would raise the offline alert the event exists to avoid. Every heartbeat
// send holds this slot for one HTTP attempt; reportPowerEvent pauses new
// sends, then takes the slot, so it waits for at most the attempt already in
// flight, never for a whole inventory cycle.
var heartbeatSlot = make(chan struct{}, 1)

// Wall-clock time of the pause in unix nanoseconds, 0 when not paused. The
// pause lifts itself after heartbeatPauseExpiry so a missed resume event (or
// a sleep that never happened) cannot silence the device for good. Wall
// clock on purpose: Go's monotonic clock on Windows stops while asleep.
var heartbeatsPausedAt atomic.Int64

const heartbeatPauseExpiry = 2 * time.Minute

func pauseHeartbeats(now time.Time) {
	heartbeatsPausedAt.Store(now.UnixNano())
}

func heartbeatsPaused(now time.Time) bool {
	pausedAt := heartbeatsPausedAt.Load()
	if pausedAt == 0 {
		return false
	}
	if now.Round(0).Sub(time.Unix(0, pausedAt)) < heartbeatPauseExpiry {
		return true
	}
	if heartbeatsPausedAt.CompareAndSwap(pausedAt, 0) {
		log.Printf("[power] heartbeat pause expired; resuming")
	}
	return false
}

func acquireHeartbeatSlot() error {
	heartbeatSlot <- struct{}{}
	if heartbeatsPaused(time.Now()) {
		<-heartbeatSlot
		return errHeartbeatsPaused
	}
	return nil
}

func releaseHeartbeatSlot() {
	<-heartbeatSlot
}

func resumeHeartbeats() {
	if heartbeatsPausedAt.Swap(0) != 0 {
		log.Printf("[power] heartbeats resumed")
	}
}

type powerEventPayload struct {
	DeviceID int    `json:"device_id"`
	AgentID  string `json:"agent_id"`
	State    string `json:"state"`
}

func powerEventURL(cfg *Config) string {
	return strings.TrimRight(backendBaseURL(cfg.BackendURL), "/") + powerEventPath
}

// reportPowerEvent pauses heartbeats and tells the backend this machine is
// going down, so it is marked offline with the reason instead of timing out.
// Best effort: Windows gives a suspending service about two seconds and a
// shutting-down one not much more, so both waits are bounded and every
// failure is only logged — a missed event falls back to the timeout path.
func reportPowerEvent(configPath string, state string, slotWait time.Duration, sendTimeout time.Duration) {
	pauseHeartbeats(time.Now())

	select {
	case heartbeatSlot <- struct{}{}:
		defer releaseHeartbeatSlot()
	case <-time.After(slotWait):
		log.Printf("[power] %s: a heartbeat is still in flight after %s; not reporting", state, slotWait)
		return
	}

	cfg, err := loadConfig(configPath)
	if err != nil {
		log.Printf("[power] %s: config unreadable, not reporting: %v", state, err)
		return
	}
	applyEnvironment(cfg)

	if err := sendPowerEvent(cfg, state, sendTimeout); err != nil {
		log.Printf("[power] %s: report failed: %v", state, err)
		return
	}
	log.Printf("[power] %s reported", state)
}

func sendPowerEvent(cfg *Config, state string, timeout time.Duration) error {
	if cfg.DeviceID == 0 || strings.TrimSpace(cfg.AgentID) == "" {
		return errors.New("device is not enrolled")
	}
	data, err := json.Marshal(powerEventPayload{DeviceID: cfg.DeviceID, AgentID: cfg.AgentID, State: state})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, powerEventURL(cfg), bytes.NewBuffer(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("unexpected status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}
