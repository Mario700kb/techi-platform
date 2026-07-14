package main

import (
	"encoding/json"
	"fmt"
)

const bootstrapConfigContractVersion = "1"

const (
	bootstrapFlagAPIURL                  = "api-url"
	bootstrapFlagEnrollmentToken         = "enrollment-token"
	bootstrapFlagReenroll                = "reenroll"
	bootstrapFlagRustDeskServer          = "rustdesk-server"
	bootstrapFlagRustDeskRelay           = "rustdesk-relay"
	bootstrapFlagRustDeskKey             = "rustdesk-key"
	bootstrapFlagRemoteSupportRepairMode = "remote-support-auto-repair-mode"
	bootstrapFlagRemoteSupportRepairIDs  = "remote-support-auto-repair-device-ids"
)

var bootstrapConfigSupportedFlags = []string{
	"-" + bootstrapFlagAPIURL,
	"-" + bootstrapFlagEnrollmentToken,
	"-" + bootstrapFlagReenroll,
	"-" + bootstrapFlagRustDeskServer,
	"-" + bootstrapFlagRustDeskRelay,
	"-" + bootstrapFlagRustDeskKey,
	"-" + bootstrapFlagRemoteSupportRepairMode,
	"-" + bootstrapFlagRemoteSupportRepairIDs,
}

type bootstrapConfigContract struct {
	AgentVersion    string   `json:"agent_version"`
	ContractVersion string   `json:"contract_version"`
	SupportedFlags  []string `json:"supported_flags"`
}

func runBootstrapConfigContractCommand(args []string) int {
	if len(args) != 0 {
		return 1
	}
	payload, err := json.Marshal(bootstrapConfigContract{
		AgentVersion:    AgentVersion,
		ContractVersion: bootstrapConfigContractVersion,
		SupportedFlags:  bootstrapConfigSupportedFlags,
	})
	if err != nil {
		return 1
	}
	fmt.Println(string(payload))
	return 0
}
