package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var AgentVersion = "0.0.0-dev"

type EnrollmentRequest struct {
	AgentID            string `json:"agent_id,omitempty"`
	EnrollmentToken    string `json:"enrollment_token,omitempty"`
	Domain             string `json:"domain,omitempty"`
	Hostname           string `json:"hostname"`
	CurrentUser        string `json:"current_user"`
	Platform           string `json:"platform"`
	OSName             string `json:"os_name"`
	OSVersion          string `json:"os_version"`
	OSCaption          string `json:"os_caption,omitempty"`
	OSBuild            string `json:"os_build,omitempty"`
	WindowsProductType int    `json:"windows_product_type,omitempty"`
	LocalIP            string `json:"local_ip"`
	PublicIP           string `json:"public_ip,omitempty"`
	RustDeskID         string `json:"rustdesk_id,omitempty"`
	AgentVersion       string `json:"agent_version,omitempty"`
	AgentSHA256        string `json:"agent_sha256,omitempty"`
}

type EnrollmentResponse struct {
	AgentID          string `json:"agent_id"`
	DeviceID         int    `json:"device_id"`
	HeartbeatURL     string `json:"heartbeat_url"`
	WebSocketURL     string `json:"websocket_url"`
	EnrollmentStatus string `json:"enrollment_status"`
	AssignedClientID *int   `json:"assigned_client_id"`
	AssignedGroupID  *int   `json:"assigned_group_id"`
}

func ensureEnrollment(cfg *Config, configPath string, inv *Inventory, rustdesk RustDeskInfo) error {
	if cfg.AgentID != "" && cfg.DeviceID > 0 {
		return nil
	}
	// Allow enrollment without a token when a non-workgroup domain is present
	// and the backend has TRUSTED_DOMAIN_AUTO_ENROLLMENT enabled.
	hasDomain := strings.TrimSpace(inv.Domain) != "" &&
		strings.ToLower(strings.TrimSpace(inv.Domain)) != "workgroup"
	if strings.TrimSpace(cfg.EnrollmentToken) == "" && !hasDomain {
		return fmt.Errorf("agent is not enrolled and no enrollment token was provided")
	}

	resp, err := enrollAgent(cfg, inv, rustdesk)
	if err != nil {
		return err
	}

	cfg.AgentID = resp.AgentID
	cfg.DeviceID = resp.DeviceID
	if resp.HeartbeatURL != "" {
		cfg.BackendURL = resp.HeartbeatURL
	}
	if resp.WebSocketURL != "" {
		cfg.WebSocketURL = resp.WebSocketURL
	}
	if isUsableRustDeskID(rustdesk.ID) {
		cfg.RustDeskID = strings.TrimSpace(rustdesk.ID)
	} else if !isUsableRustDeskID(cfg.RustDeskID) {
		cfg.RustDeskID = ""
	}
	cfg.EnrollmentToken = ""

	if err := saveConfig(configPath, cfg); err != nil {
		return fmt.Errorf("enrollment succeeded but failed to persist local identity: %w", err)
	}
	fmt.Printf("enrollment success: agent_id=%s device_id=%d\n", cfg.AgentID, cfg.DeviceID)
	return nil
}

func enrollAgent(cfg *Config, inv *Inventory, rustdesk RustDeskInfo) (*EnrollmentResponse, error) {
	requestPayload := EnrollmentRequest{
		AgentID:            strings.TrimSpace(cfg.AgentID),
		EnrollmentToken:    strings.TrimSpace(cfg.EnrollmentToken),
		Domain:             strings.TrimSpace(inv.Domain),
		Hostname:           inv.Hostname,
		CurrentUser:        inv.CurrentUser,
		Platform:           inv.Platform,
		OSName:             inv.OSName,
		OSVersion:          inv.OSVersion,
		OSCaption:          inv.OSCaption,
		OSBuild:            inv.OSBuild,
		WindowsProductType: inv.WindowsProductType,
		LocalIP:            inv.LocalIP,
		PublicIP:           inv.PublicIP,
		RustDeskID:         configuredRustDeskID(&Config{RustDeskID: rustdesk.ID}),
		AgentVersion:       AgentVersion,
		AgentSHA256:        currentAgentSHA256(),
	}
	data, err := json.Marshal(requestPayload)
	if err != nil {
		return nil, err
	}

	client := &http.Client{Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second}
	req, err := http.NewRequest(http.MethodPost, enrollmentURL(cfg), bytes.NewBuffer(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("backend unreachable during enrollment: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("enrollment failed: %s", strings.TrimSpace(string(body)))
	}

	var enrollment EnrollmentResponse
	if err := json.Unmarshal(body, &enrollment); err != nil {
		return nil, err
	}
	if enrollment.AgentID == "" || enrollment.DeviceID <= 0 {
		return nil, fmt.Errorf("enrollment failed: backend returned incomplete identity")
	}
	return &enrollment, nil
}

func enrollmentURL(cfg *Config) string {
	if strings.TrimSpace(cfg.BackendURL) != "" {
		base := backendBaseURL(cfg.BackendURL)
		return strings.TrimRight(base, "/") + "/api/v1/agent/enroll"
	}
	base := strings.TrimRight(cfg.APIURL, "/")
	return strings.TrimRight(base, "/") + "/api/v1/agent/enroll"
}
