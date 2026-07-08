//go:build linux

package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

// handleOpenTerminal dials the backend terminal WS and bridges it to a local
// PTY (Platform Expansion Phase 5). Fully isolated: it launches a detached
// goroutine and returns immediately, so it never blocks or interferes with
// heartbeat/enrollment/inventory/updates/RustDesk. Off unless the server sends
// this action (only when FEATURE_TERMINAL is on server-side).
func handleOpenTerminal(_ context.Context, _ *Config, params map[string]interface{}) actionResult {
	wsURL, _ := params["ws_url"].(string)
	engine, _ := params["engine"].(string)
	if strings.TrimSpace(wsURL) == "" {
		return actionResult{err: fmt.Errorf("open_terminal: missing ws_url")}
	}
	go runTerminalSession(wsURL, engine)
	return actionResult{message: "open_terminal: terminal session dialing"}
}

func runTerminalSession(wsURL, engine string) {
	shell := "bash"
	switch strings.ToLower(strings.TrimSpace(engine)) {
	case "sh":
		shell = "sh"
	case "bash", "":
		shell = "bash"
	default:
		shell = "bash"
	}
	if _, err := exec.LookPath(shell); err != nil {
		shell = "sh"
	}

	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		log.Printf("[terminal] dial failed: %v", err)
		return
	}
	defer conn.Close()

	cmd := exec.Command(shell)
	cmd.Env = append(cmd.Env, "TERM=xterm-256color")
	ptmx, err := pty.Start(cmd)
	if err != nil {
		log.Printf("[terminal] pty start failed: %v", err)
		return
	}
	defer func() { _ = ptmx.Close() }()

	// Hard cap so a forgotten session cannot live forever on the endpoint.
	done := make(chan struct{})
	go func() {
		select {
		case <-time.After(60 * time.Minute):
			_ = conn.Close()
			_ = ptmx.Close()
		case <-done:
		}
	}()
	defer close(done)

	// PTY output → WebSocket (binary frames).
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				if werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				if err != io.EOF {
					log.Printf("[terminal] pty read: %v", err)
				}
				_ = conn.Close()
				return
			}
		}
	}()

	// WebSocket → PTY input (operator keystrokes / control JSON for resize).
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if msgType == websocket.TextMessage && handleTerminalControl(ptmx, data) {
			continue
		}
		if _, werr := ptmx.Write(data); werr != nil {
			return
		}
	}
}

// handleTerminalControl interprets a resize control frame: {"t":"resize","cols":N,"rows":M}.
func handleTerminalControl(ptmx *os.File, data []byte) bool {
	s := string(data)
	if !strings.Contains(s, "\"t\":\"resize\"") {
		return false
	}
	cols := extractInt(s, "\"cols\":")
	rows := extractInt(s, "\"rows\":")
	if cols > 0 && rows > 0 {
		_ = pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	}
	return true
}

func extractInt(s, key string) int {
	idx := strings.Index(s, key)
	if idx == -1 {
		return 0
	}
	rest := s[idx+len(key):]
	n := 0
	for _, r := range rest {
		if r < '0' || r > '9' {
			break
		}
		n = n*10 + int(r-'0')
	}
	return n
}
