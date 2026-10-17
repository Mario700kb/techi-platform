//go:build windows

package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// The real script on the CI runner (Windows Server, Defender present,
// BitLocker possibly not installed): the output must be one JSON object with
// every key, whatever each probe could read.
func TestTheSecurityPostureScriptPrintsEveryKey(t *testing.T) {
	out, err := runSecurityPostureScript(90 * time.Second) // a cold CI runner loads modules slowly
	if err != nil {
		t.Fatal(err)
	}
	trimmed := strings.TrimSpace(string(out))
	if !strings.HasPrefix(trimmed, "{") || !strings.HasSuffix(trimmed, "}") {
		t.Fatalf("not one JSON object: %q", trimmed)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &top); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, trimmed)
	}
	for _, key := range []string{"collected_at", "defender", "third_party_av", "firewall", "bitlocker", "uac_enabled", "secure_boot", "local_admins"} {
		if _, ok := top[key]; !ok {
			t.Fatalf("key %q missing: %s", key, trimmed)
		}
	}
	nested := map[string][]string{
		"defender":  {"present", "antivirus_enabled", "realtime_enabled", "signature_age_days"},
		"firewall":  {"domain", "private", "public"},
		"bitlocker": {"system_drive", "protection", "encryption_percent"},
	}
	for parent, keys := range nested {
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(top[parent], &obj); err != nil {
			t.Fatalf("%s is not an object: %s", parent, top[parent])
		}
		for _, key := range keys {
			if _, ok := obj[key]; !ok {
				t.Fatalf("%s.%s missing: %s", parent, key, top[parent])
			}
		}
	}
	for _, key := range []string{"third_party_av", "local_admins"} {
		var list []string
		if err := json.Unmarshal(top[key], &list); err != nil {
			t.Fatalf("%s is not a list of strings: %s", key, top[key])
		}
	}
	if _, err := time.Parse(time.RFC3339, strings.Trim(string(top["collected_at"]), `"`)); err != nil {
		t.Fatalf("collected_at is not ISO 8601: %s", top["collected_at"])
	}

	p, err := parseSecurityPosture(out, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	switch p.BitLocker.Protection {
	case "on", "off", "unknown":
	default:
		t.Fatalf("bitlocker protection = %q", p.BitLocker.Protection)
	}
	// The built-in Administrator is always a member of Administrators.
	if len(p.LocalAdmins) == 0 {
		t.Fatalf("no local administrators read: %s", trimmed)
	}
	t.Logf("posture: %s", trimmed)
}
