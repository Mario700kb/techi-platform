package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

var postureNow = time.Date(2026, 10, 17, 18, 0, 0, 0, time.UTC)

// What the script prints on a Windows 11 Pro laptop (ConvertTo-Json -Compress).
const samplePostureJSON = `{"collected_at":"2026-10-17T17:59:58Z","defender":{"present":true,"antivirus_enabled":true,"realtime_enabled":true,"signature_age_days":1},"third_party_av":[],"firewall":{"domain":true,"private":true,"public":false},"bitlocker":{"system_drive":"C:","protection":"on","encryption_percent":100},"uac_enabled":true,"secure_boot":true,"local_admins":["MARIO-LENOVO\\Administrator","TECHI\\Domain Admins","MARIO-LENOVO\\mario"]}`

func TestThePostureScriptOutputIsParsed(t *testing.T) {
	p, err := parseSecurityPosture([]byte(samplePostureJSON+"\r\n"), postureNow)
	if err != nil {
		t.Fatal(err)
	}
	if p.CollectedAt != "2026-10-17T17:59:58Z" {
		t.Fatalf("collected_at = %q", p.CollectedAt)
	}
	if !p.Defender.Present || !*p.Defender.AntivirusEnabled || !*p.Defender.RealtimeEnabled || *p.Defender.SignatureAgeDays != 1 {
		t.Fatalf("defender = %+v", p.Defender)
	}
	if !*p.Firewall.Domain || !*p.Firewall.Private || *p.Firewall.Public {
		t.Fatalf("firewall = %+v", p.Firewall)
	}
	if p.BitLocker.SystemDrive != "C:" || p.BitLocker.Protection != "on" || *p.BitLocker.EncryptionPercent != 100 {
		t.Fatalf("bitlocker = %+v", p.BitLocker)
	}
	if !*p.UACEnabled || !*p.SecureBoot {
		t.Fatalf("uac=%v secure boot=%v", p.UACEnabled, p.SecureBoot)
	}
	if len(p.LocalAdmins) != 3 || p.LocalAdmins[1] != `TECHI\Domain Admins` {
		t.Fatalf("local admins = %v", p.LocalAdmins)
	}
}

func TestAPostureIsSentWithEveryKeyAndEmptyListsAsArrays(t *testing.T) {
	p, err := parseSecurityPosture([]byte(`{"defender":{"present":false},"firewall":{},"bitlocker":{}}`), postureNow)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(p)
	want := `{"collected_at":"2026-10-17T18:00:00Z","defender":{"present":false,"antivirus_enabled":null,"realtime_enabled":null,"signature_age_days":null},` +
		`"third_party_av":[],"firewall":{"domain":null,"private":null,"public":null},` +
		`"bitlocker":{"system_drive":"C:","protection":"unknown","encryption_percent":null},"uac_enabled":null,"secure_boot":null,"local_admins":[]}`
	if string(data) != want {
		t.Fatalf("marshalled as\n%s\nwant\n%s", data, want)
	}
}

func TestPostureValuesAreNormalised(t *testing.T) {
	var admins []string
	for i := 0; i < 70; i++ {
		admins = append(admins, fmt.Sprintf(`HOST\user%02d`, i))
	}
	adminsJSON, _ := json.Marshal(append([]string{"  ", `HOST\USER00`}, admins...))
	raw := `WARNING: noise before the object
{"collected_at":"not a date","defender":{"present":false,"antivirus_enabled":true,"signature_age_days":-1},
 "third_party_av":"Sophos Endpoint Agent",
 "firewall":{"domain":true,"private":null,"public":false},
 "bitlocker":{"system_drive":"d:","protection":"ON","encryption_percent":187.25},
 "local_admins":` + string(adminsJSON) + `,"extra":{"ignored":true}}
trailing noise`
	p, err := parseSecurityPosture([]byte(raw), postureNow)
	if err != nil {
		t.Fatal(err)
	}
	if p.CollectedAt != "2026-10-17T18:00:00Z" {
		t.Fatalf("an unreadable collected_at is not stamped: %q", p.CollectedAt)
	}
	if p.Defender.AntivirusEnabled != nil || p.Defender.SignatureAgeDays != nil {
		t.Fatalf("an absent Defender keeps values: %+v", p.Defender)
	}
	if len(p.ThirdPartyAV) != 1 || p.ThirdPartyAV[0] != "Sophos Endpoint Agent" {
		t.Fatalf("a single antivirus name is not a list: %v", p.ThirdPartyAV)
	}
	if p.BitLocker.SystemDrive != "D:" || p.BitLocker.Protection != "on" || *p.BitLocker.EncryptionPercent != 100 {
		t.Fatalf("bitlocker = %+v", p.BitLocker)
	}
	if len(p.LocalAdmins) != maxLocalAdmins || p.LocalAdmins[0] != `HOST\USER00` || p.LocalAdmins[1] != `HOST\user01` {
		t.Fatalf("local admins not trimmed, deduplicated and capped: %d %v", len(p.LocalAdmins), p.LocalAdmins[:3])
	}
}

func TestPostureListsAreBoundedAndDefenderIsNotAThirdPartyAV(t *testing.T) {
	long := strings.Repeat("x", 300)
	var av []string
	for i := 0; i < 15; i++ {
		av = append(av, fmt.Sprintf("AV %d", i))
	}
	av = append([]string{"Windows Defender", "Microsoft Defender Antivirus"}, av...)
	avJSON, _ := json.Marshal(av)
	raw := `{"third_party_av":` + string(avJSON) + `,"local_admins":{"value":["` + long + `"],"Count":1},"bitlocker":{"protection":"suspended","encryption_percent":"x"}}`
	if _, err := parseSecurityPosture([]byte(raw), postureNow); err == nil {
		t.Fatal("a string encryption_percent was accepted")
	}
	raw = strings.Replace(raw, `"x"`, `null`, 1)
	p, err := parseSecurityPosture([]byte(raw), postureNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.ThirdPartyAV) != maxThirdPartyAV || p.ThirdPartyAV[0] != "AV 0" {
		t.Fatalf("third-party antivirus = %v", p.ThirdPartyAV)
	}
	if len(p.LocalAdmins) != 1 || len(p.LocalAdmins[0]) != maxLocalAdminNameLen {
		t.Fatalf("a wrapped or over-long admin list is not read: %v", p.LocalAdmins)
	}
	if p.BitLocker.Protection != "unknown" {
		t.Fatalf("protection = %q", p.BitLocker.Protection)
	}
}

func TestOutputWithoutAnObjectIsAnError(t *testing.T) {
	for _, raw := range []string{"", "Get-MpComputerStatus : access denied", "{not json}"} {
		if p, err := parseSecurityPosture([]byte(raw), postureNow); err == nil {
			t.Fatalf("%q parsed as %+v", raw, p)
		}
	}
}

// --- schedule ---

type fakePosture struct {
	calls   int
	posture *SecurityPosture
}

func newPostureInventory(f *fakeInventory, fp *fakePosture) *backgroundInventory {
	return newBackgroundInventory(
		func() time.Time { return f.now },
		func() []ProcessInfo { return nil },
		func() []ServiceInfo { return nil },
		func() []SoftwareInfo { return nil },
		func() *PatchStatus { return &PatchStatus{PatchState: "up_to_date"} },
		func() *SecurityPosture {
			fp.calls++
			if fp.posture == nil {
				return nil
			}
			c := *fp.posture
			c.CollectedAt = f.now.Format(time.RFC3339)
			return &c
		},
		nil,
	)
}

func samplePosture(t *testing.T) *SecurityPosture {
	t.Helper()
	p, err := parseSecurityPosture([]byte(samplePostureJSON), postureNow)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestThePostureIsCollectedEverySixHoursAndSentOnlyWhenChanged(t *testing.T) {
	f, _ := newFakeInventory()
	fp := &fakePosture{posture: samplePosture(t)}
	b := newPostureInventory(f, fp)

	b.collectDue(everything)
	h := b.forHeartbeat(everything)
	if h.Security == nil || fp.calls != 1 {
		t.Fatalf("first posture not sent: %+v calls=%d", h.Security, fp.calls)
	}
	h.sent()

	f.advance(5 * time.Hour)
	b.collectDue(everything)
	if fp.calls != 1 {
		t.Fatalf("collected again before six hours: %d", fp.calls)
	}

	f.advance(time.Hour)
	b.collectDue(everything)
	if fp.calls != 2 {
		t.Fatalf("not collected after six hours: %d", fp.calls)
	}
	// Six hours after the last send it is due for its periodic resend anyway;
	// mark it sent, then an unchanged collection (only collected_at moved)
	// stays home.
	b.forHeartbeat(everything).sent()
	f.advance(6 * time.Hour)
	b.collectDue(everything)
	f.advance(-time.Minute) // within the resend window
	if h := b.forHeartbeat(everything); h.Security != nil {
		t.Fatalf("an unchanged posture was resent: %+v", h.Security)
	}

	f.advance(time.Minute)
	changed := *fp.posture
	off := false
	changed.UACEnabled = &off
	fp.posture = &changed
	b.forceCollect(everything)
	h = b.forHeartbeat(everything)
	if h.Security == nil || *h.Security.UACEnabled {
		t.Fatalf("a changed posture was not sent: %+v", h.Security)
	}
}

func TestAFailedPostureRunKeepsTheLastGoodOneAndRetriesWithinTheHour(t *testing.T) {
	f, _ := newFakeInventory()
	fp := &fakePosture{posture: samplePosture(t)}
	b := newPostureInventory(f, fp)
	b.collectDue(everything)
	b.forHeartbeat(everything).sent()

	fp.posture = nil // PowerShell timed out
	f.advance(securityPostureRefreshEvery)
	b.collectDue(everything)
	h := b.forHeartbeat(everything)
	if h.Security == nil || h.Security.Defender.Present != true {
		t.Fatalf("the last good posture was dropped: %+v", h.Security)
	}
	h.sent()

	f.advance(30 * time.Minute)
	b.collectDue(everything)
	if fp.calls != 2 {
		t.Fatalf("retried too soon: %d", fp.calls)
	}
	f.advance(30 * time.Minute)
	b.collectDue(everything)
	if fp.calls != 3 {
		t.Fatalf("not retried after an hour: %d", fp.calls)
	}
}

func TestNoPostureWithoutACollector(t *testing.T) {
	_, b := newFakeInventory()
	b.collectDue(everything)
	if h := b.forHeartbeat(everything); h.Security != nil {
		t.Fatalf("posture sent without a collector: %+v", h.Security)
	}
	payload := buildHeartbeatPayload(&Config{}, &Inventory{}, RustDeskInfo{}, nil, nil, nil, nil, nil)
	data, _ := json.Marshal(payload)
	if strings.Contains(string(data), "security_posture") {
		t.Fatal("an absent posture is in the heartbeat")
	}
}
