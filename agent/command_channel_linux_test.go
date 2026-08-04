//go:build linux

package main

import (
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
