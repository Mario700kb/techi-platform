package main

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

const diskstats = `   8       0 sda 100 0 2000 50 300 0 4000 80 0 500 700 0 0 0 0
   8       1 sda1 90 0 1000 40 200 0 3000 60 0 400 600 0 0 0 0
 179       0 mmcblk0 10 0 200 5 30 0 400 8 0 50 70
`

func TestDiskStatsGiveBytesAndBusyTime(t *testing.T) {
	c, ok := parseDiskStats(diskstats, "sda", 10)
	if !ok || c.readBytes != 2000*512 || c.writeBytes != 4000*512 {
		t.Fatalf("%+v %v", c, ok)
	}
	if c.queryTime != 10 || c.idleTime != 9.5 || c.ioTime != 0.7 {
		t.Fatalf("%+v", c)
	}
	if _, ok := parseDiskStats(diskstats, "sdz", 10); ok {
		t.Fatal("unknown device")
	}
}

func TestDiskActivityWorksOnLinuxDeviceNames(t *testing.T) {
	readings := []diskCounters{
		{readBytes: 0, writeBytes: 0, idleTime: 0, queryTime: 0},
		{readBytes: 60_000_000, writeBytes: 0, idleTime: 45, ioTime: 30, queryTime: 60},
	}
	call := 0
	activity := diskActivity{read: func(string) (diskCounters, bool) { call++; return readings[call-1], true }}
	if busy, _, _, _ := activity.sample([]string{"sda"}); busy != nil {
		t.Fatal("first call is the baseline")
	}
	busy, queue, read, _ := activity.sample([]string{"sda"})
	if busy == nil || *busy != 25 || *queue != 0.5 || *read != 1_000_000 {
		t.Fatalf("%v %v %v", busy, queue, read)
	}
}

func TestOnlyWholeDisksAreCounted(t *testing.T) {
	for name, want := range map[string]bool{"sda": true, "nvme0n1": true, "vda": true, "mmcblk0": true, "xvda": true,
		"loop0": false, "ram1": false, "zram0": false, "dm-0": false, "md0": false, "sr0": false, "mmcblk0boot0": false, "mmcblk0rpmb": false} {
		if isPhysicalBlockDevice(name) != want {
			t.Errorf("%s should be %v", name, want)
		}
	}
}

func TestDefaultGatewayIsReadFromTheRouteTable(t *testing.T) {
	table := "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\nwlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\neth0\t00000000\t0132050A\t0003\t0\t0\t100\t00000000\neth0\t0032050A\t00000000\t0001\t0\t0\t100\t00FFFFFF\n"
	if got := parseDefaultGateway(table); got != "10.5.50.1" {
		t.Fatalf("got %q", got)
	}
	if got := parseDefaultGateway("Iface\tDestination\n"); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestEchoRequestsHaveAValidChecksumAndRepliesAreMatched(t *testing.T) {
	msg := icmpEchoRequest(0x1234, 7)
	if icmpChecksum(msg) != 0 {
		t.Fatal("a message with its checksum must sum to zero")
	}
	reply := append([]byte{0, 0, 0, 0}, msg[4:]...)
	if !isICMPEchoReply(reply, 0x1234, 7) || isICMPEchoReply(reply, 0x1234, 8) || isICMPEchoReply(reply, 1, 7) || isICMPEchoReply(msg, 0x1234, 7) {
		t.Fatal("only this request's reply counts")
	}
}

func TestSystemdServicesAreReadWithFailedAndUnloadedAsStopped(t *testing.T) {
	units := parseSystemdUnits("ssh.service loaded active running OpenBSD Secure Shell\nnginx.service loaded failed failed nginx\n● old.service loaded failed failed Old\ncron.service loaded inactive dead cron\nsocket.socket loaded active running x\n")
	if !reflect.DeepEqual(units, map[string]bool{"ssh": false, "nginx": true, "old": true, "cron": true}) {
		t.Fatalf("%v", units)
	}
	enabled := parseEnabledUnits("ssh.service enabled enabled\nnginx.service enabled enabled\ndocker.service enabled enabled\ncron.service disabled enabled\n")
	stopped, watched := watchedStopped(parseServicePatterns("ssh, nginx*, docker, cron"), mergeServiceStates(units, enabled))
	if !watched || !reflect.DeepEqual(stopped, []string{"docker", "nginx"}) {
		t.Fatalf("%v %v: an enabled unit systemd has not loaded is stopped, a disabled one is not watched", stopped, watched)
	}
}

func TestFirewallIsOnlyOffWhenTheToolSaysSo(t *testing.T) {
	if on, ok := firewallFromIptables("-P INPUT ACCEPT\n"); on || !ok {
		t.Fatal("open input chain is off")
	}
	if on, ok := firewallFromIptables("-P INPUT DROP\n"); !on || !ok {
		t.Fatal("a drop policy is on")
	}
	if on, _ := firewallFromIptables("-P INPUT ACCEPT\n-A INPUT -p tcp -j ACCEPT\n"); !on {
		t.Fatal("a rule is on")
	}
	if _, ok := firewallFromIptables("iptables: command failed"); ok {
		t.Fatal("not a listing")
	}
	if !firewallFromNft("table inet filter { chain input { type filter hook input priority 0; } }") || firewallFromNft("table ip nat { }") {
		t.Fatal("nft hook")
	}
}

func TestAdministratorsAreRootAccountsAndAdminGroups(t *testing.T) {
	if got := parseRootUsers("root:x:0:0:root:/root:/bin/bash\ntoor:x:0:0::/:/bin/sh\npi:x:1000:1000::/home/pi:/bin/bash\n"); !reflect.DeepEqual(got, []string{"root", "toor"}) {
		t.Fatalf("%v", got)
	}
	if got := parseAdminGroups("sudo:x:27:pi,ana\nwheel:x:10:ana\nusers:x:100:bob\nadmin:x:4:\n"); !reflect.DeepEqual(got, []string{"ana", "pi"}) {
		t.Fatalf("%v", got)
	}
}

func TestSecureBootReadsTheVariablesLastByte(t *testing.T) {
	if on := secureBootFromEfivar([]byte{6, 0, 0, 0, 1}); on == nil || !*on {
		t.Fatal("on")
	}
	if off := secureBootFromEfivar([]byte{6, 0, 0, 0, 0}); off == nil || *off {
		t.Fatal("off")
	}
	if secureBootFromEfivar(nil) != nil {
		t.Fatal("unreadable is unknown")
	}
}

func TestOnlyARunningAntivirusIsNamed(t *testing.T) {
	got := linuxAntivirusNames(map[string]bool{"clamav-daemon": false, "mdatp": true, "ssh": false})
	if !reflect.DeepEqual(got, []string{"ClamAV"}) {
		t.Fatalf("%v", got)
	}
}

func TestKernelMessagesAreClassifiedAndNoiseDropped(t *testing.T) {
	for message, want := range map[string]int{
		"Kernel panic - not syncing: Fatal exception":             linuxEventPanic,
		"BUG: unable to handle page fault":                        linuxEventPanic,
		"mce: [Hardware Error]: Machine check events logged":      linuxEventHardware,
		"blk_update_request: I/O error, dev sda, sector 123":      linuxEventDiskIO,
		"EXT4-fs error (device sda1): ext4_lookup: deleted inode": linuxEventFilesystem,
		"XFS (sda1): Metadata corruption detected":                linuxEventFilesystem,
		"Out of memory: Killed process 1234 (java)":               linuxEventOutOfMemory,
	} {
		if id, ok := classifyKernelMessage(message); !ok || id != want {
			t.Errorf("%q: %d %v", message, id, ok)
		}
	}
	for _, noise := range []string{"usb 1-1: new high-speed USB device", "I/O error, dev sr0, sector 0", "audit: type=1400"} {
		if _, ok := classifyKernelMessage(noise); ok {
			t.Errorf("%q should be dropped", noise)
		}
	}
}

func TestJournalLinesBecomeEventsThePlatformKeeps(t *testing.T) {
	now := time.Now().UTC()
	micros := now.Add(-time.Hour).UnixMicro()
	stamp := strings.TrimSpace(strings.Join([]string{`"__REALTIME_TIMESTAMP":"`, itoa64(micros), `"`}, ""))
	journal := `{"MESSAGE":"EXT4-fs error (device sda1): bad",` + stamp + `,"__CURSOR":"a"}
{"MESSAGE":[69,88,84,52,45,102,115,32,101,114,114,111,114],` + stamp + `,"__CURSOR":"b"}
{"MESSAGE":"usb connected",` + stamp + `,"__CURSOR":"c"}
not json`
	events := parseKernelJournal(journal)
	if len(events) != 2 || events[0].Source != linuxKernelSource || events[0].EventID != linuxEventFilesystem || events[0].RecordID == events[1].RecordID {
		t.Fatalf("%+v", events)
	}
	failed := parseFailedUnits(`{"MESSAGE":"nginx.service: Failed with result 'exit-code'.",` + stamp + `,"__CURSOR":"d"}
{"MESSAGE":"Started nginx.",` + stamp + `,"__CURSOR":"e"}`)
	if len(failed) != 1 || failed[0].Source != linuxSystemd {
		t.Fatalf("%+v", failed)
	}
	h := DeviceHealth{Events: append(events, failed...), RebootReasons: postureStringList{"package_update", "made_up"}}
	h.normalise(now)
	if len(h.Events) != 3 {
		t.Fatalf("the agent's own filter must keep Linux events: %+v", h.Events)
	}
	if !reflect.DeepEqual([]string(h.RebootReasons), []string{"package_update"}) {
		t.Fatalf("%v", h.RebootReasons)
	}
}

func itoa64(n int64) string {
	out := ""
	for ; n > 0; n /= 10 {
		out = string(rune('0'+n%10)) + out
	}
	return out
}

func TestACleanShutdownIsToldFromASuddenStop(t *testing.T) {
	if clean, ok := previousBootEndedCleanly("...\nReached target Power-Off.\n"); !clean || !ok {
		t.Fatal("clean")
	}
	if clean, ok := previousBootEndedCleanly("sshd: session opened\nnginx: request\n"); clean || !ok {
		t.Fatal("sudden")
	}
	if _, ok := previousBootEndedCleanly("  \n"); ok {
		t.Fatal("no previous log means unknown")
	}
}

func TestSmartctlFillsTheDisk(t *testing.T) {
	d := HealthDisk{Health: "unknown"}
	ok := applySmartctl(&d, []byte(`{"smart_status":{"passed":true},"temperature":{"current":41},"power_on_time":{"hours":1200},"nvme_smart_health_information_log":{"percentage_used":3,"media_errors":0}}`))
	if !ok || d.Health != "healthy" || *d.TemperatureC != 41 || *d.PowerOnHours != 1200 || *d.WearPct != 3 || *d.PredictFailure {
		t.Fatalf("%+v", d)
	}
	bad := HealthDisk{Health: "unknown"}
	applySmartctl(&bad, []byte(`{"smart_status":{"passed":false}}`))
	if bad.Health != "unhealthy" || !*bad.PredictFailure {
		t.Fatalf("%+v", bad)
	}
	unknown := HealthDisk{Health: "unknown"}
	if applySmartctl(&unknown, []byte(`{"device":{"name":"/dev/mmcblk0"}}`)) || unknown.Health != "unknown" {
		t.Fatalf("no SMART stays unknown: %+v", unknown)
	}
}

func TestALinuxPostureKeepsItsSystemDiskAndAWindowsOneADrive(t *testing.T) {
	p := SecurityPosture{Platform: "linux"}
	p.BitLocker.SystemDrive = "/"
	p.BitLocker.Protection = "off"
	p.normalise(time.Now())
	if p.BitLocker.SystemDrive != "/" || p.BitLocker.Protection != "off" {
		t.Fatalf("%+v", p.BitLocker)
	}
	w := SecurityPosture{}
	w.BitLocker.SystemDrive = "d:"
	w.normalise(time.Now())
	if w.BitLocker.SystemDrive != "D:" {
		t.Fatalf("%+v", w.BitLocker)
	}
}
