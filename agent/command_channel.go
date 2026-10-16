//go:build linux || windows

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
// Linux and Windows. It was Linux-only from 2026-08-04 until the owner asked
// for live device data (2026-10-16): Windows now uses it so single-device
// actions run within seconds and an open device page can stream a live view
// (live.go). Reconnects are spread over a minute so a backend restart is not
// met by the whole fleet at once. command_channel_other.go keeps every other
// platform on the heartbeat alone.

import (
	"context"
	"encoding/json"
	"log"
	"math/rand"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	commandChannelMinBackoff  = 5 * time.Second
	commandChannelMaxBackoff  = 2 * time.Minute
	commandChannelPingPeriod  = 60 * time.Second
	commandChannelDialTimeout = 20 * time.Second
	// A connection that stayed up this long was healthy: the next drop starts
	// the backoff from the bottom again instead of where the last outage left it.
	commandChannelHealthyAfter = 2 * time.Minute
	// After a healthy connection drops (usually a backend restart) the first
	// retry waits a random time up to this, so ~900 agents return over a
	// minute instead of within the same few seconds.
	commandChannelReconnectSpread = time.Minute
	commandChannelWriteTimeout    = 10 * time.Second
)

type commandEnvelope struct {
	Type            string        `json:"type"`
	Action          PendingAction `json:"action"`
	IntervalSeconds int           `json:"interval_seconds"`
	TTLSeconds      int           `json:"ttl_seconds"`
}

// channelWriter serialises writes: gorilla/websocket allows one writer at a
// time, and the ping loop and the live stream both write.
type channelWriter struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (w *channelWriter) write(data []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.conn.SetWriteDeadline(time.Now().Add(commandChannelWriteTimeout))
	return w.conn.WriteMessage(websocket.TextMessage, data)
}

// commandChannelURL derives the channel URL from the websocket_url the backend
// handed out at enrolment. Returns "" when the agent is not enrolled yet or the
// URL is unusable — the caller then simply does not start the loop, and the
// heartbeat path keeps working exactly as before.
func commandChannelURL(cfg *Config) string {
	base := strings.TrimSpace(cfg.WebSocketURL)
	if base == "" {
		// Configs written before enrolment returned websocket_url: the
		// channel lives on the same host the heartbeat goes to.
		base = websocketBaseFrom(firstNonBlank(cfg.APIURL, cfg.BackendURL))
	}
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

// websocketBaseFrom turns the heartbeat URL into the WebSocket origin of the
// same host (https → wss, http → ws). "" when it is not an http(s) URL.
func websocketBaseFrom(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return ""
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https":
		return "wss://" + parsed.Host
	case "http":
		return "ws://" + parsed.Host
	}
	return ""
}

func firstNonBlank(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
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
// runCommandChannel takes the config PATH, not a *Config, and reloads it every
// cycle. That is not a style choice: enrolment happens inside
// runSingleHeartbeat, which loads its OWN Config from disk and persists the
// agent_id/device_id there. A long-lived goroutine holding the struct loaded at
// startup would never observe them, so on a freshly-enrolled host the channel
// stayed dark for the whole process lifetime and only appeared after a restart
// (device 812, 2026-08-05).
func runCommandChannel(ctx context.Context, configPath string) {
	backoff := commandChannelMinBackoff
	for {
		if ctx.Err() != nil {
			return
		}
		cfg, err := loadConfig(configPath)
		if err != nil {
			if !sleepCtx(ctx, backoff) {
				return
			}
			continue
		}
		applyEnvironment(cfg)
		endpoint := commandChannelURL(cfg)
		if endpoint == "" {
			// Not enrolled yet, or no websocket_url. Re-check on the next
			// cycle rather than giving up for the process lifetime.
			if !sleepCtx(ctx, backoff) {
				return
			}
			continue
		}
		connectedAt := time.Now()
		if err := serveCommandChannel(ctx, cfg, endpoint); err != nil && ctx.Err() == nil {
			log.Printf("[command-channel] disconnected: %v", err)
		}
		wait := jitter(backoff)
		if time.Since(connectedAt) >= commandChannelHealthyAfter {
			backoff = commandChannelMinBackoff
			wait = reconnectAfterHealthy()
		} else {
			backoff *= 2
			if backoff > commandChannelMaxBackoff {
				backoff = commandChannelMaxBackoff
			}
		}
		if !sleepCtx(ctx, wait) {
			return
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
	writer := &channelWriter{conn: conn}
	// A live view never outlives the connection it was requested on.
	defer agentLive.stop()

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
				if err := writer.write([]byte(`{"type":"ping"}`)); err != nil {
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
		switch env.Type {
		case "action":
			if env.Action.Action == "" {
				continue
			}
			log.Printf("[command-channel] received action %d: %s", env.Action.ActionID, env.Action.Action)
			// Same entry point the heartbeat path uses, so ack/running/complete
			// reporting and callback authentication are identical. Run it
			// detached so a long action does not stall the read loop.
			go func(action PendingAction) {
				runAction(cfg, action)
				// Actions that ask for a fresh heartbeat (Refresh inventory,
				// Heartbeat now, restart) get it now, not at the next tick.
				if pendingImmediateHeartbeat.Load() {
					wakeHeartbeat()
				}
			}(env.Action)
		case "live_start":
			agentLive.request(env.IntervalSeconds, env.TTLSeconds, writer.write)
		case "live_stop":
			agentLive.stop()
		}
	}
}

// reconnectAfterHealthy is the first wait after a long-lived connection
// dropped: at least the minimum backoff, spread at random over a minute.
func reconnectAfterHealthy() time.Duration {
	return commandChannelMinBackoff + time.Duration(rand.Int63n(int64(commandChannelReconnectSpread)))
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
