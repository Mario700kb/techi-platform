package main

import (
    "flag"
    "log"
)

func main() {
    configPath := flag.String("config", "config.json", "path to agent configuration file")
    flag.Parse()

    cfg, err := loadConfig(*configPath)
    if err != nil {
        log.Fatalf("failed to load config: %v", err)
    }

    inventory, err := collectInventory(cfg)
    if err != nil {
        log.Fatalf("failed to collect inventory: %v", err)
    }

    payload := buildHeartbeatPayload(cfg, inventory)
    if err := sendHeartbeat(cfg, payload); err != nil {
        log.Fatalf("heartbeat failed: %v", err)
    }

    log.Printf("heartbeat sent successfully to %s", cfg.BackendURL)
}
