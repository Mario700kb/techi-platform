package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestTheHealthScriptOutputIsParsedAndNormalised(t *testing.T) {
	now := time.Date(2026, 10, 18, 22, 0, 0, 0, time.UTC)
	out := `WARNING: stray text
{"collected_at":"2026-10-18T21:59:58Z",
 "disks":{"value":[
   {"name":"  Samsung SSD 870 EVO 500GB ","media":"4","bus":"11","size_gb":465.8,"health":"0","operational":"2",
    "predict_failure":false,"temperature_c":34,"wear_pct":3,"power_on_hours":8123,"read_errors":0,"write_errors":0},
   {"name":"ST1000DM003","media":"HDD","bus":"SATA","size_gb":931.5,"health":"Warning","operational":["Predictive Failure","OK"],
    "predict_failure":true,"temperature_c":0,"wear_pct":140,"power_on_hours":null}
 ],"Count":2},
 "reboot_pending":true,"reboot_reasons":"windows_update",
 "events":[
   {"record_id":901,"source":"Microsoft-Windows-Kernel-Power","event_id":41,"at":"2026-10-18T20:15:03.1234567Z","message":"The system has rebooted\r\n without cleanly shutting down first."},
   {"record_id":902,"source":"Some-App","event_id":1000,"at":"2026-10-18T20:16:00Z","message":"not ours"},
   {"record_id":903,"source":"disk","event_id":7,"at":"2026-10-17T19:00:00Z","message":"older than 25 hours"},
   {"record_id":904,"source":"disk","event_id":7,"at":"2026-10-18T21:00:00Z","message":"bad block","win_level":2}
 ]}`
	h, err := parseDeviceHealth([]byte(out), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.Disks) != 2 {
		t.Fatalf("disks %+v", h.Disks)
	}
	ssd, hdd := h.Disks[0], h.Disks[1]
	if ssd.Name != "Samsung SSD 870 EVO 500GB" || ssd.Media != "SSD" || ssd.Bus != "SATA" || ssd.Health != "healthy" ||
		*ssd.TemperatureC != 34 || *ssd.WearPct != 3 || len(ssd.Operational) != 1 || ssd.Operational[0] != "2" {
		t.Fatalf("ssd %+v", ssd)
	}
	if hdd.Health != "warning" || !*hdd.PredictFailure || hdd.TemperatureC != nil || hdd.WearPct != nil || hdd.PowerOnHours != nil ||
		strings.Join(hdd.Operational, ",") != "Predictive Failure,OK" {
		t.Fatalf("hdd %+v", hdd)
	}
	if h.RebootPending == nil || !*h.RebootPending || len(h.RebootReasons) != 1 || h.RebootReasons[0] != "windows_update" {
		t.Fatalf("reboot %+v %+v", h.RebootPending, h.RebootReasons)
	}
	if len(h.Events) != 2 || h.Events[0].RecordID != 904 || h.Events[1].RecordID != 901 {
		t.Fatalf("events %+v", h.Events)
	}
	if h.Events[1].At != "2026-10-18T20:15:03Z" || h.Events[1].Message != "The system has rebooted without cleanly shutting down first." {
		t.Fatalf("event %+v", h.Events[1])
	}
	if h.Events[0].WinLevel == nil || *h.Events[0].WinLevel != 2 || h.Events[1].WinLevel != nil {
		t.Fatalf("levels %+v %+v", h.Events[0].WinLevel, h.Events[1].WinLevel)
	}
	if h.CollectedAt != "2026-10-18T21:59:58Z" {
		t.Fatalf("collected_at %q", h.CollectedAt)
	}
}

func TestAHealthReportWithNothingInItIsStillAReport(t *testing.T) {
	h, err := parseDeviceHealth([]byte(`{"disks":[],"reboot_pending":false,"reboot_reasons":[],"events":null}`), time.Now())
	if err != nil || h == nil || len(h.Disks) != 0 || len(h.Events) != 0 || *h.RebootPending {
		t.Fatalf("got %+v %v", h, err)
	}
	data, _ := json.Marshal(h)
	if !strings.Contains(string(data), `"events":[]`) && !strings.Contains(string(data), `"events":null`) {
		t.Fatalf("events missing: %s", data)
	}
	if _, err := parseDeviceHealth([]byte("PowerShell failed"), time.Now()); err == nil {
		t.Fatal("no JSON must be an error")
	}
}

func TestTheHealthHashIgnoresWhenItWasRead(t *testing.T) {
	a, _ := parseDeviceHealth([]byte(`{"collected_at":"2026-10-18T20:00:00Z","disks":[{"name":"X","health":"Healthy"}]}`), time.Now())
	b, _ := parseDeviceHealth([]byte(`{"collected_at":"2026-10-18T21:00:00Z","disks":[{"name":"X","health":"Healthy"}]}`), time.Now())
	c, _ := parseDeviceHealth([]byte(`{"collected_at":"2026-10-18T21:00:00Z","disks":[{"name":"X","health":"Unhealthy"}]}`), time.Now())
	if deviceHealthHash(a) != deviceHealthHash(b) || deviceHealthHash(a) == deviceHealthHash(c) {
		t.Fatal("hash must change with the content only")
	}
}

func TestTheHealthReportIsSentWhenItChangesOrEverySixHours(t *testing.T) {
	f := &fakeInventory{now: time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)}
	health := "Healthy"
	reads := 0
	b := newBackgroundInventory(
		func() time.Time { return f.now },
		func() []ProcessInfo { return nil },
		func() []ServiceInfo { return nil },
		func() []SoftwareInfo { return nil },
		func() *PatchStatus { return &PatchStatus{PatchState: "up_to_date"} },
		nil,
		func() *DeviceHealth {
			reads++
			h, _ := parseDeviceHealth([]byte(`{"disks":[{"name":"X","health":"`+health+`"}]}`), f.now)
			return h
		},
	)
	cfg := &Config{}
	b.collectDue(cfg)
	first := b.forHeartbeat(cfg)
	if first.Health == nil {
		t.Fatal("the first report must be sent")
	}
	first.sent()

	f.advance(time.Hour)
	b.collectDue(cfg)
	if again := b.forHeartbeat(cfg); again.Health != nil {
		t.Fatal("an unchanged report is not sent again within six hours")
	}
	health = "Unhealthy"
	f.advance(time.Hour)
	b.collectDue(cfg)
	changed := b.forHeartbeat(cfg)
	if changed.Health == nil || changed.Health.Disks[0].Health != "unhealthy" {
		t.Fatal("a changed report is sent at once")
	}
	if reads != 3 {
		t.Fatalf("read %d times, want hourly", reads)
	}
}
