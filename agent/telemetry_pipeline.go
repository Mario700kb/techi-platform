package main

// Telemetry pipeline (2.1.29): the agent takes a sample every minute (or what
// the monitoring policy says), keeps it in the durable buffer, evaluates the
// policy's monitors against it, and uploads the buffer every 15 minutes. The
// platform acknowledges what it stored and the agent then forgets it — so
// nothing is lost while the device or the platform is unreachable.
//
// The pipeline runs only once the platform has sent a monitoring policy (in
// the heartbeat response or over the command channel). An agent talking to an
// older backend collects nothing extra.
//
// Every reading uses native APIs (gopsutil), never PowerShell: a sample costs
// a few milliseconds of CPU.

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	gopsnet "github.com/shirou/gopsutil/v3/net"
)

const (
	telemetryUploadBatch     = 1000 // half the platform's ceiling, well under its 4 MB
	telemetryUploadMaxChunks = 10   // per cycle; the rest goes next cycle
	telemetryUploadTimeout   = 60 * time.Second
	telemetryMaxEvents       = 200
)

// ── policy ──────────────────────────────────────────────────────────────────

type monitorRule struct {
	Key       string  `json:"key"`
	Metric    string  `json:"metric"`
	Op        string  `json:"op"`
	Threshold float64 `json:"threshold"`
	DurationS int     `json:"duration_s"`
	Severity  string  `json:"severity"`
	Enabled   bool    `json:"enabled"`

	// "service" monitors (2.1.33): the services to watch, comma-separated,
	// a trailing * matching a prefix.
	Target string `json:"target,omitempty"`
}

type telemetryPolicy struct {
	Version       string        `json:"version"`
	SampleSeconds int           `json:"sample_seconds"`
	UploadSeconds int           `json:"upload_seconds"`
	BufferMB      int           `json:"buffer_mb"`
	KeepDays      int           `json:"keep_days"`
	Monitors      []monitorRule `json:"monitors"`
}

func (p telemetryPolicy) normalized() telemetryPolicy {
	clampInt := func(v, lo, hi, def int) int {
		if v <= 0 {
			return def
		}
		if v < lo {
			return lo
		}
		if v > hi {
			return hi
		}
		return v
	}
	p.SampleSeconds = clampInt(p.SampleSeconds, 30, 900, 60)
	p.UploadSeconds = clampInt(p.UploadSeconds, 60, 3600, 900)
	p.BufferMB = clampInt(p.BufferMB, 5, 500, 50)
	p.KeepDays = clampInt(p.KeepDays, 1, 30, 7)
	return p
}

// ── monitor events ──────────────────────────────────────────────────────────

type monitorEvent struct {
	Key       string   `json:"key"`
	State     string   `json:"state"` // firing | ok
	Value     *float64 `json:"value,omitempty"`
	Threshold *float64 `json:"threshold,omitempty"`
	Since     string   `json:"since,omitempty"`
	Target    string   `json:"target,omitempty"`
}

type monitorState struct {
	breachSince time.Time
	firing      bool
	clearCount  int
	reported    bool // the first evaluation after start reports its state once
}

// evaluateMonitors updates every monitor with one sample and returns the
// events to report. A monitor fires once its condition has held for its
// duration; it clears only after two samples back inside a 5% margin, so a
// value hovering at the threshold does not flap.
func evaluateMonitors(rules []monitorRule, states map[string]*monitorState, sample *telemetrySample, at time.Time) []monitorEvent {
	var events []monitorEvent
	seen := map[string]bool{}
	for _, rule := range rules {
		if !rule.Enabled || rule.Key == "" {
			continue
		}
		seen[rule.Key] = true
		value, target, ok := monitorValue(rule, sample)
		if !ok {
			continue
		}
		st := states[rule.Key]
		if st == nil {
			st = &monitorState{}
			states[rule.Key] = st
		}
		breaching := compare(rule.Op, value, rule.Threshold)
		threshold := rule.Threshold
		v := round1(value)
		event := monitorEvent{Key: rule.Key, Value: &v, Threshold: &threshold, Target: target}

		if breaching {
			st.clearCount = 0
			if st.breachSince.IsZero() {
				st.breachSince = at
			}
			if !st.firing && at.Sub(st.breachSince) >= time.Duration(rule.DurationS)*time.Second {
				st.firing, st.reported = true, true
				event.State = "firing"
				event.Since = st.breachSince.UTC().Format(time.RFC3339)
				events = append(events, event)
			}
			continue
		}
		st.breachSince = time.Time{}
		if st.firing {
			if !compare(rule.Op, value, clearLevel(rule.Op, rule.Threshold)) {
				st.clearCount++
			}
			if st.clearCount >= 2 {
				st.firing, st.clearCount = false, 0
				event.State = "ok"
				events = append(events, event)
			}
			continue
		}
		if !st.reported {
			// After a restart the platform may still hold an alert this agent
			// raised before; one "ok" resolves it (and changes nothing if not).
			st.reported = true
			event.State = "ok"
			events = append(events, event)
		}
	}
	for key := range states {
		if !seen[key] {
			delete(states, key)
		}
	}
	return events
}

func compare(op string, value, threshold float64) bool {
	if op == "<" {
		return value < threshold
	}
	return value > threshold
}

// clearLevel is the far side of the 5% margin: above it ("<" monitors) or
// below it (">" monitors) the condition counts as gone.
func clearLevel(op string, threshold float64) float64 {
	if op == "<" {
		return threshold * 1.05
	}
	return threshold * 0.95
}

// serviceProbe counts the watched services that are set to start
// automatically and are stopped (services_watch_windows.go); tests replace it.
var serviceProbe = stoppedWatchedServices

func monitorValue(rule monitorRule, s *telemetrySample) (float64, string, bool) {
	switch rule.Metric {
	case "cpu":
		if s.CPU != nil {
			return *s.CPU, "", true
		}
	case "mem":
		if s.Mem != nil {
			return *s.Mem, "", true
		}
	case "disk":
		best, target := -1.0, ""
		for _, d := range s.Disks {
			if d.TotalGB > 0 && d.TotalGB < smallVolumeGB {
				continue // a recovery or EFI partition full is not a problem
			}
			if d.UsedPct > best {
				best, target = d.UsedPct, d.Mount
			}
		}
		if best >= 0 {
			return best, target, true
		}
	case "net_rx_mbps":
		if s.NetRxBps != nil {
			return *s.NetRxBps / 1e6, "", true
		}
	case "net_tx_mbps":
		if s.NetTxBps != nil {
			return *s.NetTxBps / 1e6, "", true
		}
	case "disk_busy":
		if s.DiskBusy != nil {
			return *s.DiskBusy, "", true
		}
	case "gw_ms":
		if s.GwMs != nil {
			return *s.GwMs, "", true
		}
	case "gw_loss":
		if s.GwLoss != nil {
			return *s.GwLoss, "", true
		}
	case "service":
		stopped, watched := serviceProbe(rule.Target)
		if !watched {
			return 0, "", false // none of the services is here (or set to start automatically)
		}
		return float64(len(stopped)), strings.Join(stopped, ", "), true
	}
	return 0, "", false
}

// ── collector ───────────────────────────────────────────────────────────────

type telemetryCollector struct {
	lastCPU   *cpu.TimesStat
	lastNetRx uint64
	lastNetTx uint64
	lastNetAt time.Time
	disks     []string
	disksAt   time.Time

	// 2.1.33 (telemetry_extra.go)
	procs      processSampler
	diskIO     diskActivity
	network    networkQuality
	backendURL string
}

// collect reads one sample. CPU and network are averages since the previous
// sample, not an instant, so a short spike between samples still counts.
func (c *telemetryCollector) collect(at time.Time) *telemetrySample {
	s := &telemetrySample{TS: at.UTC().Format(time.RFC3339)}
	if times, err := cpu.Times(false); err == nil && len(times) > 0 {
		current := times[0]
		if c.lastCPU != nil {
			busy0, total0 := cpuBusyTotal(*c.lastCPU)
			busy1, total1 := cpuBusyTotal(current)
			if total1 > total0 {
				v := round1(clampPercent((busy1 - busy0) / (total1 - total0) * 100))
				s.CPU = &v
			}
		}
		c.lastCPU = &current
	}
	if s.CPU == nil {
		if pcts, err := cpu.Percent(time.Second, false); err == nil && len(pcts) > 0 {
			v := round1(clampPercent(pcts[0]))
			s.CPU = &v
		}
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		pct := round1(vm.UsedPercent)
		used := round1(float64(vm.Used) / (1024 * 1024))
		s.Mem, s.MemUsedMB = &pct, &used
	}
	if counters, err := gopsnet.IOCounters(false); err == nil && len(counters) > 0 {
		n := counters[0]
		if !c.lastNetAt.IsZero() && n.BytesRecv >= c.lastNetRx && n.BytesSent >= c.lastNetTx {
			if secs := at.Sub(c.lastNetAt).Seconds(); secs > 0 {
				rx := math.Round(float64(n.BytesRecv-c.lastNetRx) * 8 / secs)
				tx := math.Round(float64(n.BytesSent-c.lastNetTx) * 8 / secs)
				s.NetRxBps, s.NetTxBps = &rx, &tx
			}
		}
		c.lastNetRx, c.lastNetTx, c.lastNetAt = n.BytesRecv, n.BytesSent, at
	}
	if up, err := host.Uptime(); err == nil {
		s.UptimeS = &up
	}
	if c.disks == nil || at.Sub(c.disksAt) >= 15*time.Minute {
		c.disks, c.disksAt = liveDiskMounts(), at
	}
	for _, mount := range c.disks {
		if d, ok := liveDiskUsage(mount); ok {
			s.Disks = append(s.Disks, sampleDisk{Mount: d.Mount, UsedPct: d.UsedPercent, FreeGB: d.FreeGB, TotalGB: d.TotalGB})
		}
	}
	c.collectExtra(s, at)
	return s
}

// collectExtra adds disk activity, network quality and, in a busy minute,
// the top processes.
func (c *telemetryCollector) collectExtra(s *telemetrySample, at time.Time) {
	if c.procs.cpus == 0 {
		c.procs.cpus = runtime.NumCPU()
	}
	busyCPU := s.CPU != nil && *s.CPU >= topBusyCPU
	busyMem := s.Mem != nil && *s.Mem >= topBusyMem
	s.Top = c.procs.sample(at, busyCPU, busyMem)
	s.DiskBusy, s.DiskQueue, s.DiskReadBps, s.DiskWriteBps = c.diskIO.sample(c.disks)
	s.GwMs, s.GwLoss = c.network.sample(at)
	if c.backendURL != "" {
		s.WanMs = platformConnectMs(c.backendURL)
	}
}

// ── pipeline ────────────────────────────────────────────────────────────────

type telemetryPipelineState struct {
	mu       sync.Mutex
	policy   *telemetryPolicy
	changed  chan struct{}
	events   []monitorEvent
	channel  func([]byte) error // the open command channel, if any
	dir      string
	uploadAt time.Time
}

var telemetryRuntime = &telemetryPipelineState{changed: make(chan struct{}, 1)}

// applyMonitoringPolicy adopts a policy from the heartbeat or the channel.
// nil (an older backend, or one that could not read it) keeps the current one.
func applyMonitoringPolicy(raw json.RawMessage) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return
	}
	var p telemetryPolicy
	if err := json.Unmarshal(raw, &p); err != nil || p.Version == "" {
		log.Printf("[telemetry] ignoring unreadable monitoring policy")
		return
	}
	p = p.normalized()
	t := telemetryRuntime
	t.mu.Lock()
	same := t.policy != nil && t.policy.Version == p.Version
	if !same {
		t.policy = &p
	}
	dir := t.dir
	t.mu.Unlock()
	if same {
		return
	}
	log.Printf("[telemetry] policy %s: sample every %ds, upload every %ds, %d monitor(s)",
		p.Version, p.SampleSeconds, p.UploadSeconds, len(p.Monitors))
	if dir != "" {
		if data, err := json.Marshal(p); err == nil {
			_ = os.WriteFile(filepath.Join(dir, "policy.json"), data, 0o600)
		}
	}
	select {
	case t.changed <- struct{}{}:
	default:
	}
}

func (t *telemetryPipelineState) currentPolicy() *telemetryPolicy {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.policy == nil {
		return nil
	}
	p := *t.policy
	return &p
}

func (t *telemetryPipelineState) setChannel(send func([]byte) error) {
	t.mu.Lock()
	t.channel = send
	t.mu.Unlock()
}

// report queues events for the next upload and, when the command channel is
// open, sends state changes at once.
func (t *telemetryPipelineState) report(events []monitorEvent, live bool) {
	if len(events) == 0 {
		return
	}
	t.mu.Lock()
	t.events = append(t.events, events...)
	if over := len(t.events) - telemetryMaxEvents; over > 0 {
		t.events = t.events[over:]
	}
	send := t.channel
	t.mu.Unlock()
	for _, e := range events {
		log.Printf("[telemetry] monitor %s %s", e.Key, e.State)
		if !live || send == nil {
			continue
		}
		if data, err := json.Marshal(map[string]interface{}{"type": "monitor", "event": e}); err == nil {
			_ = send(data)
		}
	}
}

func (t *telemetryPipelineState) takeEvents() []monitorEvent {
	t.mu.Lock()
	defer t.mu.Unlock()
	events := t.events
	t.events = nil
	return events
}

// requeue puts back events an upload could not deliver, ahead of newer ones.
func (t *telemetryPipelineState) requeue(events []monitorEvent) {
	if len(events) == 0 {
		return
	}
	t.mu.Lock()
	t.events = append(events, t.events...)
	if over := len(t.events) - telemetryMaxEvents; over > 0 {
		t.events = t.events[over:]
	}
	t.mu.Unlock()
}

// runTelemetryPipeline samples, evaluates and uploads for the life of the
// agent. It never fails the agent: anything that goes wrong is logged and
// retried, and heartbeats carry on regardless.
func runTelemetryPipeline(ctx context.Context, configPath string) {
	dir := filepath.Join(filepath.Dir(configPath), "telemetry")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("[telemetry] cannot create %s: %v; pipeline off", dir, err)
		return
	}
	t := telemetryRuntime
	t.mu.Lock()
	t.dir = dir
	t.mu.Unlock()
	if data, err := os.ReadFile(filepath.Join(dir, "policy.json")); err == nil {
		applyMonitoringPolicy(data)
	}

	// Wait for the first policy: without one the platform does not take uploads.
	for t.currentPolicy() == nil {
		select {
		case <-ctx.Done():
			return
		case <-t.changed:
		}
	}
	policy := t.currentPolicy()
	buffer, err := openTelemetryBuffer(dir, int64(policy.BufferMB)<<20, time.Duration(policy.KeepDays)*24*time.Hour)
	if err != nil {
		log.Printf("[telemetry] cannot open buffer: %v; pipeline off", err)
		return
	}
	defer buffer.close()
	log.Printf("[telemetry] pipeline started (%s)", dir)

	go runTelemetryUploader(ctx, configPath, buffer)

	collector := &telemetryCollector{}
	if cfg, err := loadConfig(configPath); err == nil {
		applyEnvironment(cfg)
		collector.backendURL = backendBaseURL(cfg.BackendURL)
	}
	states := map[string]*monitorState{}
	// Prime the CPU and network counters so the first stored sample is an
	// average like every other one.
	collector.collect(time.Now())
	for {
		policy = t.currentPolicy()
		period := time.Duration(policy.SampleSeconds) * time.Second
		now := time.Now()
		next := now.Truncate(period).Add(period)
		timer := time.NewTimer(next.Sub(now))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-t.changed:
			timer.Stop()
			policy = t.currentPolicy()
			buffer.setLimits(int64(policy.BufferMB)<<20, time.Duration(policy.KeepDays)*24*time.Hour)
			continue
		case <-timer.C:
		}
		if heartbeatsPaused(time.Now()) {
			continue // shutting down or going to sleep
		}
		sample := collector.collect(next)
		if err := buffer.append(sample); err != nil {
			log.Printf("[telemetry] could not buffer sample: %v", err)
		}
		t.report(evaluateMonitors(policy.Monitors, states, sample, next), true)
	}
}

func runTelemetryUploader(ctx context.Context, configPath string, buffer *telemetryBuffer) {
	t := telemetryRuntime
	// The first upload waits a random part of the period, so a fleet that
	// restarted together (an update, a site powering on) does not upload together.
	first := time.Duration(rand.Int63n(int64(time.Duration(t.currentPolicy().UploadSeconds) * time.Second)))
	wait := 30*time.Second + first
	for {
		if !telemetryWait(ctx, wait) {
			return
		}
		next := uploadTelemetry(ctx, configPath, buffer)
		policy := t.currentPolicy()
		if next <= 0 {
			next = policy.UploadSeconds
		}
		wait = jitteredInterval(time.Duration(next) * time.Second)
	}
}

type telemetryUploadBody struct {
	Schema        int               `json:"schema"`
	DeviceID      int               `json:"device_id"`
	AgentID       string            `json:"agent_id"`
	AgentTime     string            `json:"agent_time"`
	SampleSeconds int               `json:"sample_seconds"`
	PolicyVersion string            `json:"policy_version"`
	Samples       []json.RawMessage `json:"samples"`
	Events        []monitorEvent    `json:"events"`
	Buffer        struct {
		Pending       int    `json:"pending"`
		OldestPending string `json:"oldest_pending,omitempty"`
		DroppedTotal  int64  `json:"dropped_total"`
	} `json:"buffer"`
}

type telemetryAck struct {
	AckSeq            int64  `json:"ack_seq"`
	Stored            int    `json:"stored"`
	Duplicates        int    `json:"duplicates"`
	Rejected          int    `json:"rejected"`
	PolicyVersion     string `json:"policy_version"`
	NextUploadSeconds int    `json:"next_upload_seconds"`
}

type telemetryHTTPError struct {
	status int
	body   string
}

func (e *telemetryHTTPError) Error() string {
	return fmt.Sprintf("status %d: %s", e.status, e.body)
}

// uploadTelemetry sends what the buffer holds, in batches, and returns the
// platform's next upload period (0 when it did not answer).
func uploadTelemetry(ctx context.Context, configPath string, buffer *telemetryBuffer) int {
	cfg, err := loadConfig(configPath)
	if err != nil {
		return 0
	}
	applyEnvironment(cfg)
	if cfg.DeviceID <= 0 || strings.TrimSpace(cfg.AgentID) == "" {
		return 0 // not enrolled yet
	}
	endpoint := backendBaseURL(cfg.BackendURL) + "/api/v1/agent/telemetry"
	t := telemetryRuntime
	nextUpload := 0
	for chunk := 0; chunk < telemetryUploadMaxChunks; chunk++ {
		if ctx.Err() != nil || heartbeatsPaused(time.Now()) {
			return nextUpload
		}
		policy := t.currentPolicy()
		samples, lastSeq, total, oldest := buffer.pending(telemetryUploadBatch)
		events := t.takeEvents()
		if len(samples) == 0 && len(events) == 0 && chunk > 0 {
			return nextUpload
		}
		body := telemetryUploadBody{
			Schema: 1, DeviceID: cfg.DeviceID, AgentID: strings.TrimSpace(cfg.AgentID),
			AgentTime: time.Now().UTC().Format(time.RFC3339Nano), SampleSeconds: policy.SampleSeconds,
			PolicyVersion: policy.Version, Samples: samples, Events: events,
		}
		if body.Samples == nil {
			body.Samples = []json.RawMessage{}
		}
		if body.Events == nil {
			body.Events = []monitorEvent{}
		}
		body.Buffer.Pending = total
		if !oldest.IsZero() {
			body.Buffer.OldestPending = oldest.UTC().Format(time.RFC3339)
		}
		body.Buffer.DroppedTotal = buffer.dropped()

		ack, err := postTelemetry(ctx, endpoint, cfg.TimeoutSeconds, &body)
		if err != nil {
			if httpErr, ok := err.(*telemetryHTTPError); ok && (httpErr.status == 400 || httpErr.status == 422) && len(samples) > 0 {
				// The platform cannot read this batch and never will: give it
				// up (counted as dropped) instead of blocking every later one.
				log.Printf("[telemetry] upload refused (%v); dropping %d sample(s)", err, len(samples))
				buffer.discardThrough(lastSeq, len(samples))
				continue
			}
			log.Printf("[telemetry] upload failed: %v; %d sample(s) kept for the next try", err, total)
			t.requeue(events)
			return nextUpload
		}
		if ack.AckSeq > 0 {
			buffer.ack(ack.AckSeq)
		}
		nextUpload = ack.NextUploadSeconds
		log.Printf("[telemetry] uploaded %d sample(s), %d event(s): stored %d, duplicates %d, rejected %d",
			len(samples), len(events), ack.Stored, ack.Duplicates, ack.Rejected)
		if len(samples) < telemetryUploadBatch {
			return nextUpload
		}
		if !telemetryWait(ctx, 2*time.Second) {
			return nextUpload
		}
	}
	return nextUpload
}

func postTelemetry(ctx context.Context, endpoint string, timeoutSeconds int, body *telemetryUploadBody) (*telemetryAck, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	if _, err := zw.Write(data); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	timeout := telemetryUploadTimeout
	if d := time.Duration(timeoutSeconds) * time.Second * 3; d > timeout {
		timeout = d
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, &gz)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &telemetryHTTPError{status: resp.StatusCode, body: strings.TrimSpace(string(payload))}
	}
	var ack telemetryAck
	if err := json.Unmarshal(payload, &ack); err != nil {
		return nil, err
	}
	return &ack, nil
}

// telemetryWait sleeps for d or until ctx ends (false). The command channel's
// sleepCtx is not built on every platform this pipeline runs on.
func telemetryWait(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
