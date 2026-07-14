package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// fakePlatform is a deterministic, OS-neutral Platform used to exercise the
// shared expansion-inventory wiring without depending on the host OS that
// compiles the tests. (On a Linux CI runner the real currentPlatform() reports
// live Linux data, which is why these tests must inject a collector instead.)
type fakePlatform struct {
	caps  []string
	extra ExtraInventory
}

func (f fakePlatform) Capabilities() []string         { return f.caps }
func (f fakePlatform) ExtraInventory() ExtraInventory { return f.extra }

// linuxExpansionJSONFields are the Platform Expansion keys that must be absent
// from a payload whose collector reported nothing (Windows/other).
var linuxExpansionJSONFields = []string{
	"fqdn", "kernel_version", "architecture", "mac_address",
	"timezone", "last_boot_at", "capabilities",
}

func marshalPayload(t *testing.T, inv *Inventory) string {
	t.Helper()
	payload := buildHeartbeatPayload(&Config{}, inv, RustDeskInfo{}, nil, nil, nil, nil, nil)
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(data)
}

// A payload whose effective platform is Windows (collector reports nothing) must
// omit every Platform Expansion field. Injecting the collector explicitly keeps
// this deterministic on Linux, macOS and Windows hosts — a simulated Windows
// payload on a Linux CI runner no longer leaks the runner's Linux host data.
func TestNonLinuxPayloadOmitsExpansionFields(t *testing.T) {
	inv := &Inventory{Hostname: "host", Platform: "windows"}
	applyExpansionInventory(inv, fakePlatform{}) // non-Linux: reports nothing extra
	js := marshalPayload(t, inv)
	for _, field := range linuxExpansionJSONFields {
		if strings.Contains(js, "\""+field+"\"") {
			t.Errorf("non-Linux payload must omit %q, got: %s", field, js)
		}
	}
}

// A real Linux Agent's collector populates the expansion fields; a simulated
// Linux payload (fake collector) must carry them through to the JSON.
func TestSimulatedLinuxPayloadIncludesExpansionFields(t *testing.T) {
	inv := &Inventory{Hostname: "host", Platform: "linux"}
	applyExpansionInventory(inv, fakePlatform{
		caps: []string{"terminal", "bash", "systemd", "journal", "docker"},
		extra: ExtraInventory{
			FQDN:          "host.example.com",
			KernelVersion: "6.8.0-fake",
			Architecture:  "x86_64",
			MACAddress:    "aa:bb:cc:dd:ee:ff",
			Timezone:      "UTC",
			LastBootAt:    "2026-07-14T00:00:00Z",
		},
	})
	js := marshalPayload(t, inv)
	for _, want := range []string{
		`"fqdn":"host.example.com"`,
		`"kernel_version":"6.8.0-fake"`,
		`"architecture":"x86_64"`,
		`"mac_address":"aa:bb:cc:dd:ee:ff"`,
		`"timezone":"UTC"`,
		`"last_boot_at":"2026-07-14T00:00:00Z"`,
		`"capabilities":[`,
		`"systemd"`,
		`"docker"`,
	} {
		if !strings.Contains(js, want) {
			t.Errorf("simulated Linux payload must include %s, got: %s", want, js)
		}
	}
}

// A best-effort collector whose probes mostly failed (only one field resolved,
// no capabilities) must still yield a valid heartbeat, with the base fields
// intact and no partial cross-platform leakage of the unresolved fields.
func TestExpansionCollectorErrorKeepsBaseHeartbeatValid(t *testing.T) {
	inv := &Inventory{Hostname: "host", Platform: "linux", OSName: "linux"}
	applyExpansionInventory(inv, fakePlatform{extra: ExtraInventory{Architecture: "arm64"}})
	js := marshalPayload(t, inv)

	if !strings.Contains(js, `"hostname":"host"`) || !strings.Contains(js, `"platform":"linux"`) {
		t.Fatalf("base heartbeat fields must survive a partial collector: %s", js)
	}
	if !strings.Contains(js, `"architecture":"arm64"`) {
		t.Errorf("the one resolved field should be present: %s", js)
	}
	for _, omitted := range []string{"fqdn", "kernel_version", "mac_address", "timezone", "last_boot_at", "capabilities"} {
		if strings.Contains(js, "\""+omitted+"\"") {
			t.Errorf("unresolved field %q must be omitted (no leakage): %s", omitted, js)
		}
	}
}

// Expansion presence is driven by the injected collector, not by the platform
// string: an empty or noncanonical platform with an empty collector still omits
// everything, and a populated collector still includes everything.
func TestExpansionGatedByCollectorNotPlatformString(t *testing.T) {
	for _, plat := range []string{"", "Windows ", "WINDOWS", "darwin"} {
		inv := &Inventory{Hostname: "h", Platform: plat}
		applyExpansionInventory(inv, fakePlatform{})
		js := marshalPayload(t, inv)
		for _, field := range linuxExpansionJSONFields {
			if strings.Contains(js, "\""+field+"\"") {
				t.Errorf("platform %q with empty collector must omit %q: %s", plat, field, js)
			}
		}
	}

	inv := &Inventory{Hostname: "h", Platform: "not-a-canonical-platform"}
	applyExpansionInventory(inv, fakePlatform{caps: []string{"terminal"}, extra: ExtraInventory{FQDN: "x"}})
	js := marshalPayload(t, inv)
	if !strings.Contains(js, `"fqdn":"x"`) || !strings.Contains(js, `"capabilities":[`) {
		t.Errorf("populated collector must include expansion fields regardless of platform string: %s", js)
	}
}

// Zero-value expansion fields are omitted; set fields are present. Direct proof
// of the struct's omitempty JSON contract.
func TestExpansionOmitemptyContract(t *testing.T) {
	empty := &Inventory{Hostname: "h", Platform: "windows"}
	applyExpansionInventory(empty, fakePlatform{})
	js := marshalPayload(t, empty)
	for _, field := range linuxExpansionJSONFields {
		if strings.Contains(js, "\""+field+"\"") {
			t.Errorf("omitempty: %q must be absent for a zero value: %s", field, js)
		}
	}

	full := &Inventory{Hostname: "h", Platform: "linux"}
	applyExpansionInventory(full, fakePlatform{
		caps:  []string{"terminal"},
		extra: ExtraInventory{FQDN: "f", KernelVersion: "k", Architecture: "a", MACAddress: "m", Timezone: "t", LastBootAt: "b"},
	})
	js = marshalPayload(t, full)
	for _, field := range linuxExpansionJSONFields {
		if !strings.Contains(js, "\""+field+"\"") {
			t.Errorf("omitempty: %q must be present when set: %s", field, js)
		}
	}
}

// A Windows-equivalent collector reports nil capabilities, and no Linux
// capability token may appear anywhere in the payload.
func TestNoLinuxCapabilitiesOnWindows(t *testing.T) {
	inv := &Inventory{Hostname: "h", Platform: "windows"}
	applyExpansionInventory(inv, fakePlatform{})
	if inv.Capabilities != nil {
		t.Errorf("expected nil capabilities, got %v", inv.Capabilities)
	}
	js := marshalPayload(t, inv)
	if strings.Contains(js, `"capabilities"`) {
		t.Errorf("windows payload must not contain a capabilities field: %s", js)
	}
	for _, capToken := range []string{"bash", "systemd", "journal", "docker", "terminal"} {
		if strings.Contains(js, `"`+capToken+`"`) {
			t.Errorf("windows payload must not contain linux capability %q: %s", capToken, js)
		}
	}
}
