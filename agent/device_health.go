package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strings"
	"time"
)

// Device health (2.1.33) is an hourly, read-only report of what makes a
// machine fail rather than slow down: each physical disk's health and SMART
// prediction with its reliability counters, whether a restart is pending and
// why, and the critical System events of the last 25 hours (unexpected
// restarts, blue screens, fatal hardware errors, disk and file-system errors,
// crashed services). One PowerShell script reads it; it is sent only when it
// changed, or every six hours. A probe that cannot be read is null, never a
// guess.
const (
	deviceHealthRefreshEvery = time.Hour
	deviceHealthResendEvery  = 6 * time.Hour
	deviceHealthRetryEvery   = 15 * time.Minute
	deviceHealthTimeout      = 60 * time.Second

	maxHealthDisks       = 32
	maxHealthEvents      = 100
	maxHealthMessageLen  = 300
	healthEventLookbackH = 25
)

// healthEventKinds are the (provider, id) pairs the report keeps; the
// platform names them (app/schemas/device_health.py EVENT_CATALOG).
var healthEventKinds = []struct {
	source string
	ids    []int
}{
	{"microsoft-windows-kernel-power", []int{41}},
	{"microsoft-windows-wer-systemerrorreporting", []int{1001}},
	{"bugcheck", []int{1001}},
	{"eventlog", []int{6008}},
	{"microsoft-windows-whea-logger", []int{18}},
	{"disk", []int{7, 11, 51, 153}},
	{"ntfs", []int{55, 98, 137}},
	{"microsoft-windows-ntfs", []int{55, 98, 137}},
	{"service control manager", []int{7031, 7034}},
}

var healthRebootReasons = map[string]bool{"windows_update": true, "cbs": true, "file_rename": true, "rename": true}

type DeviceHealth struct {
	CollectedAt   string            `json:"collected_at"`
	Disks         healthDiskList    `json:"disks"`
	RebootPending *bool             `json:"reboot_pending"`
	RebootReasons postureStringList `json:"reboot_reasons"`
	Events        healthEventList   `json:"events"`
}

type HealthDisk struct {
	Name           string        `json:"name"`
	Media          string        `json:"media,omitempty"`
	Bus            string        `json:"bus,omitempty"`
	SizeGB         *float64      `json:"size_gb"`
	Health         string        `json:"health"`
	Operational    flexibleWords `json:"operational,omitempty"`
	PredictFailure *bool         `json:"predict_failure"`
	TemperatureC   *int64        `json:"temperature_c"`
	WearPct        *int64        `json:"wear_pct"`
	PowerOnHours   *int64        `json:"power_on_hours"`
	ReadErrors     *int64        `json:"read_errors"`
	WriteErrors    *int64        `json:"write_errors"`
}

type HealthEvent struct {
	RecordID int64  `json:"record_id"`
	Source   string `json:"source"`
	EventID  int    `json:"event_id"`
	At       string `json:"at"`
	Message  string `json:"message,omitempty"`
	// Windows level (1 critical, 2 error, 3 warning; 2.1.34+). The platform
	// ignores informational events such as NTFS 98 "is healthy".
	WinLevel *int `json:"win_level,omitempty"`
}

// The script's lists may arrive as an array, one object, null, or the
// {"value": [...], "Count": n} wrapper Windows PowerShell 5.1 sometimes makes.
type healthDiskList []HealthDisk
type healthEventList []HealthEvent

func unwrapJSONList(data []byte) ([]json.RawMessage, error) {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		return nil, nil
	}
	if data[0] == '{' {
		var wrapped struct {
			Value json.RawMessage `json:"value"`
		}
		if err := json.Unmarshal(data, &wrapped); err == nil && len(wrapped.Value) > 0 && bytes.TrimSpace(wrapped.Value)[0] == '[' {
			data = wrapped.Value
		} else {
			return []json.RawMessage{data}, nil
		}
	}
	var items []json.RawMessage
	err := json.Unmarshal(data, &items)
	return items, err
}

func (l *healthDiskList) UnmarshalJSON(data []byte) error {
	items, err := unwrapJSONList(data)
	if err != nil {
		return err
	}
	out := make(healthDiskList, 0, len(items))
	for _, item := range items {
		var d HealthDisk
		if json.Unmarshal(item, &d) == nil {
			out = append(out, d)
		}
	}
	*l = out
	return nil
}

func (l *healthEventList) UnmarshalJSON(data []byte) error {
	items, err := unwrapJSONList(data)
	if err != nil {
		return err
	}
	out := make(healthEventList, 0, len(items))
	for _, item := range items {
		var e HealthEvent
		if json.Unmarshal(item, &e) == nil {
			out = append(out, e)
		}
	}
	*l = out
	return nil
}

// flexibleWords accepts a list of words or numbers, or one of them.
type flexibleWords []string

func (w *flexibleWords) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	var items []json.RawMessage
	if len(trimmed) > 0 && (trimmed[0] == '[' || trimmed[0] == '{') {
		var err error
		if items, err = unwrapJSONList(trimmed); err != nil {
			return err
		}
	} else if len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) {
		items = []json.RawMessage{trimmed}
	}
	var out flexibleWords
	for _, item := range items {
		var text string
		if json.Unmarshal(item, &text) == nil {
			out = append(out, text)
			continue
		}
		var number json.Number
		if json.Unmarshal(item, &number) == nil {
			out = append(out, number.String())
		}
	}
	*w = out
	return nil
}

var errNoHealthJSON = errors.New("device health: no JSON object in the script output")

func parseDeviceHealth(raw []byte, now time.Time) (*DeviceHealth, error) {
	start := bytes.IndexByte(raw, '{')
	end := bytes.LastIndexByte(raw, '}')
	if start < 0 || end < start {
		return nil, errNoHealthJSON
	}
	var h DeviceHealth
	if err := json.Unmarshal(raw[start:end+1], &h); err != nil {
		return nil, err
	}
	h.normalise(now)
	return &h, nil
}

// Numeric values Get-PhysicalDisk can return when its enums are not named.
var (
	diskHealthByCode = map[string]string{"0": "healthy", "1": "warning", "2": "unhealthy", "5": "unknown"}
	diskMediaByCode  = map[string]string{"0": "Unspecified", "3": "HDD", "4": "SSD", "5": "SCM"}
	diskBusByCode    = map[string]string{
		"1": "SCSI", "2": "ATAPI", "3": "ATA", "6": "Fibre Channel", "7": "USB", "8": "RAID", "9": "iSCSI",
		"10": "SAS", "11": "SATA", "12": "SD", "13": "MMC", "14": "Virtual", "15": "File Backed Virtual",
		"16": "Storage Spaces", "17": "NVMe",
	}
)

func (h *DeviceHealth) normalise(now time.Time) {
	collected := now.UTC()
	if t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(h.CollectedAt)); err == nil {
		collected = t.UTC()
	}
	h.CollectedAt = collected.Format(time.RFC3339)

	disks := make(healthDiskList, 0, len(h.Disks))
	for _, d := range h.Disks {
		d.Name = clipText(d.Name, 128)
		if d.Name == "" {
			d.Name = "Disk"
		}
		d.Media = clipText(mapCode(d.Media, diskMediaByCode), 16)
		d.Bus = clipText(mapCode(d.Bus, diskBusByCode), 16)
		health := strings.ToLower(strings.TrimSpace(mapCode(d.Health, diskHealthByCode)))
		switch health {
		case "healthy", "warning", "unhealthy":
			d.Health = health
		default:
			d.Health = "unknown"
		}
		if d.SizeGB != nil && (math.IsNaN(*d.SizeGB) || *d.SizeGB <= 0) {
			d.SizeGB = nil
		}
		d.TemperatureC = boundInt(d.TemperatureC, 1, 150) // 0 = no sensor
		d.WearPct = boundInt(d.WearPct, 0, 100)
		d.PowerOnHours = boundInt(d.PowerOnHours, 0, 1_000_000)
		d.ReadErrors = boundInt(d.ReadErrors, 0, 1_000_000_000_000)
		d.WriteErrors = boundInt(d.WriteErrors, 0, 1_000_000_000_000)
		if len(d.Operational) > 4 {
			d.Operational = d.Operational[:4]
		}
		disks = append(disks, d)
		if len(disks) >= maxHealthDisks {
			break
		}
	}
	h.Disks = disks

	reasons := make(postureStringList, 0, len(h.RebootReasons))
	seen := map[string]bool{}
	for _, r := range h.RebootReasons {
		r = strings.TrimSpace(r)
		if healthRebootReasons[r] && !seen[r] {
			seen[r] = true
			reasons = append(reasons, r)
		}
	}
	h.RebootReasons = reasons

	cutoff := collected.Add(-healthEventLookbackH * time.Hour)
	events := make(healthEventList, 0, len(h.Events))
	for _, e := range h.Events {
		if !keptHealthEvent(e.Source, e.EventID) {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(e.At))
		if err != nil || at.Before(cutoff) {
			continue
		}
		e.At = at.UTC().Format(time.RFC3339)
		e.Source = clipText(e.Source, 64)
		e.Message = clipText(strings.Join(strings.Fields(e.Message), " "), maxHealthMessageLen)
		if e.WinLevel != nil && (*e.WinLevel < 0 || *e.WinLevel > 5) {
			e.WinLevel = nil
		}
		events = append(events, e)
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].At > events[j].At })
	if len(events) > maxHealthEvents {
		events = events[:maxHealthEvents]
	}
	h.Events = events
}

func keptHealthEvent(source string, id int) bool {
	source = strings.ToLower(strings.TrimSpace(source))
	for _, kind := range healthEventKinds {
		if kind.source != source {
			continue
		}
		for _, kept := range kind.ids {
			if kept == id {
				return true
			}
		}
	}
	return false
}

func mapCode(value string, codes map[string]string) string {
	value = strings.TrimSpace(value)
	if named, ok := codes[value]; ok {
		return named
	}
	return value
}

func clipText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if r := []rune(value); len(r) > limit {
		value = strings.TrimSpace(string(r[:limit]))
	}
	return value
}

func boundInt(v *int64, lo, hi int64) *int64 {
	if v == nil || *v < lo || *v > hi {
		return nil
	}
	return v
}

// deviceHealthHash leaves out collected_at, which moves on every run.
func deviceHealthHash(h *DeviceHealth) string {
	if h == nil {
		return ""
	}
	c := *h
	c.CollectedAt = ""
	return contentHash(c)
}

func deviceHealthCollected(h *DeviceHealth) bool { return h != nil }
