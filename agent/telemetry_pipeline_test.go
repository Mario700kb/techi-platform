package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func f64(v float64) *float64 { return &v }

func testSample(at time.Time, cpu float64) *telemetrySample {
	return &telemetrySample{TS: at.UTC().Format(time.RFC3339), CPU: f64(cpu), Mem: f64(40),
		Disks: []sampleDisk{{Mount: "C:", UsedPct: 54, FreeGB: 108, TotalGB: 238}}}
}

// ── buffer ──────────────────────────────────────────────────────────────────

func TestBufferKeepsSamplesAcrossARestartUntilAcknowledged(t *testing.T) {
	dir := t.TempDir()
	b, err := openTelemetryBuffer(dir, 50<<20, 7*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now().Add(-time.Hour).Truncate(time.Minute)
	for i := 0; i < 5; i++ {
		if err := b.append(testSample(start.Add(time.Duration(i)*time.Minute), 10)); err != nil {
			t.Fatal(err)
		}
	}
	b.close() // the agent restarts

	b, _ = openTelemetryBuffer(dir, 50<<20, 7*24*time.Hour)
	batch, last, total, oldest := b.pending(100)
	if len(batch) != 5 || last != 5 || total != 5 || !oldest.Equal(start) {
		t.Fatalf("after restart: %d samples, last %d, total %d, oldest %s", len(batch), last, total, oldest)
	}
	_ = b.append(testSample(start.Add(5*time.Minute), 10))
	if _, last, _, _ := b.pending(100); last != 6 {
		t.Fatalf("numbering must continue after a restart, got last seq %d", last)
	}

	b.ack(4)
	if batch, _, total, _ := b.pending(100); len(batch) != 2 || total != 2 {
		t.Fatalf("after ack 4: %d pending", total)
	}
	b.ack(6)
	b.close()
	b, _ = openTelemetryBuffer(dir, 50<<20, 7*24*time.Hour)
	if batch, _, _, _ := b.pending(100); len(batch) != 0 {
		t.Fatalf("acknowledged samples came back: %d", len(batch))
	}
	_ = b.append(testSample(start.Add(6*time.Minute), 10))
	if _, last, _, _ := b.pending(100); last != 7 {
		t.Fatalf("numbering after everything was delivered: got %d, want 7", last)
	}
	segs, _ := b.segments()
	if len(segs) != 1 {
		t.Fatalf("delivered files should be gone, %d left", len(segs))
	}
}

func TestBufferSkipsALineTornByAPowerCut(t *testing.T) {
	dir := t.TempDir()
	b, _ := openTelemetryBuffer(dir, 50<<20, 7*24*time.Hour)
	now := time.Now().Truncate(time.Minute)
	_ = b.append(testSample(now.Add(-2*time.Minute), 10))
	_ = b.append(testSample(now.Add(-time.Minute), 20))
	b.close()
	segs, _ := b.segments()
	f, _ := os.OpenFile(segs[0].path, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString(`1234abcd {"seq":3,"ts":"2026-`) // cut mid-write
	f.Close()

	b, _ = openTelemetryBuffer(dir, 50<<20, 7*24*time.Hour)
	batch, last, _, _ := b.pending(100)
	if len(batch) != 2 || last != 2 {
		t.Fatalf("want the two intact samples, got %d (last %d)", len(batch), last)
	}
}

func TestBufferOverItsCapDropsTheOldestAndCountsThem(t *testing.T) {
	dir := t.TempDir()
	b, _ := openTelemetryBuffer(dir, 1, 7*24*time.Hour) // one byte: only the newest file stays
	start := time.Now().Add(-48 * time.Hour).Truncate(time.Minute)
	for i := 0; i < telemetrySegmentSamples+3; i++ {
		_ = b.append(testSample(start.Add(time.Duration(i)*time.Minute), 10))
	}
	batch, _, total, _ := b.pending(10000)
	if total != 3 || len(batch) != 3 {
		t.Fatalf("want the 3 samples of the newest file, got %d", total)
	}
	if b.dropped() != telemetrySegmentSamples {
		t.Fatalf("dropped %d, want %d", b.dropped(), telemetrySegmentSamples)
	}
}

// ── monitors ────────────────────────────────────────────────────────────────

func TestAMonitorFiresAfterItsDurationAndClearsWithAMargin(t *testing.T) {
	rules := []monitorRule{{Key: "cpu", Metric: "cpu", Op: ">", Threshold: 95, DurationS: 900, Severity: "critical", Enabled: true}}
	states := map[string]*monitorState{}
	t0 := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }

	events := evaluateMonitors(rules, states, testSample(at(0), 97), at(0))
	if len(events) != 0 {
		t.Fatalf("fired before its 15 minutes: %+v", events)
	}
	for m := 1; m < 15; m++ {
		if ev := evaluateMonitors(rules, states, testSample(at(m), 98), at(m)); len(ev) != 0 {
			t.Fatalf("minute %d: %+v", m, ev)
		}
	}
	events = evaluateMonitors(rules, states, testSample(at(15), 99), at(15))
	if len(events) != 1 || events[0].State != "firing" || events[0].Since != t0.Format(time.RFC3339) || *events[0].Value != 99 {
		t.Fatalf("want firing since 09:00, got %+v", events)
	}
	// 93 is under the threshold but inside the 5% margin: still firing.
	for m := 16; m < 20; m++ {
		if ev := evaluateMonitors(rules, states, testSample(at(m), 93), at(m)); len(ev) != 0 {
			t.Fatalf("cleared inside the margin: %+v", ev)
		}
	}
	if ev := evaluateMonitors(rules, states, testSample(at(20), 40), at(20)); len(ev) != 0 {
		t.Fatalf("cleared after one sample: %+v", ev)
	}
	events = evaluateMonitors(rules, states, testSample(at(21), 35), at(21))
	if len(events) != 1 || events[0].State != "ok" {
		t.Fatalf("want ok after two clear samples, got %+v", events)
	}
}

func TestAfterAStartEveryQuietMonitorReportsOkOnce(t *testing.T) {
	rules := []monitorRule{
		{Key: "cpu", Metric: "cpu", Op: ">", Threshold: 95, DurationS: 900, Enabled: true},
		{Key: "disk", Metric: "disk", Op: ">", Threshold: 90, Enabled: true},
		{Key: "off", Metric: "mem", Op: ">", Threshold: 1, Enabled: false},
	}
	states := map[string]*monitorState{}
	now := time.Now()
	events := evaluateMonitors(rules, states, testSample(now, 10), now)
	if len(events) != 2 || events[0].State != "ok" || events[1].Target != "C:" {
		t.Fatalf("want one ok per enabled monitor, got %+v", events)
	}
	if ev := evaluateMonitors(rules, states, testSample(now, 10), now.Add(time.Minute)); len(ev) != 0 {
		t.Fatalf("ok repeated: %+v", ev)
	}
}

func TestADiskMonitorNamesTheFullestDisk(t *testing.T) {
	rules := []monitorRule{{Key: "disk", Metric: "disk", Op: ">", Threshold: 90, Enabled: true}}
	s := testSample(time.Now(), 10)
	s.Disks = append(s.Disks, sampleDisk{Mount: "D:", UsedPct: 96})
	events := evaluateMonitors(rules, map[string]*monitorState{}, s, time.Now())
	if len(events) != 1 || events[0].State != "firing" || events[0].Target != "D:" || *events[0].Value != 96 {
		t.Fatalf("got %+v", events)
	}
}

// ── policy ──────────────────────────────────────────────────────────────────

func TestAMissingPolicyKeepsTheCurrentOne(t *testing.T) {
	saved := telemetryRuntime
	telemetryRuntime = &telemetryPipelineState{changed: make(chan struct{}, 1)}
	defer func() { telemetryRuntime = saved }()

	applyMonitoringPolicy(json.RawMessage(`{"version":"1.1","sample_seconds":5,"upload_seconds":900,"monitors":[]}`))
	applyMonitoringPolicy(nil)
	applyMonitoringPolicy(json.RawMessage(`null`))
	p := telemetryRuntime.currentPolicy()
	if p == nil || p.Version != "1.1" {
		t.Fatalf("policy lost: %+v", p)
	}
	if p.SampleSeconds != 30 || p.BufferMB != 50 || p.KeepDays != 7 {
		t.Fatalf("limits not applied: %+v", p)
	}
}

// ── upload ──────────────────────────────────────────────────────────────────

type fakePlatform struct {
	mu       sync.Mutex
	status   int
	received []telemetryUploadBody
}

func (f *fakePlatform) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Path != "/api/v1/agent/telemetry" || r.Header.Get("Content-Encoding") != "gzip" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	zr, err := gzip.NewReader(r.Body)
	if err != nil {
		http.Error(w, "not gzip", http.StatusBadRequest)
		return
	}
	data, _ := io.ReadAll(zr)
	var body telemetryUploadBody
	_ = json.Unmarshal(data, &body)
	f.received = append(f.received, body)
	if f.status != 0 {
		http.Error(w, "nope", f.status)
		return
	}
	var maxSeq int64
	for _, raw := range body.Samples {
		var s telemetrySample
		_ = json.Unmarshal(raw, &s)
		if s.Seq > maxSeq {
			maxSeq = s.Seq
		}
	}
	_ = json.NewEncoder(w).Encode(telemetryAck{AckSeq: maxSeq, Stored: len(body.Samples), PolicyVersion: "1.1", NextUploadSeconds: 900})
}

func setupUpload(t *testing.T) (string, *telemetryBuffer, *fakePlatform) {
	t.Helper()
	saved := telemetryRuntime
	telemetryRuntime = &telemetryPipelineState{changed: make(chan struct{}, 1)}
	t.Cleanup(func() { telemetryRuntime = saved })
	applyMonitoringPolicy(json.RawMessage(`{"version":"1.1","sample_seconds":60,"upload_seconds":900}`))

	platform := &fakePlatform{}
	server := httptest.NewServer(http.HandlerFunc(platform.handler))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	configPath := filepath.Join(dir, "agent.config.json")
	cfg := map[string]interface{}{"backend_url": server.URL + heartbeatPath, "device_id": 924, "agent_id": "agent_X", "timeout_seconds": 5}
	data, _ := json.Marshal(cfg)
	_ = os.WriteFile(configPath, data, 0o600)
	b, err := openTelemetryBuffer(filepath.Join(dir, "telemetry"), 50<<20, 7*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.close)
	return configPath, b, platform
}

func TestAnUploadSendsTheBufferAndForgetsWhatWasAcknowledged(t *testing.T) {
	configPath, b, platform := setupUpload(t)
	start := time.Now().Add(-20 * time.Minute).Truncate(time.Minute)
	for i := 0; i < 15; i++ {
		_ = b.append(testSample(start.Add(time.Duration(i)*time.Minute), 10))
	}
	telemetryRuntime.report([]monitorEvent{{Key: "cpu", State: "ok"}}, false)

	if next := uploadTelemetry(context.Background(), configPath, b); next != 900 {
		t.Fatalf("next upload %d", next)
	}
	got := platform.received[0]
	if got.DeviceID != 924 || got.AgentID != "agent_X" || len(got.Samples) != 15 || len(got.Events) != 1 {
		t.Fatalf("upload body: device %d agent %q samples %d events %d", got.DeviceID, got.AgentID, len(got.Samples), len(got.Events))
	}
	if got.Buffer.Pending != 15 || got.PolicyVersion != "1.1" || got.SampleSeconds != 60 {
		t.Fatalf("buffer report %+v policy %s", got.Buffer, got.PolicyVersion)
	}
	if batch, _, _, _ := b.pending(100); len(batch) != 0 {
		t.Fatalf("%d samples still pending after the ack", len(batch))
	}
}

func TestAnUnreachablePlatformLosesNothing(t *testing.T) {
	configPath, b, platform := setupUpload(t)
	platform.status = http.StatusServiceUnavailable
	_ = b.append(testSample(time.Now().Add(-time.Minute), 10))
	telemetryRuntime.report([]monitorEvent{{Key: "cpu", State: "firing"}}, false)

	uploadTelemetry(context.Background(), configPath, b)
	if batch, _, _, _ := b.pending(100); len(batch) != 1 {
		t.Fatalf("sample lost on a failed upload")
	}
	platform.status = 0
	uploadTelemetry(context.Background(), configPath, b)
	last := platform.received[len(platform.received)-1]
	if len(last.Samples) != 1 || len(last.Events) != 1 || last.Events[0].State != "firing" {
		t.Fatalf("retry did not carry the sample and event: %+v", last)
	}
}

func TestABatchThePlatformCannotReadIsGivenUp(t *testing.T) {
	configPath, b, platform := setupUpload(t)
	platform.status = http.StatusUnprocessableEntity
	_ = b.append(testSample(time.Now().Add(-time.Minute), 10))
	uploadTelemetry(context.Background(), configPath, b)
	if batch, _, _, _ := b.pending(100); len(batch) != 0 || b.dropped() != 1 {
		t.Fatalf("refused batch should be dropped and counted, pending %d dropped %d", len(batch), b.dropped())
	}
}

func TestTheUploadGoesToTheHeartbeatHost(t *testing.T) {
	got := backendBaseURL("https://api-rdp.techi.com.al/api/v1/agent/heartbeat") + "/api/v1/agent/telemetry"
	if !strings.HasPrefix(got, "https://api-rdp.techi.com.al/api/v1/agent/telemetry") {
		t.Fatal(got)
	}
}
