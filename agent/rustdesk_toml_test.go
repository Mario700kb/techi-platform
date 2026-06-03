package main

import (
	"strings"
	"testing"
)

// ------------------------------------------------------------------ //
// helpers                                                              //
// ------------------------------------------------------------------ //

func cfgWithServers() *Config {
	return &Config{
		RustDeskRendezvousServer: "139.162.158.208",
		RustDeskRelayServer:      "139.162.158.208",
		RustDeskKey:              "8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw=",
	}
}

// ------------------------------------------------------------------ //
// stripTOMLQuotes                                                      //
// ------------------------------------------------------------------ //

func TestStripTOMLQuotesSingleDouble(t *testing.T) {
	cases := []struct{ in, want string }{
		{"'hello'", "hello"},
		{`"hello"`, "hello"},
		{"hello", "hello"},
		{"  'hello'  ", "hello"},
		{"''", ""},
		{"'val with = sign'", "val with = sign"},
	}
	for _, c := range cases {
		if got := stripTOMLQuotes(c.in); got != c.want {
			t.Errorf("stripTOMLQuotes(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ------------------------------------------------------------------ //
// parseTOMLOptions                                                     //
// ------------------------------------------------------------------ //

func TestParseTOMLOptionsExtractsSection(t *testing.T) {
	content := `
rendezvous_server = ''
nat_type = 1

[options]
custom-rendezvous-server = '139.162.158.208'
relay-server = "139.162.158.208"
key = '8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw='
`
	opts := parseTOMLOptions(content)
	if opts["custom-rendezvous-server"] != "139.162.158.208" {
		t.Errorf("custom-rendezvous-server: got %q", opts["custom-rendezvous-server"])
	}
	if opts["relay-server"] != "139.162.158.208" {
		t.Errorf("relay-server: got %q", opts["relay-server"])
	}
	if opts["key"] != "8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw=" {
		t.Errorf("key: got %q", opts["key"])
	}
}

func TestParseTOMLOptionsIgnoresOutsideSection(t *testing.T) {
	content := `
custom-rendezvous-server = 'should-be-ignored'

[options]
custom-rendezvous-server = '139.162.158.208'
`
	opts := parseTOMLOptions(content)
	if opts["custom-rendezvous-server"] != "139.162.158.208" {
		t.Errorf("expected options section value, got %q", opts["custom-rendezvous-server"])
	}
}

// ------------------------------------------------------------------ //
// rustDeskConfigNeedsRepair                                            //
// ------------------------------------------------------------------ //

// Test 1: Config e saktë → nuk kërkon riparim.
func TestRustDeskConfigNeedsRepairCorrectConfig(t *testing.T) {
	content := `
rendezvous_server = ''
nat_type = 1
id = '1234567890'
enc_id = 'AbCdEfGh=='
key_pair = ['pubkey', 'privkey']

[options]
custom-rendezvous-server = '139.162.158.208'
relay-server = '139.162.158.208'
key = '8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw='
`
	cfg := cfgWithServers()
	if rustDeskConfigNeedsRepair(content, cfg) {
		t.Fatal("correct config should NOT need repair")
	}
}

// Test 2: Formatim ndryshe (thonjëza dyfishe, hapësira) → nuk kërkon riparim.
func TestRustDeskConfigNeedsRepairDifferentFormatting(t *testing.T) {
	// Service rewrote using double-quotes and extra whitespace — values unchanged.
	content := `
[options]
custom-rendezvous-server = "139.162.158.208"
relay-server =  "139.162.158.208"
key = "8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw="
`
	cfg := cfgWithServers()
	if rustDeskConfigNeedsRepair(content, cfg) {
		t.Fatal("different quote style / whitespace should NOT trigger repair")
	}
}

// Test 3: relay-server mungon → kërkon riparim.
func TestRustDeskConfigNeedsRepairMissingRelay(t *testing.T) {
	content := `
[options]
custom-rendezvous-server = '139.162.158.208'
key = '8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw='
`
	cfg := cfgWithServers()
	if !rustDeskConfigNeedsRepair(content, cfg) {
		t.Fatal("missing relay-server SHOULD need repair")
	}
}

// Test 4: Vlerë e gabuar → kërkon riparim.
func TestRustDeskConfigNeedsRepairWrongValue(t *testing.T) {
	content := `
[options]
custom-rendezvous-server = 'wrong.server.com'
relay-server = '139.162.158.208'
key = '8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw='
`
	cfg := cfgWithServers()
	if !rustDeskConfigNeedsRepair(content, cfg) {
		t.Fatal("wrong rendezvous server SHOULD need repair")
	}
}

// ------------------------------------------------------------------ //
// applyTOMLOptionPatch                                                 //
// ------------------------------------------------------------------ //

// Test 5: Patch ruan fushat e identitetit.
func TestApplyTOMLOptionPatchPreservesIdentityFields(t *testing.T) {
	original := `rendezvous_server = ''
nat_type = 1
id = '9876543210'
enc_id = 'AbCdEfGhIjKlMnOp=='
key_pair = ['pub', 'priv']

[options]
custom-rendezvous-server = 'old.server.com'
relay-server = '139.162.158.208'
key = '8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw='
`
	cfg := cfgWithServers()
	managed := managedRustDeskOptions(cfg)
	result, changed := applyTOMLOptionPatch(original, managed)

	if !changed {
		t.Fatal("patch should report changed (rendezvous was wrong)")
	}
	// Identity fields must be preserved.
	for _, field := range []string{"id = '9876543210'", "enc_id = 'AbCdEfGhIjKlMnOp=='", "key_pair = ['pub', 'priv']"} {
		if !strings.Contains(result, field) {
			t.Errorf("identity field missing after patch: %q", field)
		}
	}
	// Managed value must be updated.
	if !strings.Contains(result, "custom-rendezvous-server = '139.162.158.208'") {
		t.Error("rendezvous server not updated in patch result")
	}
}

// Test 6: Patch të ndryshimit zero → changed=false.
func TestApplyTOMLOptionPatchNoChange(t *testing.T) {
	original := `[options]
custom-rendezvous-server = '139.162.158.208'
relay-server = '139.162.158.208'
key = '8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw='
`
	cfg := cfgWithServers()
	managed := managedRustDeskOptions(cfg)
	_, changed := applyTOMLOptionPatch(original, managed)
	if changed {
		t.Fatal("identical content should produce changed=false")
	}
}

// Test 7: relay mungon → shtohet, fushat e tjera ruhen.
func TestApplyTOMLOptionPatchAddsAbsentKey(t *testing.T) {
	original := `[options]
custom-rendezvous-server = '139.162.158.208'
key = '8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw='
`
	cfg := cfgWithServers()
	managed := managedRustDeskOptions(cfg)
	result, changed := applyTOMLOptionPatch(original, managed)

	if !changed {
		t.Fatal("patch should report changed (relay missing)")
	}
	if !strings.Contains(result, "relay-server = '139.162.158.208'") {
		t.Error("relay-server not added")
	}
	// Existing keys must be preserved.
	if !strings.Contains(result, "custom-rendezvous-server = '139.162.158.208'") {
		t.Error("rendezvous server missing after adding relay")
	}
}

// Test 8: Skedar pa seksion [options] → seksioni shtohet.
func TestApplyTOMLOptionPatchCreatesOptionsSectionIfMissing(t *testing.T) {
	original := `rendezvous_server = ''
nat_type = 1
`
	cfg := cfgWithServers()
	managed := managedRustDeskOptions(cfg)
	result, changed := applyTOMLOptionPatch(original, managed)

	if !changed {
		t.Fatal("should report changed when options section is missing")
	}
	if !strings.Contains(result, "[options]") {
		t.Error("[options] section not added")
	}
	if !strings.Contains(result, "custom-rendezvous-server = '139.162.158.208'") {
		t.Error("rendezvous server not added")
	}
}

// Test 9: Patch me thonjëza dyfishe ekzistuese → ndryshon vetëm vlerat e gabuara.
func TestApplyTOMLOptionPatchHandlesDoubleQuotes(t *testing.T) {
	// Service wrote with double quotes — patch must normalize to single quotes
	// only if the VALUE is wrong; if correct, no write needed.
	original := `[options]
custom-rendezvous-server = "139.162.158.208"
relay-server = "wrong.relay.com"
key = "8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw="
`
	cfg := cfgWithServers()
	managed := managedRustDeskOptions(cfg)
	result, changed := applyTOMLOptionPatch(original, managed)

	if !changed {
		t.Fatal("wrong relay-server should trigger change")
	}
	if !strings.Contains(result, "relay-server = '139.162.158.208'") {
		t.Error("relay-server not corrected")
	}
	// rendezvous value was correct (just different quotes) — implementation
	// may or may not normalize it; the important thing is it's still present.
	if !strings.Contains(result, "139.162.158.208") {
		t.Error("rendezvous value disappeared")
	}
}
