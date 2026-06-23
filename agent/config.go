package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const defaultLocalAPIURL = "http://localhost:8000"
const heartbeatPath = "/api/v1/agent/heartbeat"

type Config struct {
	BackendURL       string `json:"backend_url"`
	APIURL           string `json:"api_url"`
	WebSocketURL     string `json:"websocket_url"`
	EnrollmentToken  string `json:"enrollment_token,omitempty"`
	AgentName        string `json:"agent_name,omitempty"`
	AgentID          string `json:"agent_id,omitempty"`
	DeviceID         int    `json:"device_id,omitempty"`
	RustDeskID       string `json:"rustdesk_id"`
	PublicIPService  string `json:"public_ip_service"`
	TimeoutSeconds   int    `json:"timeout_seconds"`
	HeartbeatSeconds int    `json:"heartbeat_interval_seconds"`
	Retries          int    `json:"retries"`
	RetryDelaySecond int    `json:"retry_delay_seconds"`
	CollectProcesses bool   `json:"collect_processes"`
	CollectSoftware  bool   `json:"collect_software"`
	CollectServices  bool   `json:"collect_services"`

	// TECHI Remote Support self-healing policy (Windows only)
	RustDeskManageEnabled     bool   `json:"rustdesk_manage_enabled"`
	RustDeskForceConfig       bool   `json:"rustdesk_force_config"`
	RustDeskMSIUrl            string `json:"rustdesk_msi_url,omitempty"`
	RustDeskRendezvousServer  string `json:"rustdesk_rendezvous_server,omitempty"`
	RustDeskRelayServer       string `json:"rustdesk_relay_server,omitempty"`
	RustDeskAPIServer         string `json:"rustdesk_api_server,omitempty"`
	RustDeskKey               string `json:"rustdesk_key,omitempty"`
	RustDeskDefaultPassword   string `json:"rustdesk_default_password,omitempty"`
	RustDeskMSIChecksumSHA256 string `json:"rustdesk_msi_checksum_sha256,omitempty"`
	RustDeskPackageVersion    string `json:"rustdesk_package_version,omitempty"`
	RustDeskLastRepairAt      string `json:"rustdesk_last_repair_at,omitempty"`
	RustDeskRepairCount       int    `json:"rustdesk_repair_count,omitempty"`

	// Availability profile — controls power policy (Windows only).
	// "server": prevent sleep + hibernate on AC; "workstation": use explicit flags; "custom": use explicit flags.
	// Lock screen is NEVER disabled regardless of profile.
	AvailabilityProfile string `json:"availability_profile,omitempty"` // "server" | "workstation" | "custom"
	ManagePowerPolicy   bool   `json:"manage_power_policy"`
	PreventSleepOnAC    bool   `json:"prevent_sleep_on_ac"`
	PreventHibernate    bool   `json:"prevent_hibernate"`
	AllowDisplayOffOnAC bool   `json:"allow_display_off_on_ac"`
}

func defaultConfig() Config {
	return Config{
		BackendURL:       defaultLocalAPIURL + heartbeatPath,
		APIURL:           defaultLocalAPIURL,
		RustDeskID:       "",
		PublicIPService:  "https://api.ipify.org?format=text",
		TimeoutSeconds:   10,
		HeartbeatSeconds: 60,
		Retries:          3,
		RetryDelaySecond: 5,
		CollectProcesses: false,
		CollectServices:  false,
		CollectSoftware:  false,
	}
}

func loadConfig(path string) (*Config, error) {
	cfg := Config{}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "config file not found at %s, using defaults\n", path)
			cfg := defaultConfig()
			return &cfg, nil
		}
		return nil, err
	}

	data = trimUTF8BOM(data)
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}

	applyConfigDefaults(&cfg)
	return &cfg, nil
}

func applyConfigDefaults(cfg *Config) {
	cfg.APIURL = normalizeProductionHTTPS(cfg.APIURL)
	cfg.BackendURL = normalizeProductionHTTPS(cfg.BackendURL)
	cfg.WebSocketURL = normalizeProductionWSS(cfg.WebSocketURL)
	if cfg.APIURL == "" {
		cfg.APIURL = backendBaseURL(cfg.BackendURL)
	}
	if cfg.APIURL == "" {
		cfg.APIURL = defaultLocalAPIURL
	}
	if cfg.BackendURL == "" {
		cfg.BackendURL = strings.TrimRight(cfg.APIURL, "/") + heartbeatPath
	} else {
		cfg.BackendURL = normalizeHeartbeatURL(cfg.BackendURL)
		if cfg.APIURL == defaultLocalAPIURL {
			if base := backendBaseURL(cfg.BackendURL); base != "" {
				cfg.APIURL = base
			}
		}
	}
	if cfg.RustDeskID == "" {
		cfg.RustDeskID = ""
	}
	if cfg.PublicIPService == "" {
		cfg.PublicIPService = "https://api.ipify.org?format=text"
	}
	if cfg.WebSocketURL == "" && strings.Contains(cfg.APIURL, "api-rdp.techi.com.al") {
		cfg.WebSocketURL = "wss://api-rdp.techi.com.al/ws/devices?tenant_id=default"
	}
	if cfg.TimeoutSeconds <= 0 {
		cfg.TimeoutSeconds = 10
	}
	if cfg.HeartbeatSeconds <= 0 {
		cfg.HeartbeatSeconds = 60
	}
	if cfg.Retries <= 0 {
		cfg.Retries = 3
	}
	if cfg.RetryDelaySecond <= 0 {
		cfg.RetryDelaySecond = 5
	}
}

func applyEnvironment(cfg *Config) {
	if value := os.Getenv("TECHI_API_URL"); value != "" {
		apiURL := normalizeProductionHTTPS(strings.TrimRight(value, "/"))
		if cfg.BackendURL == "" || strings.HasPrefix(cfg.BackendURL, defaultLocalAPIURL) {
			cfg.APIURL = apiURL
			cfg.BackendURL = apiURL + heartbeatPath
		}
	}
	if value := os.Getenv("TECHI_BACKEND_URL"); value != "" {
		cfg.BackendURL = normalizeHeartbeatURL(normalizeProductionHTTPS(value))
		if base := backendBaseURL(cfg.BackendURL); base != "" {
			cfg.APIURL = base
		}
	}
	if value := os.Getenv("TECHI_ENROLLMENT_TOKEN"); value != "" {
		cfg.EnrollmentToken = value
	}
}

func trimUTF8BOM(data []byte) []byte {
	if len(data) >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf {
		return data[3:]
	}
	return data
}

func normalizeHeartbeatURL(value string) string {
	url := normalizeProductionHTTPS(strings.TrimRight(strings.TrimSpace(value), "/"))
	if url == "" {
		return ""
	}
	if strings.HasSuffix(url, heartbeatPath) {
		return url
	}
	return url + heartbeatPath
}

func normalizeProductionHTTPS(value string) string {
	url := strings.TrimSpace(value)
	if strings.HasPrefix(url, "http://api-rdp.techi.com.al") {
		return "https://" + strings.TrimPrefix(url, "http://")
	}
	return url
}

func normalizeProductionWSS(value string) string {
	url := strings.TrimSpace(value)
	if strings.HasPrefix(url, "ws://api-rdp.techi.com.al") {
		return "wss://" + strings.TrimPrefix(url, "ws://")
	}
	return url
}

func backendBaseURL(backendURL string) string {
	url := strings.TrimRight(strings.TrimSpace(backendURL), "/")
	if url == "" {
		return ""
	}
	return strings.TrimSuffix(url, heartbeatPath)
}

func saveConfig(path string, cfg *Config) error {
	return writeConfig(path, cfg, true)
}

func saveConfigWithEnrollmentToken(path string, cfg *Config) error {
	return writeConfig(path, cfg, false)
}

func writeConfig(path string, cfg *Config, scrubEnrollmentToken bool) error {
	out := *cfg
	if scrubEnrollmentToken {
		out.EnrollmentToken = ""
	}
	if dir := filepath.Dir(path); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	data, err := json.MarshalIndent(&out, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}
