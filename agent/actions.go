package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync/atomic"
	"time"
)

// pendingImmediateHeartbeat is set by handleRestartAgent after completing its
// action callback. runSingleHeartbeat checks and clears this flag so the next
// heartbeat runs immediately instead of waiting for the next ticker tick.
var pendingImmediateHeartbeat atomic.Bool

type PendingAction struct {
	ActionID       int                    `json:"action_id"`
	Action         string                 `json:"action"`
	Parameters     map[string]interface{} `json:"parameters"`
	TimeoutSeconds int                    `json:"timeout_seconds"`
	CallbackSecret string                 `json:"callback_secret,omitempty"`
}

type HeartbeatResponse struct {
	PendingActions []PendingAction `json:"pending_actions"`
}

type actionResult struct {
	message string
	output  string // full stdout for the action log
	stderr  string // full stderr for the action log
	err     error
}

func processActions(cfg *Config, actions []PendingAction) {
	if len(actions) == 0 {
		return
	}
	log.Printf("processing %d pending action(s)", len(actions))
	for _, action := range actions {
		runAction(cfg, action)
	}
}

func runAction(cfg *Config, action PendingAction) {
	log.Printf("action %d: starting %s", action.ActionID, action.Action)
	secret := action.CallbackSecret

	if err := ackAction(cfg, action.ActionID, secret); err != nil {
		log.Printf("action %d: ack failed: %v", action.ActionID, err)
		return
	}

	// Report running and start timing.
	if err := markRunningAction(cfg, action.ActionID, secret); err != nil {
		log.Printf("action %d: running report failed (non-fatal): %v", action.ActionID, err)
	}
	startedAt := time.Now()

	timeout := time.Duration(action.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 300 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	result := dispatch(ctx, cfg, action)
	elapsed := time.Since(startedAt)

	if result.err != nil {
		log.Printf("action %d: failed after %s: %v", action.ActionID, elapsed.Round(time.Millisecond), result.err)
		if err := failAction(cfg, action.ActionID, result.err.Error(), result.stderr, secret); err != nil {
			log.Printf("action %d: fail report error: %v", action.ActionID, err)
		}
		return
	}

	log.Printf("action %d: completed in %s: %s", action.ActionID, elapsed.Round(time.Millisecond), result.message)
	if err := completeAction(cfg, action.ActionID, result.message, result.output, secret); err != nil {
		log.Printf("action %d: complete report error: %v", action.ActionID, err)
	}
}

func dispatch(ctx context.Context, cfg *Config, action PendingAction) actionResult {
	switch action.Action {
	case "ping":
		return handlePing(ctx)
	case "refresh_inventory", "sync_inventory":
		return handleRefreshInventory(ctx, cfg)
	case "restart_device":
		return handleRestartDevice(ctx)
	case "restart_agent":
		return handleRestartAgent(ctx)
	case "immediate_heartbeat":
		return handleImmediateHeartbeat()
	case "sync_rustdesk":
		return handleSyncRustDesk(ctx, cfg)
	case "restart_rustdesk":
		return handleRestartRustDesk(ctx, cfg)
	case "reinstall_rustdesk":
		return handleReinstallRustDesk(ctx, cfg)
	case "reopen_rustdesk":
		return handleReopenRustDesk(ctx, cfg)
	case "apply_power_policy":
		return handleApplyPowerPolicy(ctx, cfg)
	default:
		return actionResult{err: fmt.Errorf("unknown action type: %q", action.Action)}
	}
}

func handlePing(_ context.Context) actionResult {
	return actionResult{message: "Agent is reachable"}
}

func handleRefreshInventory(ctx context.Context, cfg *Config) actionResult {
	done := make(chan actionResult, 1)
	go func() {
		inv, err := collectInventory(cfg)
		if err != nil {
			done <- actionResult{err: fmt.Errorf("inventory collection failed: %w", err)}
			return
		}
		tel := collectTelemetry()
		done <- actionResult{
			message: fmt.Sprintf("Inventory refreshed: hostname=%s cpu=%.1f%% ram=%.1f%% disk=%.1f%%",
				inv.Hostname, tel.CPUPercent, tel.RAMPercent, tel.DiskPercent),
		}
	}()
	select {
	case <-ctx.Done():
		return actionResult{err: fmt.Errorf("refresh_inventory timed out")}
	case r := <-done:
		return r
	}
}

func handleImmediateHeartbeat() actionResult {
	pendingImmediateHeartbeat.Store(true)
	log.Printf("immediate_heartbeat: next heartbeat forced immediately")
	return actionResult{message: "Immediate heartbeat scheduled — telemetry and inventory will refresh within seconds"}
}

func handleSyncRustDesk(ctx context.Context, cfg *Config) actionResult {
	done := make(chan actionResult, 1)
	go func() {
		rd := discoverRustDesk(cfg)
		done <- actionResult{
			message: fmt.Sprintf(
				"TECHI Remote Support sync: id=%s status=%s version=%s install_status=%s",
				rd.ID, rd.Status, rd.Version, rd.InstallStatus,
			),
		}
	}()
	select {
	case <-ctx.Done():
		return actionResult{err: fmt.Errorf("sync_rustdesk timed out")}
	case r := <-done:
		return r
	}
}

func ackAction(cfg *Config, actionID int, secret string) error {
	return postActionEndpoint(cfg, fmt.Sprintf("/api/v1/actions/%d/ack", actionID), nil, secret)
}

func markRunningAction(cfg *Config, actionID int, secret string) error {
	return postActionEndpoint(cfg, fmt.Sprintf("/api/v1/actions/%d/running", actionID), nil, secret)
}

func completeAction(cfg *Config, actionID int, message, output, secret string) error {
	return postActionEndpoint(cfg, fmt.Sprintf("/api/v1/actions/%d/complete", actionID), map[string]string{
		"result_message": message,
		"output":         output,
	}, secret)
}

func failAction(cfg *Config, actionID int, errMsg, stderrOutput, secret string) error {
	return postActionEndpoint(cfg, fmt.Sprintf("/api/v1/actions/%d/fail", actionID), map[string]string{
		"error_message": errMsg,
		"stderr_output": stderrOutput,
	}, secret)
}

func postActionEndpoint(cfg *Config, path string, body interface{}, callbackSecret string) error {
	var reqBody []byte
	var err error
	if body != nil {
		reqBody, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}

	url := cfg.APIURL + path
	client := &http.Client{Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(reqBody))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if callbackSecret != "" {
		req.Header.Set("X-Callback-Secret", callbackSecret)
	}

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("action endpoint %s returned status %d", path, resp.StatusCode)
	}
	return nil
}
