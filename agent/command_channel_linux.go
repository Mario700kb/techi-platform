//go:build linux

package main

// Agent command channel — one outbound WebSocket held open to the backend so
// interactive actions arrive immediately instead of waiting for the next
// heartbeat.
//
// Why: opening a Web Terminal took ~200s on this platform, because the agent
// did not learn a session existed until its next heartbeat (interval 250s at
// the time). The operator gave up every time and the session closed with
// reason=operator_closed. Shortening the interval only trades latency for
// load; holding one connection open is the model RustDesk already uses.
//
// Security posture is unchanged: this is the same outbound 443 connection the
// agent already makes for heartbeats, kept open rather than reopened. No
// listening port, no inbound rule, no NAT requirement. The channel is
// push-only — anything received is handed to the same runAction() the
// heartbeat path uses, so actions get identical ack/complete bookkeeping and
// identical callback authentication.
//
// LINUX ONLY, deliberately. Windows is healthy on the heartbeat path and is
// explicitly out of scope (owner instruction, 2026-08-04); command_channel_other.go
// provides a no-op so no other platform even compiles this.

import (
	"context"
	"encoding/json"
	"log"
	"math/rand"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	commandChannelMinBackoff  = 5 * time.Second
	commandChannelMaxBackoff  = 2 * time.Minute
	commandChannelPingPeriod  = 60 * time.Second
	commandChannelDialTimeout = 20 * time.Second
)

type commandEnvelope struct {
	Type   string        `json:"type"`
	Action PendingAction `json:"action"`
}

// commandChannelURL derives the channel URL from the websocket_url the backend
// handed out at enrolment. Returns "" when the agent is not enrolled yet or the
// URL is unusable — the caller then simply does not start the loop, and the
// heartbeat path keeps working exactly as before.
func commandChannelURL(cfg *Config) string {
	base := strings.TrimSpace(cfg.WebSocketURL)
	if base == "" || cfg.DeviceID <= 0 || strings.TrimSpace(cfg.AgentID) == "" {
		return ""
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Host == "" {
		return ""
	}
	q := url.Values{}
	q.Set("device_id", itoa(cfg.DeviceID))
	q.Set("agent_id", strings.TrimSpace(cfg.AgentID))
	return (&url.URL{
		Scheme:   parsed.Scheme,
		Host:     parsed.Host,
		Path:     "/ws/agent/commands",
		RawQuery: q.Encode(),
	}).String()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// runCommandChannel keeps the channel open for the life of the agent. It never
// returns an error to the caller: a channel that cannot be established is a
// missing optimisation, not a failure, and the agent must keep heartbeating
// regardless.
func runCommandChannel(ctx context.Context, cfg *Config) {
	backoff := commandChannelMinBackoff
	for {
		if ctx.Err() != nil {
			return
		}
		endpoint := commandChannelURL(cfg)
		if endpoint == "" {
			// Not enrolled yet, or no websocket_url. Re-check on the next
			// cycle rather than giving up for the process lifetime.
			if !sleepCtx(ctx, backoff) {
				return
			}
			continue
		}
		if err := serveCommandChannel(ctx, cfg, endpoint); err != nil && ctx.Err() == nil {
			log.Printf("[command-channel] disconnected: %v", err)
		}
		if !sleepCtx(ctx, jitter(backoff)) {
			return
		}
		backoff *= 2
		if backoff > commandChannelMaxBackoff {
			backoff = commandChannelMaxBackoff
		}
	}
}

// serveCommandChannel holds one connection until it drops.
func serveCommandChannel(ctx context.Context, cfg *Config, endpoint string) error {
	dialer := websocket.Dialer{HandshakeTimeout: commandChannelDialTimeout}
	conn, _, err := dialer.DialContext(ctx, endpoint, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	log.Printf("[command-channel] connected")

	// Keep the socket warm so idle NAT/proxy timeouts do not silently kill it,
	// and so the server's idle sweep can tell a live agent from a dead one.
	pingCtx, stopPing := context.WithCancel(ctx)
	defer stopPing()
	go func() {
		ticker := time.NewTicker(commandChannelPingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-ticker.C:
				if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping"}`)); err != nil {
					return
				}
			}
		}
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var env commandEnvelope
		if err := json.Unmarshal(data, &env); err != nil {
			log.Printf("[command-channel] ignoring unparsable message")
			continue
		}
		if env.Type != "action" || env.Action.Action == "" {
			continue
		}
		log.Printf("[command-channel] received action %d: %s", env.Action.ActionID, env.Action.Action)
		// Same entry point the heartbeat path uses, so ack/running/complete
		// reporting and callback authentication are identical. Run it detached
		// so a long action does not stall the read loop and stall the channel.
		go runAction(cfg, env.Action)
	}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// jitter spreads reconnect storms after a backend restart: without it every
// agent would return at the same instant, which is the same synchronisation
// problem the heartbeat fleet already has (RISK-AGENT-002).
func jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return d
	}
	delta := int64(d / 5) // ±20%
	if delta <= 0 {
		return d
	}
	return d + time.Duration(rand.Int63n(2*delta)-delta)
}
