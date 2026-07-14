package main

import "strings"

func remoteSupportMutationAllowed(cfg *Config) bool {
	switch strings.ToLower(strings.TrimSpace(cfg.RemoteSupportAutoRepairMode)) {
	case "enabled":
		return true
	case "canary":
		if cfg.DeviceID <= 0 {
			return false
		}
		for _, id := range cfg.RemoteSupportAutoRepairIDs {
			if id == cfg.DeviceID {
				return true
			}
		}
	}
	return false
}
