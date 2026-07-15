package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

var agentSHA256Cache struct {
	once  sync.Once
	value string
}

type HeartbeatPayload struct {
	AgentID            string `json:"agent_id,omitempty"`
	DeviceID           int    `json:"device_id,omitempty"`
	RustDeskID         string `json:"rustdesk_id,omitempty"`
	RustDeskEncID      string `json:"rustdesk_enc_id,omitempty"`
	Hostname           string `json:"hostname"`
	CurrentUser        string `json:"current_user"`
	UserSource         string `json:"user_source,omitempty"`
	UserSessionState   string `json:"user_session_state,omitempty"`
	Domain             string `json:"domain"`
	PublicIP           string `json:"public_ip"`
	LocalIP            string `json:"local_ip"`
	OSName             string `json:"os_name"`
	OSVersion          string `json:"os_version"`
	OSCaption          string `json:"os_caption,omitempty"`
	OSBuild            string `json:"os_build,omitempty"`
	WindowsProductType int    `json:"windows_product_type"`
	Platform           string `json:"platform"`
	CPU                string `json:"cpu"`
	RAM                string `json:"ram"`
	Storage            string `json:"storage"`
	// Platform Expansion additive fields — omitempty; empty on Windows.
	FQDN                       string                      `json:"fqdn,omitempty"`
	KernelVersion              string                      `json:"kernel_version,omitempty"`
	Architecture               string                      `json:"architecture,omitempty"`
	MACAddress                 string                      `json:"mac_address,omitempty"`
	Timezone                   string                      `json:"timezone,omitempty"`
	LastBootAt                 string                      `json:"last_boot_at,omitempty"`
	Capabilities               []string                    `json:"capabilities,omitempty"`
	RustDeskInstallStatus      string                      `json:"rustdesk_install_status"`
	RustDeskStatus             string                      `json:"rustdesk_status"`
	RustDeskVersion            string                      `json:"rustdesk_version"`
	RustDeskInstallPath        string                      `json:"rustdesk_install_path"`
	RustDeskSyncStatus         string                      `json:"rustdesk_sync_status,omitempty"`
	RustDeskLastRepairAt       string                      `json:"rustdesk_last_repair_at,omitempty"`
	RustDeskRepairCount        int                         `json:"rustdesk_repair_count,omitempty"`
	RustDeskRepairAttemptCount int                         `json:"rustdesk_repair_attempt_count,omitempty"`
	RustDeskRepairSuccessCount int                         `json:"rustdesk_repair_success_count,omitempty"`
	RustDeskConsecutiveFailure int                         `json:"rustdesk_consecutive_repair_failures,omitempty"`
	RustDeskLastRepairReason   string                      `json:"rustdesk_last_repair_reason,omitempty"`
	CPUPercent                 float64                     `json:"cpu_percent"`
	RAMPercent                 float64                     `json:"ram_percent"`
	DiskPercent                float64                     `json:"disk_percent"`
	UptimeSeconds              uint64                      `json:"uptime_seconds"`
	HeartbeatLatencyMs         int64                       `json:"heartbeat_latency_ms"`
	Processes                  []ProcessInfo               `json:"processes,omitempty"`
	Services                   []ServiceInfo               `json:"services,omitempty"`
	Software                   []SoftwareInfo              `json:"software,omitempty"`
	PatchStatus                *PatchStatus                `json:"patch_status,omitempty"`
	AgentVersion               string                      `json:"agent_version,omitempty"`
	AgentSHA256                string                      `json:"agent_sha256,omitempty"`
	RemoteSupportCredentialAck *RemoteSupportCredentialAck `json:"remote_support_credential_ack,omitempty"`
}

func buildHeartbeatPayload(cfg *Config, inv *Inventory, rustdesk RustDeskInfo, tel *Telemetry, procs []ProcessInfo, svcs []ServiceInfo, software []SoftwareInfo, patchStatus *PatchStatus) *HeartbeatPayload {
	rustdeskID := strings.TrimSpace(rustdesk.ID)
	if !isUsableRustDeskID(rustdeskID) {
		rustdeskID = configuredRustDeskID(cfg)
	}
	p := &HeartbeatPayload{
		AgentID:                    cfg.AgentID,
		DeviceID:                   cfg.DeviceID,
		RustDeskID:                 rustdeskID,
		RustDeskEncID:              rustdesk.EncID,
		Hostname:                   inv.Hostname,
		CurrentUser:                inv.CurrentUser,
		UserSource:                 inv.UserSource,
		UserSessionState:           inv.UserSessionState,
		Domain:                     inv.Domain,
		PublicIP:                   inv.PublicIP,
		LocalIP:                    inv.LocalIP,
		OSName:                     inv.OSName,
		OSVersion:                  inv.OSVersion,
		OSCaption:                  inv.OSCaption,
		OSBuild:                    inv.OSBuild,
		WindowsProductType:         inv.WindowsProductType,
		Platform:                   inv.Platform,
		CPU:                        inv.CPU,
		RAM:                        inv.RAM,
		Storage:                    inv.Storage,
		FQDN:                       inv.FQDN,
		KernelVersion:              inv.KernelVersion,
		Architecture:               inv.Architecture,
		MACAddress:                 inv.MACAddress,
		Timezone:                   inv.Timezone,
		LastBootAt:                 inv.LastBootAt,
		Capabilities:               inv.Capabilities,
		RustDeskInstallStatus:      rustdesk.InstallStatus,
		RustDeskStatus:             rustdesk.Status,
		RustDeskVersion:            rustdesk.Version,
		RustDeskInstallPath:        rustdesk.InstallPath,
		RustDeskSyncStatus:         rustdesk.SyncStatus,
		RustDeskLastRepairAt:       cfg.RustDeskLastRepairAt,
		RustDeskRepairCount:        cfg.RustDeskRepairCount,
		RustDeskRepairAttemptCount: cfg.RustDeskRepairAttempts,
		RustDeskRepairSuccessCount: cfg.RustDeskRepairSuccesses,
		RustDeskConsecutiveFailure: cfg.RustDeskRepairFailures,
		RustDeskLastRepairReason:   cfg.RustDeskLastRepairReason,
		Processes:                  procs,
		Services:                   svcs,
		Software:                   software,
		PatchStatus:                patchStatus,
	}
	if tel != nil {
		p.CPUPercent = tel.CPUPercent
		p.RAMPercent = tel.RAMPercent
		p.DiskPercent = tel.DiskPercent
		p.UptimeSeconds = tel.UptimeSeconds
		p.HeartbeatLatencyMs = tel.HeartbeatLatencyMs
	}
	p.AgentVersion = AgentVersion
	p.AgentSHA256 = currentAgentSHA256()
	if cfg.RustDeskAckGeneration > 0 && (cfg.RustDeskAckStatus == "applied" || cfg.RustDeskAckStatus == "failed" || cfg.RustDeskAckStatus == "conflicted") {
		p.RemoteSupportCredentialAck = &RemoteSupportCredentialAck{
			Generation:  cfg.RustDeskAckGeneration,
			Status:      cfg.RustDeskAckStatus,
			Fingerprint: cfg.RustDeskAckFingerprint,
			Error:       cfg.RustDeskAckError,
		}
	}
	return p
}

func currentAgentSHA256() string {
	agentSHA256Cache.once.Do(func() {
		exePath, err := os.Executable()
		if err != nil {
			log.Printf("agent sha256: executable path unavailable: %v", err)
			return
		}
		file, err := os.Open(exePath)
		if err != nil {
			log.Printf("agent sha256: open %s failed: %v", exePath, err)
			return
		}
		defer file.Close()
		h := sha256.New()
		if _, err := io.Copy(h, file); err != nil {
			log.Printf("agent sha256: hash %s failed: %v", exePath, err)
			return
		}
		agentSHA256Cache.value = hex.EncodeToString(h.Sum(nil))
	})
	return agentSHA256Cache.value
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
		if strings.TrimSpace(cfg.AgentCredential) != "" {
			timestampMS := time.Now().UnixMilli()
			nonceBytes := make([]byte, 16)
			if _, err := rand.Read(nonceBytes); err != nil {
				return nil, fmt.Errorf("heartbeat nonce: %w", err)
			}
			nonce := hex.EncodeToString(nonceBytes)
			bodyHash := sha256.Sum256(data)
			message := fmt.Sprintf("v1\n%s\n%d\n%s\n%s", cfg.AgentID, timestampMS, nonce, hex.EncodeToString(bodyHash[:]))
			mac := hmac.New(sha256.New, []byte(cfg.AgentCredential))
			_, _ = mac.Write([]byte(message))
			req.Header.Set("X-Techi-Agent-ID", cfg.AgentID)
			req.Header.Set("X-Techi-Agent-Timestamp", fmt.Sprintf("%d", timestampMS))
			req.Header.Set("X-Techi-Agent-Nonce", nonce)
			req.Header.Set("X-Techi-Agent-Signature", hex.EncodeToString(mac.Sum(nil)))
		}

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
