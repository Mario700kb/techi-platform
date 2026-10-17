package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
)

// The security posture is a small read-only snapshot of how a Windows machine
// is protected: antivirus, firewall, BitLocker on the system drive, UAC,
// Secure Boot and who is in the local Administrators group. It is collected
// every six hours (and on a forced refresh) by one PowerShell script and sent
// only when it changed, or every six hours, so heartbeats stay small. A probe
// that cannot be read is null, never a guess.
const (
	securityPostureRefreshEvery = 6 * time.Hour
	securityPostureResendEvery  = 6 * time.Hour
	// A failed run (PowerShell missing, timed out, unparsable output) keeps
	// the last good posture and is tried again sooner than the schedule.
	securityPostureRetryEvery = time.Hour
	securityPostureTimeout    = 30 * time.Second

	maxLocalAdmins       = 50
	maxLocalAdminNameLen = 128
	maxThirdPartyAV      = 10
	maxAVNameLen         = 128
)

// SecurityPosture is the JSON object the posture script prints, and what the
// heartbeat carries as security_posture.
type SecurityPosture struct {
	CollectedAt  string            `json:"collected_at"`
	Defender     DefenderPosture   `json:"defender"`
	ThirdPartyAV postureStringList `json:"third_party_av"`
	Firewall     FirewallPosture   `json:"firewall"`
	BitLocker    BitLockerPosture  `json:"bitlocker"`
	UACEnabled   *bool             `json:"uac_enabled"`
	SecureBoot   *bool             `json:"secure_boot"`
	LocalAdmins  postureStringList `json:"local_admins"`
}

type DefenderPosture struct {
	Present          bool  `json:"present"`
	AntivirusEnabled *bool `json:"antivirus_enabled"`
	RealtimeEnabled  *bool `json:"realtime_enabled"`
	SignatureAgeDays *int  `json:"signature_age_days"`
}

type FirewallPosture struct {
	Domain  *bool `json:"domain"`
	Private *bool `json:"private"`
	Public  *bool `json:"public"`
}

type BitLockerPosture struct {
	SystemDrive       string   `json:"system_drive"`
	Protection        string   `json:"protection"`
	EncryptionPercent *float64 `json:"encryption_percent"`
}

// postureStringList accepts a JSON array, a single string (what PowerShell's
// ConvertTo-Json makes of a one-element pipeline result) or null.
type postureStringList []string

func (l *postureStringList) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if bytes.Equal(data, []byte("null")) {
		*l = nil
		return nil
	}
	if len(data) > 0 && data[0] == '"' {
		var one string
		if err := json.Unmarshal(data, &one); err != nil {
			return err
		}
		*l = postureStringList{one}
		return nil
	}
	if len(data) > 0 && data[0] == '{' {
		// Windows PowerShell 5.1 can wrap an array as {"value":[...],"Count":n}
		// when a module has extended the Array type.
		var wrapped struct {
			Value postureStringList `json:"value"`
		}
		if err := json.Unmarshal(data, &wrapped); err != nil {
			return err
		}
		*l = wrapped.Value
		return nil
	}
	var many []any
	if err := json.Unmarshal(data, &many); err != nil {
		return err
	}
	out := make(postureStringList, 0, len(many))
	for _, item := range many {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	*l = out
	return nil
}

// MarshalJSON writes an empty list as [] rather than null.
func (l postureStringList) MarshalJSON() ([]byte, error) {
	if l == nil {
		return []byte("[]"), nil
	}
	return json.Marshal([]string(l))
}

var errNoPostureJSON = errors.New("security posture: no JSON object in the script output")

// parseSecurityPosture reads the script output (tolerating stray text around
// the JSON object) and normalises it; now stamps a missing or unreadable
// collected_at.
func parseSecurityPosture(raw []byte, now time.Time) (*SecurityPosture, error) {
	start := bytes.IndexByte(raw, '{')
	end := bytes.LastIndexByte(raw, '}')
	if start < 0 || end < start {
		return nil, errNoPostureJSON
	}
	var p SecurityPosture
	if err := json.Unmarshal(raw[start:end+1], &p); err != nil {
		return nil, err
	}
	p.normalise(now)
	return &p, nil
}

func (p *SecurityPosture) normalise(now time.Time) {
	collected := now.UTC()
	if t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(p.CollectedAt)); err == nil {
		collected = t.UTC()
	}
	p.CollectedAt = collected.Format(time.RFC3339)

	if !p.Defender.Present {
		p.Defender.AntivirusEnabled = nil
		p.Defender.RealtimeEnabled = nil
		p.Defender.SignatureAgeDays = nil
	}
	if age := p.Defender.SignatureAgeDays; age != nil && (*age < 0 || *age > 3650) {
		p.Defender.SignatureAgeDays = nil
	}

	p.ThirdPartyAV = normalisePostureNames(p.ThirdPartyAV, maxThirdPartyAV, maxAVNameLen, func(name string) bool {
		return !strings.Contains(strings.ToLower(name), "defender")
	})
	p.LocalAdmins = normalisePostureNames(p.LocalAdmins, maxLocalAdmins, maxLocalAdminNameLen, nil)

	drive := strings.ToUpper(strings.TrimSpace(p.BitLocker.SystemDrive))
	if len(drive) != 2 || drive[1] != ':' || drive[0] < 'A' || drive[0] > 'Z' {
		drive = "C:"
	}
	p.BitLocker.SystemDrive = drive
	switch strings.ToLower(strings.TrimSpace(p.BitLocker.Protection)) {
	case "on":
		p.BitLocker.Protection = "on"
	case "off":
		p.BitLocker.Protection = "off"
	default:
		p.BitLocker.Protection = "unknown"
	}
	if pct := p.BitLocker.EncryptionPercent; pct != nil {
		v := *pct
		if math.IsNaN(v) || math.IsInf(v, 0) {
			p.BitLocker.EncryptionPercent = nil
		} else {
			v = math.Round(math.Max(0, math.Min(100, v))*10) / 10
			p.BitLocker.EncryptionPercent = &v
		}
	}
}

// normalisePostureNames trims, drops empties and case-insensitive duplicates,
// shortens over-long names and keeps at most limit entries.
func normalisePostureNames(in postureStringList, limit, maxLen int, keep func(string) bool) postureStringList {
	out := make(postureStringList, 0, len(in))
	seen := map[string]struct{}{}
	for _, name := range in {
		name = strings.TrimSpace(name)
		if name == "" || (keep != nil && !keep(name)) {
			continue
		}
		if r := []rune(name); len(r) > maxLen {
			name = string(r[:maxLen])
		}
		key := strings.ToLower(name)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, name)
		if len(out) >= limit {
			break
		}
	}
	return out
}

// securityPostureHash is the change detector: collected_at moves on every
// run, so it is left out, otherwise every collection would look like news.
func securityPostureHash(p *SecurityPosture) string {
	if p == nil {
		return ""
	}
	c := *p
	c.CollectedAt = ""
	return contentHash(c)
}

func securityPostureCollected(p *SecurityPosture) bool { return p != nil }
