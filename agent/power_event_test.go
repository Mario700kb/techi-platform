package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type recordingBackend struct {
	mu       sync.Mutex
	requests []recordedRequest
	status   int
}

type recordedRequest struct {
	path string
	body map[string]any
}

func newRecordingBackend(t *testing.T) (*recordingBackend, *httptest.Server) {
	t.Helper()
	backend := &recordingBackend{status: http.StatusNoContent}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		backend.mu.Lock()
		backend.requests = append(backend.requests, recordedRequest{path: r.URL.Path, body: body})
		status := backend.status
		backend.mu.Unlock()
		if r.URL.Path == heartbeatPath {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"device_id":42}`))
			return
		}
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	return backend, srv
}

func (b *recordingBackend) paths() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]string, 0, len(b.requests))
	for _, r := range b.requests {
		out = append(out, r.path)
	}
	return out
}

func writePowerTestConfig(t *testing.T, backendURL string, deviceID int, agentID string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.config.json")
	data, err := json.Marshal(map[string]any{
		"backend_url":     backendURL + heartbeatPath,
		"device_id":       deviceID,
		"agent_id":        agentID,
		"timeout_seconds": 2,
		"retries":         1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func resetHeartbeatPause(t *testing.T) {
	t.Helper()
	t.Setenv("TECHI_API_URL", "")
	t.Setenv("TECHI_BACKEND_URL", "")
	resumeHeartbeats()
	t.Cleanup(resumeHeartbeats)
}

func testHeartbeatConfig(srvURL string) *Config {
	cfg := &Config{BackendURL: srvURL + heartbeatPath, TimeoutSeconds: 2, Retries: 1, RetryDelaySecond: 1}
	return cfg
}

func TestPowerEventURLIsDerivedFromTheHeartbeatURL(t *testing.T) {
	cfg := &Config{BackendURL: "https://api-rdp.techi.com.al/api/v1/agent/heartbeat"}
	if got, want := powerEventURL(cfg), "https://api-rdp.techi.com.al/api/v1/agent/power-event"; got != want {
		t.Fatalf("powerEventURL = %q, want %q", got, want)
	}
}

func TestSendPowerEventPostsIdentityAndState(t *testing.T) {
	backend, srv := newRecordingBackend(t)
	cfg := &Config{BackendURL: srv.URL + heartbeatPath, DeviceID: 42, AgentID: "agent_x"}

	if err := sendPowerEvent(cfg, powerStateShutdown, time.Second); err != nil {
		t.Fatalf("sendPowerEvent: %v", err)
	}

	if len(backend.requests) != 1 {
		t.Fatalf("requests = %d, want 1", len(backend.requests))
	}
	got := backend.requests[0]
	if got.path != powerEventPath {
		t.Fatalf("path = %q, want %q", got.path, powerEventPath)
	}
	if got.body["device_id"] != float64(42) || got.body["agent_id"] != "agent_x" || got.body["state"] != "shutdown" {
		t.Fatalf("body = %v", got.body)
	}
}

func TestSendPowerEventReportsARefusal(t *testing.T) {
	backend, srv := newRecordingBackend(t)
	backend.status = http.StatusForbidden
	cfg := &Config{BackendURL: srv.URL + heartbeatPath, DeviceID: 42, AgentID: "agent_x"}

	if err := sendPowerEvent(cfg, powerStateSleep, time.Second); err == nil {
		t.Fatal("expected an error for a 403")
	}
}

func TestSendPowerEventNeedsAnEnrolledIdentity(t *testing.T) {
	backend, srv := newRecordingBackend(t)
	for _, cfg := range []*Config{
		{BackendURL: srv.URL + heartbeatPath, AgentID: "agent_x"},
		{BackendURL: srv.URL + heartbeatPath, DeviceID: 42, AgentID: "  "},
	} {
		if err := sendPowerEvent(cfg, powerStateShutdown, time.Second); err == nil {
			t.Fatalf("expected an error for %+v", cfg)
		}
	}
	if len(backend.paths()) != 0 {
		t.Fatalf("no request may be sent without an identity, got %v", backend.paths())
	}
}

func TestReportPowerEventPausesHeartbeatsUntilResume(t *testing.T) {
	resetHeartbeatPause(t)
	backend, srv := newRecordingBackend(t)
	configPath := writePowerTestConfig(t, srv.URL, 42, "agent_x")

	reportPowerEvent(configPath, powerStateSleep, time.Second, time.Second)

	if _, err := sendHeartbeat(testHeartbeatConfig(srv.URL), &HeartbeatPayload{Hostname: "ws-01"}); !errors.Is(err, errHeartbeatsPaused) {
		t.Fatalf("heartbeat after the power event: err = %v, want errHeartbeatsPaused", err)
	}

	resumeHeartbeats()
	if _, err := sendHeartbeat(testHeartbeatConfig(srv.URL), &HeartbeatPayload{Hostname: "ws-01"}); err != nil {
		t.Fatalf("heartbeat after resume: %v", err)
	}

	got := backend.paths()
	want := []string{powerEventPath, heartbeatPath}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("requests = %v, want %v", got, want)
	}
}

func TestReportPowerEventWaitsForTheHeartbeatInFlight(t *testing.T) {
	resetHeartbeatPause(t)
	backend, srv := newRecordingBackend(t)
	configPath := writePowerTestConfig(t, srv.URL, 42, "agent_x")

	if err := acquireHeartbeatSlot(); err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		time.Sleep(100 * time.Millisecond)
		backend.mu.Lock()
		backend.requests = append(backend.requests, recordedRequest{path: "in-flight heartbeat done"})
		backend.mu.Unlock()
		releaseHeartbeatSlot()
		close(released)
	}()

	reportPowerEvent(configPath, powerStateShutdown, 2*time.Second, time.Second)
	<-released

	got := backend.paths()
	if len(got) != 2 || got[0] != "in-flight heartbeat done" || got[1] != powerEventPath {
		t.Fatalf("the power event must follow the in-flight heartbeat, got %v", got)
	}
}

func TestReportPowerEventGivesUpWhenTheSlotStaysBusy(t *testing.T) {
	resetHeartbeatPause(t)
	backend, srv := newRecordingBackend(t)
	configPath := writePowerTestConfig(t, srv.URL, 42, "agent_x")

	if err := acquireHeartbeatSlot(); err != nil {
		t.Fatal(err)
	}
	defer releaseHeartbeatSlot()

	reportPowerEvent(configPath, powerStateSleep, 50*time.Millisecond, time.Second)

	if got := backend.paths(); len(got) != 0 {
		t.Fatalf("no power event may be sent while a heartbeat holds the slot, got %v", got)
	}
}

func TestHeartbeatPauseExpiresOnItsOwn(t *testing.T) {
	resetHeartbeatPause(t)
	now := time.Now()

	pauseHeartbeats(now)
	if !heartbeatsPaused(now.Add(time.Minute)) {
		t.Fatal("a fresh pause must hold")
	}
	if heartbeatsPaused(now.Add(heartbeatPauseExpiry + time.Second)) {
		t.Fatal("an expired pause must lift")
	}
	if heartbeatsPaused(now) {
		t.Fatal("an expired pause must be cleared, not just ignored")
	}
}
