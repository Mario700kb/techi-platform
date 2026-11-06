package main

// Readers for what Linux publishes about disks, routes, services, security and
// the kernel log. Pure text to values, so their tests run on any system; the
// files and commands behind them are in the *_linux.go files. Whatever cannot
// be read stays null, never a guess, as on Windows.

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ── disk activity ───────────────────────────────────────────────────────────

const linuxSectorBytes = 512 // /proc/diskstats counts 512-byte sectors on every disk

// parseDiskStats finds a device's line in /proc/diskstats; at is the seconds on
// the caller's clock, so the busy share is measured over real elapsed time.
func parseDiskStats(text, device string, at float64) (diskCounters, bool) {
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 14 || fields[2] != device {
			continue
		}
		number := func(i int) (float64, bool) {
			n, err := strconv.ParseFloat(fields[i], 64)
			return n, err == nil
		}
		sectorsRead, ok1 := number(5)
		sectorsWritten, ok2 := number(9)
		busyMs, ok3 := number(12)
		weightedMs, ok4 := number(13)
		if !ok1 || !ok2 || !ok3 || !ok4 {
			return diskCounters{}, false
		}
		return diskCounters{
			readBytes:  uint64(sectorsRead * linuxSectorBytes),
			writeBytes: uint64(sectorsWritten * linuxSectorBytes),
			ioTime:     weightedMs / 1000,
			idleTime:   at - busyMs/1000,
			queryTime:  at,
		}, true
	}
	return diskCounters{}, false
}

// isPhysicalBlockDevice: real and virtual disks, not partitions' containers
// that would count the same bytes twice (dm-*, md*) or loop and RAM devices.
func isPhysicalBlockDevice(name string) bool {
	if strings.Contains(name, "boot") || strings.Contains(name, "rpmb") {
		return false // eMMC's hidden areas
	}
	for _, prefix := range []string{"sd", "nvme", "vd", "xvd", "hd", "mmcblk"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// ── network ─────────────────────────────────────────────────────────────────

// parseDefaultGateway reads /proc/net/route: the default route with the lowest
// metric. Addresses there are little-endian hex.
func parseDefaultGateway(text string) string {
	best, bestMetric := "", -1
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 7 || f[1] != "00000000" {
			continue
		}
		flags, err := strconv.ParseUint(f[3], 16, 32)
		if err != nil || flags&0x2 == 0 { // RTF_GATEWAY
			continue
		}
		v, err := strconv.ParseUint(f[2], 16, 32)
		if err != nil {
			continue
		}
		metric, err := strconv.Atoi(f[6])
		if err != nil {
			continue
		}
		if bestMetric < 0 || metric < bestMetric {
			best, bestMetric = net.IPv4(byte(v), byte(v>>8), byte(v>>16), byte(v>>24)).String(), metric
		}
	}
	return best
}

// icmpEchoRequest builds an ICMP echo request with its checksum.
func icmpEchoRequest(id, seq uint16) []byte {
	msg := []byte{8, 0, 0, 0, byte(id >> 8), byte(id), byte(seq >> 8), byte(seq), 'T', 'E', 'C', 'H', 'I', 0, 0, 0}
	sum := icmpChecksum(msg)
	msg[2], msg[3] = byte(sum>>8), byte(sum)
	return msg
}

func icmpChecksum(data []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(data); i += 2 {
		sum += uint32(data[i])<<8 | uint32(data[i+1])
	}
	if len(data)%2 == 1 {
		sum += uint32(data[len(data)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = sum&0xffff + sum>>16
	}
	return ^uint16(sum)
}

// isICMPEchoReply: the reply to this very request, not another program's.
func isICMPEchoReply(msg []byte, id, seq uint16) bool {
	return len(msg) >= 8 && msg[0] == 0 && msg[1] == 0 &&
		uint16(msg[4])<<8|uint16(msg[5]) == id && uint16(msg[6])<<8|uint16(msg[7]) == seq
}

// ── services ────────────────────────────────────────────────────────────────

// parseSystemdUnits reads `systemctl list-units --type=service --all --plain
// --no-legend`: name → stopped. Failed counts as stopped; an old systemd marks
// a failed unit with a leading bullet, which is skipped.
func parseSystemdUnits(text string) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) > 0 && !strings.Contains(f[0], ".service") {
			f = f[1:]
		}
		if len(f) < 4 || !strings.HasSuffix(f[0], ".service") {
			continue
		}
		active := f[2]
		out[strings.TrimSuffix(f[0], ".service")] = active == "inactive" || active == "failed"
	}
	return out
}

// parseEnabledUnits reads `systemctl list-unit-files --type=service --state=enabled`.
func parseEnabledUnits(text string) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && strings.HasSuffix(f[0], ".service") && f[1] == "enabled" {
			out[strings.ToLower(strings.TrimSuffix(f[0], ".service"))] = true
		}
	}
	return out
}

// mergeServiceStates joins the two: an enabled unit systemd has not loaded is
// not running, so it counts as stopped.
func mergeServiceStates(units map[string]bool, enabled map[string]bool) []serviceState {
	out := make([]serviceState, 0, len(units))
	seen := map[string]bool{}
	for name, stopped := range units {
		seen[strings.ToLower(name)] = true
		out = append(out, serviceState{name: name, stopped: stopped, automatic: enabled[strings.ToLower(name)]})
	}
	for name := range enabled {
		if !seen[name] {
			out = append(out, serviceState{name: name, stopped: true, automatic: true})
		}
	}
	return out
}

// ── security ────────────────────────────────────────────────────────────────

// firewallFromIptables reads `iptables -S INPUT`: on when anything filters what
// comes in. ok is false when the output is not a rule listing.
func firewallFromIptables(text string) (on, ok bool) {
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) >= 3 && f[0] == "-P" && f[1] == "INPUT" {
			ok = true
			if f[2] != "ACCEPT" {
				on = true
			}
		}
		if len(f) >= 2 && f[0] == "-A" && f[1] == "INPUT" {
			on = true
		}
	}
	return on, ok
}

// firewallFromNft reads `nft list ruleset`: on when a chain hooks incoming traffic.
func firewallFromNft(text string) bool { return strings.Contains(text, "hook input") }

// parseAdminGroups reads /etc/group: who holds sudo, wheel or admin.
func parseAdminGroups(text string) []string {
	admins := []string{}
	seen := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Split(strings.TrimSpace(line), ":")
		if len(f) < 4 || (f[0] != "sudo" && f[0] != "wheel" && f[0] != "admin") {
			continue
		}
		for _, name := range strings.Split(f[3], ",") {
			if name = strings.TrimSpace(name); name != "" && !seen[name] {
				seen[name] = true
				admins = append(admins, name)
			}
		}
	}
	sort.Strings(admins)
	return admins
}

// parseRootUsers reads /etc/passwd: every account with uid 0.
func parseRootUsers(text string) []string {
	users := []string{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Split(strings.TrimSpace(line), ":")
		if len(f) >= 3 && f[2] == "0" && f[0] != "" {
			users = append(users, f[0])
		}
	}
	return users
}

// secureBootFromEfivar: the variable's last byte is its value (1 = on).
func secureBootFromEfivar(data []byte) *bool {
	if len(data) == 0 {
		return nil
	}
	on := data[len(data)-1] == 1
	return &on
}

// linuxAntivirusUnits are the products worth naming when their service runs.
var linuxAntivirusUnits = map[string]string{
	"clamav-daemon": "ClamAV", "clamd": "ClamAV", "clamd@scan": "ClamAV",
	"falcon-sensor": "CrowdStrike Falcon", "sentinelone": "SentinelOne", "mdatp": "Microsoft Defender",
	"sav-protect": "Sophos", "cylancesvc": "Cylance", "esets": "ESET", "kesl": "Kaspersky",
	"bdsec": "Bitdefender", "wazuh-agent": "Wazuh",
}

func linuxAntivirusNames(units map[string]bool) []string {
	names := []string{}
	seen := map[string]bool{}
	for unit, stopped := range units {
		if name, known := linuxAntivirusUnits[unit]; known && !stopped && !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// ── device health ───────────────────────────────────────────────────────────

const (
	linuxKernelSource = "linux-kernel"
	linuxBootSource   = "linux-boot"
	linuxSystemd      = "systemd"

	linuxEventPanic       = 1
	linuxEventHardware    = 2
	linuxEventDiskIO      = 3
	linuxEventFilesystem  = 4
	linuxEventOutOfMemory = 5
	linuxEventUncleanBoot = 1
	linuxEventUnitFailed  = 1
)

// classifyKernelMessage names the kernel lines the report keeps, the same kinds
// Windows reports; anything else is dropped so ordinary noise never arrives.
func classifyKernelMessage(message string) (int, bool) {
	m := strings.ToLower(message)
	switch {
	case strings.Contains(m, "kernel panic"), strings.HasPrefix(m, "bug: "), strings.Contains(m, "oops:"):
		return linuxEventPanic, true
	case strings.Contains(m, "machine check"), strings.Contains(m, "hardware error"):
		return linuxEventHardware, true
	case strings.Contains(m, "i/o error, dev"), strings.Contains(m, "critical medium error"),
		strings.Contains(m, "unrecovered read error"):
		// A CD drive with no disc is not a failing disk.
		if strings.Contains(m, "dev sr") || strings.Contains(m, "dev fd") || strings.Contains(m, "dev loop") {
			return 0, false
		}
		return linuxEventDiskIO, true
	case strings.Contains(m, "ext4-fs error"), strings.Contains(m, "ext3-fs error"), strings.Contains(m, "btrfs error"),
		strings.Contains(m, "xfs") && strings.Contains(m, "corruption"), strings.Contains(m, "remounting filesystem read-only"):
		return linuxEventFilesystem, true
	case strings.Contains(m, "out of memory: kill"):
		return linuxEventOutOfMemory, true
	}
	return 0, false
}

// journalEntry is one line of `journalctl -o json`. MESSAGE is an array of bytes
// when it holds non-text, so it stays raw.
type journalEntry struct {
	Message  json.RawMessage `json:"MESSAGE"`
	Realtime string          `json:"__REALTIME_TIMESTAMP"`
	Cursor   string          `json:"__CURSOR"`
	Unit     string          `json:"UNIT"`
}

func (e journalEntry) text() string {
	var s string
	if json.Unmarshal(e.Message, &s) == nil {
		return s
	}
	var raw []byte
	if json.Unmarshal(e.Message, &raw) == nil {
		return string(raw)
	}
	return ""
}

func (e journalEntry) event(source string, id int) (HealthEvent, bool) {
	micros, err := strconv.ParseInt(e.Realtime, 10, 64)
	if err != nil {
		return HealthEvent{}, false
	}
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(e.Cursor))
	return HealthEvent{
		RecordID: int64(hash.Sum64() >> 1),
		Source:   source,
		EventID:  id,
		At:       time.UnixMicro(micros).UTC().Format(time.RFC3339),
		Message:  e.text(),
	}, true
}

// parseKernelJournal keeps the classified kernel lines.
func parseKernelJournal(text string) []HealthEvent {
	var events []HealthEvent
	for _, line := range strings.Split(text, "\n") {
		var entry journalEntry
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		if id, keep := classifyKernelMessage(entry.text()); keep {
			if event, ok := entry.event(linuxKernelSource, id); ok {
				events = append(events, event)
			}
		}
	}
	return events
}

// parseFailedUnits keeps systemd's "<unit>: Failed with result" lines: a service
// that crashed, not one an administrator stopped.
func parseFailedUnits(text string) []HealthEvent {
	var events []HealthEvent
	for _, line := range strings.Split(text, "\n") {
		var entry journalEntry
		if json.Unmarshal([]byte(line), &entry) != nil || !strings.Contains(entry.text(), "Failed with result") {
			continue
		}
		if event, ok := entry.event(linuxSystemd, linuxEventUnitFailed); ok {
			events = append(events, event)
		}
	}
	return events
}

// previousBootEndedCleanly reads the last lines of the previous boot's journal.
// ok is false when there is nothing to judge by (a journal kept only in memory).
func previousBootEndedCleanly(text string) (clean, ok bool) {
	if strings.TrimSpace(text) == "" {
		return false, false
	}
	for _, marker := range []string{"Reached target Shutdown", "Reached target Power-Off", "Reached target Reboot",
		"Reached target System Reboot", "Reached target System Power Off", "Reached target Halt", "Journal stopped",
		"Shutting down.", "systemd-shutdown"} {
		if strings.Contains(text, marker) {
			return true, true
		}
	}
	return false, true
}

// smartctlReport is the part of `smartctl -j -H -A` the report uses.
type smartctlReport struct {
	SmartStatus *struct {
		Passed bool `json:"passed"`
	} `json:"smart_status"`
	Temperature *struct {
		Current *int64 `json:"current"`
	} `json:"temperature"`
	PowerOnTime *struct {
		Hours *int64 `json:"hours"`
	} `json:"power_on_time"`
	NVMe *struct {
		PercentageUsed *int64 `json:"percentage_used"`
		MediaErrors    *int64 `json:"media_errors"`
	} `json:"nvme_smart_health_information_log"`
}

// applySmartctl fills a disk from smartctl's JSON; ok is false when unreadable.
func applySmartctl(d *HealthDisk, output []byte) bool {
	var r smartctlReport
	if json.Unmarshal(output, &r) != nil || r.SmartStatus == nil {
		return false
	}
	failing := !r.SmartStatus.Passed
	d.PredictFailure = &failing
	d.Health = "healthy"
	if failing {
		d.Health = "unhealthy"
	}
	if r.Temperature != nil {
		d.TemperatureC = r.Temperature.Current
	}
	if r.PowerOnTime != nil {
		d.PowerOnHours = r.PowerOnTime.Hours
	}
	if r.NVMe != nil {
		d.WearPct = r.NVMe.PercentageUsed
		d.ReadErrors = r.NVMe.MediaErrors
	}
	return true
}

// linuxDiskBus names the bus from the device's name and its sysfs path.
func linuxDiskBus(name, sysPath string) string {
	switch {
	case strings.HasPrefix(name, "nvme"):
		return "NVMe"
	case strings.HasPrefix(name, "mmcblk"):
		return "SD"
	case strings.HasPrefix(name, "vd"), strings.HasPrefix(name, "xvd"):
		return "Virtual"
	case strings.Contains(sysPath, "/usb"):
		return "USB"
	case strings.Contains(sysPath, "/ata"):
		return "SATA"
	}
	return ""
}

func linuxDiskName(name, model string) string {
	if model = strings.TrimSpace(model); model != "" {
		return model
	}
	return fmt.Sprintf("/dev/%s", name)
}
