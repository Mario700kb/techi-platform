package main

import (
    "encoding/json"
    "fmt"
    "os"
)

type Config struct {
    BackendURL       string `json:"backend_url"`
    RustDeskID       string `json:"rustdesk_id"`
    PublicIPService  string `json:"public_ip_service"`
    TimeoutSeconds   int    `json:"timeout_seconds"`
    Retries          int    `json:"retries"`
    RetryDelaySecond int    `json:"retry_delay_seconds"`
}

func defaultConfig() Config {
    return Config{
        BackendURL:       "http://localhost:8000/api/v1/agent/heartbeat",
        RustDeskID:       "rustdesk-placeholder",
        PublicIPService:  "https://api.ipify.org?format=text",
        TimeoutSeconds:   10,
        Retries:          3,
        RetryDelaySecond: 5,
    }
}

func loadConfig(path string) (*Config, error) {
    cfg := defaultConfig()
    data, err := os.ReadFile(path)
    if err != nil {
        if os.IsNotExist(err) {
            fmt.Fprintf(os.Stderr, "config file not found at %s, using defaults\n", path)
            return &cfg, nil
        }
        return nil, err
    }

    if err := json.Unmarshal(data, &cfg); err != nil {
        return nil, err
    }

    applyConfigDefaults(&cfg)
    return &cfg, nil
}

func applyConfigDefaults(cfg *Config) {
    if cfg.BackendURL == "" {
        cfg.BackendURL = "http://localhost:8000/api/v1/agent/heartbeat"
    }
    if cfg.RustDeskID == "" {
        cfg.RustDeskID = "rustdesk-placeholder"
    }
    if cfg.PublicIPService == "" {
        cfg.PublicIPService = "https://api.ipify.org?format=text"
    }
    if cfg.TimeoutSeconds <= 0 {
        cfg.TimeoutSeconds = 10
    }
    if cfg.Retries <= 0 {
        cfg.Retries = 3
    }
    if cfg.RetryDelaySecond <= 0 {
        cfg.RetryDelaySecond = 5
    }
}
