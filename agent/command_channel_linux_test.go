//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Behavioural cover for the Linux-only command channel. The cross-platform
// boundary tests live in command_channel_test.go.

func TestCommandChannelURLRequiresEnrolment(t *testing.T) {
	cases := []struct {
		name string
		cfg  *Config
	}{
		{"no websocket url", &Config{DeviceID: 1, AgentID: "a"}},
		{"no device id", &Config{WebSocketURL: "wss://h/ws/devices", AgentID: "a"}},
		{"no agent id", &Config{WebSocketURL: "wss://h/ws/devices", DeviceID: 1}},
		{"blank agent id", &Config{WebSocketURL: "wss://h/ws/devices", DeviceID: 1, AgentID: "   "}},
		{"unparsable url", &Config{WebSocketURL: "://nope", DeviceID: 1, AgentID: "a"}},
	}
	for _, tc := range cases {
		if got := commandChannelURL(tc.cfg); got != "" {
			t.Fatalf("%s: expected no URL, got %q", tc.name, got)
		}
	}
}

func TestCommandChannelURLCarriesIdentity(t *testing.T) {
	cfg := &Config{
		WebSocketURL: "wss://api-rdp.techi.com.al/ws/devices?tenant_id=default",
		DeviceID:     729,
		AgentID:      "agent_bvtJWN",
	}
	got := commandChannelURL(cfg)
	for _, want := range []string{
		"wss://api-rdp.techi.com.al/ws/agent/commands",
		"device_id=729",
		"agent_id=agent_bvtJWN",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("URL %q missing %q", got, want)
		}
	}
	// The host is reused from enrolment so the channel follows the backend
	// wherever /ws/devices already points; the source query must not leak.
	if strings.Contains(got, "tenant_id") {
		t.Fatalf("query from the source URL must not leak through: %q", got)
	}
}

func TestItoaMatchesSmallIntegers(t *testing.T) {
	for _, tc := range []struct {
		in   int
		want string
	}{{0, "0"}, {7, "7"}, {729, "729"}, {123456, "123456"}} {
		if got := itoa(tc.in); got != tc.want {
			t.Fatalf("itoa(%d) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestJitterStaysWithinTwentyPercent(t *testing.T) {
	base := 100 * 1000 * 1000 // 100ms in ns
	for i := 0; i < 200; i++ {
		got := int(jitter(time.Duration(base)))
		if got < base-base/5 || got > base+base/5 {
			t.Fatalf("jitter produced %d, outside ±20%% of %d", got, base)
		}
	}
}

// TestChannelObservesEnrolmentWithoutRestart pins the fix for the 2026-08-05
// defect: the loop must read the config from disk, because enrolment persists
// agent_id/device_id there from a different Config struct entirely
// (runSingleHeartbeat loads its own). Holding the startup struct meant a
// freshly-enrolled host never opened the channel until it was restarted.
func TestChannelObservesEnrolmentWithoutRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.config.json")

	// Written by the installer: no identity yet.
	unenrolled := `{"websocket_url":"wss://example.test/ws/devices","backend_url":"https://example.test/hb"}`
	if err := os.WriteFile(path, []byte(unenrolled), 0600); err != nil {
		t.Fatal(err)
	}

	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if commandChannelURL(cfg) != "" {
		t.Fatal("an unenrolled config must not yield a channel URL")
	}

	// Enrolment persists identity to disk, exactly as runSingleHeartbeat does.
	enrolled := `{"websocket_url":"wss://example.test/ws/devices","backend_url":"https://example.test/hb","agent_id":"agent_abc","device_id":812}`
	if err := os.WriteFile(path, []byte(enrolled), 0600); err != nil {
		t.Fatal(err)
	}

	reloaded, err := loadConfig(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	url := commandChannelURL(reloaded)
	if url == "" {
		t.Fatal("after enrolment the channel URL must resolve")
	}
	if !strings.Contains(url, "device_id=812") || !strings.Contains(url, "agent_id=agent_abc") {
		t.Fatalf("URL must carry the enrolled identity, got %q", url)
	}

	// The stale struct still yields nothing — which is why the loop must not
	// keep one.
	if commandChannelURL(cfg) != "" {
		t.Fatal("the pre-enrolment struct must remain empty; the loop has to reload")
	}
}

func TestRunCommandChannelTakesAPathNotAStruct(t *testing.T) {
	src := readAgentFile(t, "command_channel_linux.go")
	if !strings.Contains(src, "func runCommandChannel(ctx context.Context, configPath string)") {
		t.Fatal("the loop must take the config path so it can reload after enrolment")
	}
	if !strings.Contains(src, "loadConfig(configPath)") {
		t.Fatal("the loop must reload the config from disk each cycle")
	}
}
