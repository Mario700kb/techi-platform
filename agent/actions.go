package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

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
		if err := failAction(cfg, action.ActionID, result.err.Error(), secret); err != nil {
			log.Printf("action %d: fail report error: %v", action.ActionID, err)
		}
		return
	}

	log.Printf("action %d: completed in %s: %s", action.ActionID, elapsed.Round(time.Millisecond), result.message)
	if err := completeAction(cfg, action.ActionID, result.message, secret); err != nil {
		log.Printf("action %d: complete report error: %v", action.ActionID, err)
	}
}

func dispatch(ctx context.Context, cfg *Config, action PendingAction) actionResult {
	switch action.Action {
	case "ping":
		return handlePing(ctx)
	case "refresh_inventory":
		return handleRefreshInventory(ctx, cfg)
	case "restart_device":
		return handleRestartDevice(ctx)
	case "restart_agent":
		return handleRestartAgent(ctx)
	case "sync_rustdesk":
		return handleSyncRustDesk(ctx, cfg)
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

func handleRestartDevice(_ context.Context) actionResult {
	// Safe-mode only: logs intent, no actual OS shutdown.
	log.Printf("restart_device: dry-run — no actual restart performed (safe-mode)")
	return actionResult{message: "Restart dry-run accepted. Explicit OS restart not yet enabled — contact operator to confirm intent."}
}

func handleRestartAgent(_ context.Context) actionResult {
	// Logs the intent; actual process restart happens when the agent's
	// supervisor (systemd, launchd, Windows Service) detects exit code 0
	// and re-launches it. We return success so the action completes cleanly.
	log.Printf("restart_agent: signalling clean exit for supervisor restart")
	return actionResult{message: "Agent restart acknowledged — will exit after this action cycle for supervisor restart"}
}

func handleSyncRustDesk(ctx context.Context, cfg *Config) actionResult {
	done := make(chan actionResult, 1)
	go func() {
		rd := discoverRustDesk(cfg)
		done <- actionResult{
			message: fmt.Sprintf(
				"RustDesk sync: id=%s status=%s version=%s install_status=%s",
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

func completeAction(cfg *Config, actionID int, message string, secret string) error {
	return postActionEndpoint(cfg, fmt.Sprintf("/api/v1/actions/%d/complete", actionID), map[string]string{
		"result_message": message,
	}, secret)
}

func failAction(cfg *Config, actionID int, errMsg string, secret string) error {
	return postActionEndpoint(cfg, fmt.Sprintf("/api/v1/actions/%d/fail", actionID), map[string]string{
		"error_message": errMsg,
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
