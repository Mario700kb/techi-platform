package main

// Durable telemetry buffer: every sample is written to disk the moment it is
// taken and stays there until the platform acknowledges it, so a network
// outage, a backend restart or an agent restart loses nothing.
//
// Layout (next to the config, e.g. C:\ProgramData\TechiAgent\telemetry\):
//
//	seg-000000000001.jsonl   one sample per line: "<crc32 hex> <json>\n"
//	seg-000000000361.jsonl   named by the first sequence number inside
//	state.json               acknowledged seq, next seq, dropped total
//
// A line torn by a power cut fails its checksum and is skipped. Segments are
// deleted once every sample in them is acknowledged. The buffer is capped by
// size and age (the policy's buffer_mb and keep_days); what the cap removes
// before it was delivered is counted in dropped_total and reported, so a gap
// is always explained.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	telemetrySegmentSamples = 360 // six hours of 1-minute samples per file
	telemetryLineMax        = 64 * 1024
)

type sampleDisk struct {
	Mount   string  `json:"mount"`
	UsedPct float64 `json:"used_pct"`
	FreeGB  float64 `json:"free_gb"`
	TotalGB float64 `json:"total_gb"`
}

type telemetrySample struct {
	Seq       int64        `json:"seq"`
	TS        string       `json:"ts"` // RFC 3339, UTC
	CPU       *float64     `json:"cpu,omitempty"`
	Mem       *float64     `json:"mem,omitempty"`
	MemUsedMB *float64     `json:"mem_used_mb,omitempty"`
	NetRxBps  *float64     `json:"net_rx_bps,omitempty"`
	NetTxBps  *float64     `json:"net_tx_bps,omitempty"`
	UptimeS   *uint64      `json:"uptime_s,omitempty"`
	Disks     []sampleDisk `json:"disks,omitempty"`
}

type bufferState struct {
	NextSeq int64 `json:"next_seq"`
	Acked   int64 `json:"acked_seq"`
	Dropped int64 `json:"dropped_total"`
}

type bufferedLine struct {
	seq  int64
	ts   time.Time
	data json.RawMessage
}

type telemetryBuffer struct {
	mu       sync.Mutex
	dir      string
	state    bufferState
	maxBytes int64
	keep     time.Duration

	cur      *os.File
	curFirst int64
	curCount int
}

func openTelemetryBuffer(dir string, maxBytes int64, keep time.Duration) (*telemetryBuffer, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	b := &telemetryBuffer{dir: dir, maxBytes: maxBytes, keep: keep}
	if data, err := os.ReadFile(b.statePath()); err == nil {
		_ = json.Unmarshal(data, &b.state)
	}
	// The state file is written on acknowledgement, not on every sample: the
	// next sequence number is whatever the newest line on disk says.
	segments, _ := b.segments()
	for i := len(segments) - 1; i >= 0; i-- {
		lines, _ := b.readSegment(segments[i].path)
		if len(lines) > 0 {
			if last := lines[len(lines)-1].seq; last+1 > b.state.NextSeq {
				b.state.NextSeq = last + 1
			}
			break
		}
	}
	if b.state.NextSeq <= b.state.Acked {
		b.state.NextSeq = b.state.Acked + 1
	}
	return b, nil
}

func (b *telemetryBuffer) statePath() string { return filepath.Join(b.dir, "state.json") }

func (b *telemetryBuffer) setLimits(maxBytes int64, keep time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.maxBytes, b.keep = maxBytes, keep
}

// append gives the sample the next sequence number and writes it through to
// disk before returning.
func (b *telemetryBuffer) append(sample *telemetrySample) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	sample.Seq = b.state.NextSeq
	data, err := json.Marshal(sample)
	if err != nil {
		return err
	}
	if b.cur == nil || b.curCount >= telemetrySegmentSamples {
		if err := b.rotate(sample.Seq); err != nil {
			return err
		}
	}
	line := fmt.Sprintf("%08x %s\n", crc32.ChecksumIEEE(data), data)
	if _, err := b.cur.WriteString(line); err != nil {
		return err
	}
	if err := b.cur.Sync(); err != nil {
		return err
	}
	b.curCount++
	b.state.NextSeq++
	b.enforceLimits(time.Now())
	return nil
}

func (b *telemetryBuffer) rotate(firstSeq int64) error {
	if b.cur != nil {
		_ = b.cur.Close()
		b.cur = nil
	}
	path := filepath.Join(b.dir, fmt.Sprintf("seg-%012d.jsonl", firstSeq))
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	b.cur, b.curFirst, b.curCount = f, firstSeq, 0
	return nil
}

type segmentInfo struct {
	path  string
	first int64
	size  int64
	mod   time.Time
}

func (b *telemetryBuffer) segments() ([]segmentInfo, error) {
	entries, err := os.ReadDir(b.dir)
	if err != nil {
		return nil, err
	}
	var out []segmentInfo
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasPrefix(name, "seg-") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		first, err := strconv.ParseInt(strings.TrimSuffix(strings.TrimPrefix(name, "seg-"), ".jsonl"), 10, 64)
		if err != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, segmentInfo{path: filepath.Join(b.dir, name), first: first, size: info.Size(), mod: info.ModTime()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].first < out[j].first })
	return out, nil
}

// readSegment returns the intact lines of one file; torn or altered lines
// (checksum mismatch) are skipped.
func (b *telemetryBuffer) readSegment(path string) ([]bufferedLine, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []bufferedLine
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 4096), telemetryLineMax)
	for scanner.Scan() {
		raw := scanner.Bytes()
		space := bytes.IndexByte(raw, ' ')
		if space != 8 {
			continue
		}
		sum, err := strconv.ParseUint(string(raw[:8]), 16, 32)
		if err != nil {
			continue
		}
		payload := raw[space+1:]
		if crc32.ChecksumIEEE(payload) != uint32(sum) {
			continue
		}
		var head struct {
			Seq int64  `json:"seq"`
			TS  string `json:"ts"`
		}
		if json.Unmarshal(payload, &head) != nil || head.Seq <= 0 {
			continue
		}
		ts, _ := time.Parse(time.RFC3339, head.TS)
		out = append(out, bufferedLine{seq: head.Seq, ts: ts, data: append(json.RawMessage(nil), payload...)})
	}
	return out, scanner.Err()
}

// pending returns up to limit unacknowledged samples in order, plus how many
// are waiting in total and when the oldest was taken.
func (b *telemetryBuffer) pending(limit int) (batch []json.RawMessage, lastSeq int64, total int, oldest time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	segments, _ := b.segments()
	for _, seg := range segments {
		lines, _ := b.readSegment(seg.path)
		for _, line := range lines {
			if line.seq <= b.state.Acked {
				continue
			}
			total++
			if oldest.IsZero() || (!line.ts.IsZero() && line.ts.Before(oldest)) {
				oldest = line.ts
			}
			if len(batch) < limit {
				batch = append(batch, line.data)
				lastSeq = line.seq
			}
		}
	}
	return batch, lastSeq, total, oldest
}

// ack records that the platform holds everything up to seq and removes the
// files that are now fully delivered.
func (b *telemetryBuffer) ack(seq int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if seq <= b.state.Acked {
		return
	}
	if seq >= b.state.NextSeq {
		seq = b.state.NextSeq - 1
	}
	b.state.Acked = seq
	segments, _ := b.segments()
	for i, seg := range segments {
		last := b.state.NextSeq - 1
		if i+1 < len(segments) {
			last = segments[i+1].first - 1
		}
		if last > b.state.Acked {
			break
		}
		b.removeSegment(seg)
	}
	b.saveState()
}

func (b *telemetryBuffer) removeSegment(seg segmentInfo) {
	if b.cur != nil && seg.first == b.curFirst {
		_ = b.cur.Close()
		b.cur = nil
	}
	_ = os.Remove(seg.path)
}

// enforceLimits drops the oldest files while the buffer is over its size or
// age, counting undelivered samples as dropped. Called with b.mu held.
func (b *telemetryBuffer) enforceLimits(now time.Time) {
	segments, err := b.segments()
	if err != nil || len(segments) <= 1 {
		return
	}
	var total int64
	for _, s := range segments {
		total += s.size
	}
	for len(segments) > 1 {
		oldest := segments[0]
		tooBig := b.maxBytes > 0 && total > b.maxBytes
		tooOld := b.keep > 0 && now.Sub(oldest.mod) > b.keep
		if !tooBig && !tooOld {
			break
		}
		lines, _ := b.readSegment(oldest.path)
		lost := 0
		for _, line := range lines {
			if line.seq > b.state.Acked {
				lost++
			}
		}
		b.state.Dropped += int64(lost)
		if last := segments[1].first - 1; last > b.state.Acked {
			b.state.Acked = last
		}
		b.removeSegment(oldest)
		total -= oldest.size
		segments = segments[1:]
		b.saveState()
	}
}

func (b *telemetryBuffer) dropped() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.state.Dropped
}

// discardThrough gives up on samples the platform refuses outright (a batch it
// cannot read): they are counted as dropped so the rest can flow.
func (b *telemetryBuffer) discardThrough(seq int64, count int) {
	b.mu.Lock()
	b.state.Dropped += int64(count)
	b.mu.Unlock()
	b.ack(seq)
}

func (b *telemetryBuffer) saveState() {
	data, err := json.Marshal(b.state)
	if err != nil {
		return
	}
	tmp := b.statePath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, b.statePath())
}

func (b *telemetryBuffer) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cur != nil {
		_ = b.cur.Close()
		b.cur = nil
	}
}
