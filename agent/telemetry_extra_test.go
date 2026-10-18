package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	gopsprocess "github.com/shirou/gopsutil/v3/process"
)

// ── top processes ───────────────────────────────────────────────────────────

func reading(pid int32, cpu, mem float64) procReading {
	return procReading{proc: &gopsprocess.Process{Pid: pid}, cpu: cpu, memMB: mem}
}

func TestABusyMinuteNamesTheTopCPUThenMemoryUsers(t *testing.T) {
	names := map[int32]string{1: `C:\Program Files\Microsoft SQL Server\sqlservr.exe`, 2: "MsMpEng.exe", 3: "chrome.exe", 4: "idle.exe", 5: "Teams.exe"}
	readings := []procReading{reading(1, 41.5, 6120.4), reading(2, 12, 300), reading(3, 0.4, 2100), reading(4, 0, 10), reading(5, 3, 900)}
	nameOf := func(r procReading) (string, float64) { return names[r.proc.Pid], r.memMB }

	top := pickTopProcesses(readings, true, false, nameOf)
	if len(top) != 3 || top[0].Name != "sqlservr.exe" || top[0].CPU != 41.5 || top[1].Name != "MsMpEng.exe" || top[2].Name != "Teams.exe" {
		t.Fatalf("CPU-busy minute: %+v", top)
	}

	both := pickTopProcesses(readings, true, true, nameOf)
	got := []string{}
	for _, p := range both {
		got = append(got, p.Name)
	}
	// sqlservr is first by memory too, so it is not listed twice; chrome joins.
	if strings.Join(got, ",") != "sqlservr.exe,MsMpEng.exe,Teams.exe,chrome.exe" || both[0].MemMB != 6120 {
		t.Fatalf("CPU- and memory-busy minute: %+v", both)
	}

	if quiet := pickTopProcesses([]procReading{reading(1, 0.2, 10)}, true, false, nameOf); len(quiet) != 0 {
		t.Fatalf("a process under 1%% CPU is not a top user: %+v", quiet)
	}
}

func TestTheFirstMinuteOnlySetsTheBaseline(t *testing.T) {
	p := &processSampler{cpus: 4}
	if top := p.sample(time.Now(), true, true); top != nil {
		t.Fatalf("no CPU share without a previous minute, got %+v", top)
	}
	if p.last == nil {
		t.Fatal("baseline not kept")
	}
}

func TestBaseNameKeepsTheExecutable(t *testing.T) {
	if got := baseName(`C:\Windows\System32\svchost.exe`); got != "svchost.exe" {
		t.Fatalf("got %q", got)
	}
	if got := baseName("/usr/sbin/sshd"); got != "sshd" {
		t.Fatalf("got %q", got)
	}
	if got := baseName(strings.Repeat("a", 80) + ".exe"); len([]rune(got)) != 64 {
		t.Fatalf("not shortened: %d", len(got))
	}
}

// ── disk activity ───────────────────────────────────────────────────────────

func TestDiskActivityIsTheBusiestVolumeAndTheSumOfTraffic(t *testing.T) {
	counters := map[string]diskCounters{
		"C:": {readBytes: 1000, writeBytes: 2000, ioTime: 10, idleTime: 100, queryTime: 1000},
		"D:": {readBytes: 0, writeBytes: 0, ioTime: 0, idleTime: 100, queryTime: 1000},
	}
	d := &diskActivity{read: func(mount string) (diskCounters, bool) {
		c, ok := counters[strings.ToUpper(mount[:2])]
		return c, ok
	}}
	if busy, _, _, _ := d.sample([]string{`C:\`, `D:\`}); busy != nil {
		t.Fatal("the first reading has nothing to compare with")
	}
	// a minute later: C: idle 15 of 60 s with 1.5 requests in flight on
	// average; D: idle the whole minute
	counters["C:"] = diskCounters{readBytes: 1000 + 60*5e6, writeBytes: 2000 + 60*1e6, ioTime: 10 + 90, idleTime: 115, queryTime: 1060}
	counters["D:"] = diskCounters{readBytes: 60 * 1e6, writeBytes: 0, ioTime: 0, idleTime: 160, queryTime: 1060}
	busy, queue, readBps, writeBps := d.sample([]string{`C:\`, `D:\`})
	if busy == nil || *busy != 75 || *queue != 1.5 || *readBps != 6e6 || *writeBps != 1e6 {
		t.Fatalf("busy %v queue %v read %v write %v", deref(busy), deref(queue), deref(readBps), deref(writeBps))
	}
}

func deref(v *float64) float64 {
	if v == nil {
		return -1
	}
	return *v
}

// ── network quality ─────────────────────────────────────────────────────────

func TestGatewayLossCountsOnlyOnceTheGatewayHasAnswered(t *testing.T) {
	replies := [][]float64{nil, {2, 3, 4, 3}, {5}, nil}
	call := 0
	n := &networkQuality{
		lookup: func() string { return "192.168.1.1" },
		ping: func(host string, count int, _ time.Duration) ([]float64, int) {
			if host != "192.168.1.1" || count != gatewayPings {
				t.Fatalf("pinged %s ×%d", host, count)
			}
			r := replies[call]
			call++
			return r, count
		},
	}
	now := time.Now()
	if ms, loss := n.sample(now); ms != nil || loss != nil {
		t.Fatal("a gateway that never answered is unknown, not 100% loss")
	}
	if ms, loss := n.sample(now.Add(time.Minute)); *ms != 3 || *loss != 0 {
		t.Fatalf("ms %v loss %v", *ms, *loss)
	}
	if ms, loss := n.sample(now.Add(2 * time.Minute)); *ms != 5 || *loss != 75 {
		t.Fatalf("ms %v loss %v", *ms, *loss)
	}
	if ms, loss := n.sample(now.Add(3 * time.Minute)); ms != nil || *loss != 100 {
		t.Fatal("once it has answered, silence is loss")
	}
}

func TestNoGatewayMeansNoReading(t *testing.T) {
	n := &networkQuality{lookup: func() string { return "" }, ping: func(string, int, time.Duration) ([]float64, int) {
		t.Fatal("nothing to ping")
		return nil, 0
	}}
	if ms, loss := n.sample(time.Now()); ms != nil || loss != nil {
		t.Fatal("expected no reading")
	}
}

func TestPlatformConnectTimeIsNilWhenItCannotConnect(t *testing.T) {
	if platformConnectMs("not a url") != nil || platformConnectMs("") != nil {
		t.Fatal("expected nil")
	}
}

// ── monitors on the new readings ────────────────────────────────────────────

func TestASmallVolumeNeverDecidesTheDiskMonitor(t *testing.T) {
	rules := []monitorRule{{Key: "disk", Metric: "disk", Op: ">", Threshold: 90, Enabled: true}}
	s := testSample(time.Now(), 10)
	s.Disks = append(s.Disks, sampleDisk{Mount: "D:", UsedPct: 89, FreeGB: 0.1, TotalGB: 1})
	s.Disks = append(s.Disks, sampleDisk{Mount: "E:", UsedPct: 97, FreeGB: 0.1, TotalGB: 2})
	value, target, ok := monitorValue(rules[0], s)
	if !ok || target != "C:" || value != 54 {
		t.Fatalf("got %v %q %v", value, target, ok)
	}
}

func TestDiskActivityAndGatewayMonitorsReadTheSample(t *testing.T) {
	s := testSample(time.Now(), 10)
	s.DiskBusy, s.GwMs, s.GwLoss = f64(97), f64(180), f64(25)
	for metric, want := range map[string]float64{"disk_busy": 97, "gw_ms": 180, "gw_loss": 25} {
		if v, _, ok := monitorValue(monitorRule{Metric: metric}, s); !ok || v != want {
			t.Fatalf("%s: %v %v", metric, v, ok)
		}
	}
	if _, _, ok := monitorValue(monitorRule{Metric: "disk_busy"}, testSample(time.Now(), 10)); ok {
		t.Fatal("no reading, no value")
	}
}

func TestAServiceMonitorFiresWithTheStoppedNamesAfterItsDuration(t *testing.T) {
	stopped := []string{"MSSQL$SAGE"}
	original := serviceProbe
	serviceProbe = func(target string) ([]string, bool) {
		if target != "MSSQL*, vmms" {
			t.Fatalf("target %q", target)
		}
		return stopped, true
	}
	t.Cleanup(func() { serviceProbe = original })

	rules := []monitorRule{{Key: "services", Metric: "service", Op: ">", Threshold: 0, DurationS: 300, Enabled: true, Target: "MSSQL*, vmms"}}
	states := map[string]*monitorState{}
	start := time.Now()
	if ev := evaluateMonitors(rules, states, testSample(start, 10), start); len(ev) != 0 {
		t.Fatalf("fired before its duration: %+v", ev)
	}
	ev := evaluateMonitors(rules, states, testSample(start, 10), start.Add(5*time.Minute))
	if len(ev) != 1 || ev[0].State != "firing" || ev[0].Target != "MSSQL$SAGE" || *ev[0].Value != 1 {
		t.Fatalf("got %+v", ev)
	}
	stopped = nil
	evaluateMonitors(rules, states, testSample(start, 10), start.Add(6*time.Minute))
	ev = evaluateMonitors(rules, states, testSample(start, 10), start.Add(7*time.Minute))
	if len(ev) != 1 || ev[0].State != "ok" {
		t.Fatalf("want ok after two clear samples, got %+v", ev)
	}
}

func TestServicePatternsMatchAutomaticServicesOnly(t *testing.T) {
	patterns := parseServicePatterns(" MSSQL* , vmms,, * ,NTDS")
	if len(patterns) != 3 {
		t.Fatalf("patterns %+v", patterns)
	}
	services := []serviceState{
		{name: "MSSQL$SAGE", stopped: true, automatic: true},
		{name: "MSSQLFDLauncher", stopped: true, automatic: false}, // manual: stopped on purpose
		{name: "vmms", stopped: false, automatic: true},
		{name: "Spooler", stopped: true, automatic: true}, // not watched
	}
	stopped, watched := watchedStopped(patterns, services)
	if !watched || len(stopped) != 1 || stopped[0] != "MSSQL$SAGE" {
		t.Fatalf("stopped %v watched %v", stopped, watched)
	}
	if _, watched := watchedStopped(parseServicePatterns("NTDS"), services); watched {
		t.Fatal("a service that is not installed is not watched")
	}
}

func TestStartTypesAreReadAgainOnlyEvery30Minutes(t *testing.T) {
	c := &startTypeCache{}
	reads := 0
	read := func() map[string]bool { reads++; return map[string]bool{"vmms": true} }
	now := time.Now()
	c.get(now, read)
	c.get(now.Add(29*time.Minute), read)
	c.get(now.Add(31*time.Minute), read)
	if reads != 2 {
		t.Fatalf("reads %d", reads)
	}
}

// ── what the sample carries ─────────────────────────────────────────────────

func TestANewSampleCarriesTheNewFieldsAndAnOldOneDoesNot(t *testing.T) {
	s := testSample(time.Now(), 50)
	plain, _ := json.Marshal(s)
	for _, key := range []string{"disk_busy", "gw_ms", "top"} {
		if strings.Contains(string(plain), key) {
			t.Fatalf("%s sent without a reading: %s", key, plain)
		}
	}
	s.DiskBusy, s.WanMs = f64(12.5), f64(31)
	s.Top = []topProcess{{Name: "sqlservr.exe", CPU: 41.5, MemMB: 6120}}
	full, _ := json.Marshal(s)
	if !strings.Contains(string(full), `"disk_busy":12.5`) || !strings.Contains(string(full), `"top":[{"n":"sqlservr.exe","c":41.5,"m":6120}]`) {
		t.Fatalf("got %s", full)
	}
}
