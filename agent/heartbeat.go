package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

type HeartbeatPayload struct {
	AgentID               string         `json:"agent_id,omitempty"`
	DeviceID              int            `json:"device_id,omitempty"`
	RustDeskID            string         `json:"rustdesk_id,omitempty"`
	RustDeskEncID         string         `json:"rustdesk_enc_id,omitempty"`
	Hostname              string         `json:"hostname"`
	CurrentUser           string         `json:"current_user"`
	Domain                string         `json:"domain"`
	PublicIP              string         `json:"public_ip"`
	LocalIP               string         `json:"local_ip"`
	OSName                string         `json:"os_name"`
	OSVersion             string         `json:"os_version"`
	Platform              string         `json:"platform"`
	CPU                   string         `json:"cpu"`
	RAM                   string         `json:"ram"`
	Storage               string         `json:"storage"`
	RustDeskInstallStatus string         `json:"rustdesk_install_status"`
	RustDeskStatus        string         `json:"rustdesk_status"`
	RustDeskVersion       string         `json:"rustdesk_version"`
	RustDeskInstallPath   string         `json:"rustdesk_install_path"`
	CPUPercent            float64        `json:"cpu_percent"`
	RAMPercent            float64        `json:"ram_percent"`
	DiskPercent           float64        `json:"disk_percent"`
	UptimeSeconds         uint64         `json:"uptime_seconds"`
	HeartbeatLatencyMs    int64          `json:"heartbeat_latency_ms"`
	Processes             []ProcessInfo  `json:"processes,omitempty"`
	Services              []ServiceInfo  `json:"services,omitempty"`
	Software              []SoftwareInfo `json:"software,omitempty"`
	PatchStatus           *PatchStatus   `json:"patch_status,omitempty"`
}

func buildHeartbeatPayload(cfg *Config, inv *Inventory, rustdesk RustDeskInfo, tel *Telemetry, procs []ProcessInfo, svcs []ServiceInfo, software []SoftwareInfo, patchStatus *PatchStatus) *HeartbeatPayload {
	rustdeskID := strings.TrimSpace(rustdesk.ID)
	if !isUsableRustDeskID(rustdeskID) {
		rustdeskID = configuredRustDeskID(cfg)
	}
	p := &HeartbeatPayload{
		AgentID:               cfg.AgentID,
		DeviceID:              cfg.DeviceID,
		RustDeskID:            rustdeskID,
		RustDeskEncID:         rustdesk.EncID,
		Hostname:              inv.Hostname,
		CurrentUser:           inv.CurrentUser,
		Domain:                inv.Domain,
		PublicIP:              inv.PublicIP,
		LocalIP:               inv.LocalIP,
		OSName:                inv.OSName,
		OSVersion:             inv.OSVersion,
		Platform:              inv.Platform,
		CPU:                   inv.CPU,
		RAM:                   inv.RAM,
		Storage:               inv.Storage,
		RustDeskInstallStatus: rustdesk.InstallStatus,
		RustDeskStatus:        rustdesk.Status,
		RustDeskVersion:       rustdesk.Version,
		RustDeskInstallPath:   rustdesk.InstallPath,
		Processes:             procs,
		Services:              svcs,
		Software:              software,
		PatchStatus:           patchStatus,
	}
	if tel != nil {
		p.CPUPercent = tel.CPUPercent
		p.RAMPercent = tel.RAMPercent
		p.DiskPercent = tel.DiskPercent
		p.UptimeSeconds = tel.UptimeSeconds
		p.HeartbeatLatencyMs = tel.HeartbeatLatencyMs
	}
	return p
}

func sendHeartbeat(cfg *Config, payload *HeartbeatPayload) (*HeartbeatResponse, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	client := &http.Client{Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second}
	var lastErr error

	for attempt := 1; attempt <= cfg.Retries; attempt++ {
		req, err := http.NewRequest(http.MethodPost, cfg.BackendURL, bytes.NewBuffer(data))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")

		log.Printf("sending heartbeat attempt %d/%d to %s", attempt, cfg.Retries, cfg.BackendURL)
		resp, err := client.Do(req)
		if err != nil {
			log.Printf("heartbeat request error: %v", err)
			lastErr = err
		} else {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				log.Printf("heartbeat succeeded")
				var hbResp HeartbeatResponse
				if jsonErr := json.Unmarshal(body, &hbResp); jsonErr != nil {
					log.Printf("heartbeat response parse error: %v", jsonErr)
				}
				return &hbResp, nil
			}
			lastErr = fmt.Errorf("unexpected status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
			log.Printf("heartbeat failed: %v", lastErr)
		}

		if attempt < cfg.Retries {
			log.Printf("retrying in %d seconds...", cfg.RetryDelaySecond)
			time.Sleep(time.Duration(cfg.RetryDelaySecond) * time.Second)
		}
	}

	return nil, fmt.Errorf("heartbeat failed after %d attempts: %w", cfg.Retries, lastErr)
}
