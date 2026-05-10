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
    RustDeskID  string `json:"rustdesk_id"`
    Hostname    string `json:"hostname"`
    CurrentUser string `json:"current_user"`
    Domain      string `json:"domain"`
    PublicIP    string `json:"public_ip"`
    LocalIP     string `json:"local_ip"`
    OSName      string `json:"os_name"`
    OSVersion   string `json:"os_version"`
    Platform    string `json:"platform"`
    CPU         string `json:"cpu"`
    RAM         string `json:"ram"`
    Storage     string `json:"storage"`
}

func buildHeartbeatPayload(cfg *Config, inv *Inventory) *HeartbeatPayload {
    return &HeartbeatPayload{
        RustDeskID:  cfg.RustDeskID,
        Hostname:    inv.Hostname,
        CurrentUser: inv.CurrentUser,
        Domain:      inv.Domain,
        PublicIP:    inv.PublicIP,
        LocalIP:     inv.LocalIP,
        OSName:      inv.OSName,
        OSVersion:   inv.OSVersion,
        Platform:    inv.Platform,
        CPU:         inv.CPU,
        RAM:         inv.RAM,
        Storage:     inv.Storage,
    }
}

func sendHeartbeat(cfg *Config, payload *HeartbeatPayload) error {
    data, err := json.Marshal(payload)
    if err != nil {
        return err
    }

    client := &http.Client{Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second}
    var lastErr error

    for attempt := 1; attempt <= cfg.Retries; attempt++ {
        req, err := http.NewRequest(http.MethodPost, cfg.BackendURL, bytes.NewBuffer(data))
        if err != nil {
            return err
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
                log.Printf("heartbeat succeeded: %s", strings.TrimSpace(string(body)))
                return nil
            }
            lastErr = fmt.Errorf("unexpected status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
            log.Printf("heartbeat failed: %v", lastErr)
        }

        if attempt < cfg.Retries {
            log.Printf("retrying in %d seconds...", cfg.RetryDelaySecond)
            time.Sleep(time.Duration(cfg.RetryDelaySecond) * time.Second)
        }
    }

    return fmt.Errorf("heartbeat failed after %d attempts: %w", cfg.Retries, lastErr)
}
