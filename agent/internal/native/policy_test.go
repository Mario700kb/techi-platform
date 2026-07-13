package native

import (
	"strings"
	"testing"
)

const goodSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func validPolicyJSON() string {
	return `{
	  "schema_version": 1,
	  "rollout_mode": "disabled",
	  "api_url": "https://api-rdp.techi.com.al",
	  "agent": {
	    "target_version": "2.1.8",
	    "package_type": "exe",
	    "filename": "TECHI-Agent-2.1.8.exe",
	    "sha256": "` + goodSHA + `",
	    "repair_msi_filename": "TECHI-Agent-2.1.8.msi",
	    "repair_msi_sha256": "` + goodSHA + `"
	  },
	  "remote_support": {
	    "target_version": "1.4.6",
	    "payload_filename": "TECHI-Remote-Support-1.4.6.zip",
	    "sha256": "` + goodSHA + `",
	    "repair_missing": true
	  }
	}`
}

func TestParsePolicy_Valid(t *testing.T) {
	p, code, err := ParsePolicy([]byte(validPolicyJSON()))
	if err != nil || code != ExitOK {
		t.Fatalf("expected valid policy, got code=%v err=%v", code, err)
	}
	if p.RolloutMode != RolloutDisabled {
		t.Fatalf("rollout mode = %q", p.RolloutMode)
	}
	if p.Agent.TargetVersion != "2.1.8" || p.RemoteSupport.TargetVersion != "1.4.6" {
		t.Fatalf("versions parsed wrong: %+v", p)
	}
}

func TestParsePolicy_RejectsSecretsField(t *testing.T) {
	// A stray enrollment_token (or any unknown field) must be rejected: the
	// policy contract carries no secrets.
	js := strings.Replace(validPolicyJSON(), `"repair_missing": true`,
		`"repair_missing": true, "enrollment_token": "TOKEN"`, 1)
	_, code, err := ParsePolicy([]byte(js))
	if err == nil || code != ExitBadArgs {
		t.Fatalf("expected rejection of unknown/secret field, got code=%v err=%v", code, err)
	}
	if strings.Contains(err.Error(), "TOKEN") {
		t.Fatalf("error text leaked the token value: %v", err)
	}
}

func TestPolicy_Validate_Rejections(t *testing.T) {
	cases := map[string]func(*Policy){
		"bad schema":       func(p *Policy) { p.SchemaVersion = 2 },
		"bad rollout":      func(p *Policy) { p.RolloutMode = "on" },
		"http api":         func(p *Policy) { p.APIURL = "http://x" },
		"bad agent ver":    func(p *Policy) { p.Agent.TargetVersion = "2.1" },
		"non-exe agent":    func(p *Policy) { p.Agent.PackageType = "msi" },
		"agent path fname": func(p *Policy) { p.Agent.Filename = `..\evil.exe` },
		"bad agent sha":    func(p *Policy) { p.Agent.SHA256 = "xyz" },
		"half repair":      func(p *Policy) { p.Agent.RepairMSISHA256 = "" },
		"rs slash fname":   func(p *Policy) { p.RemoteSupport.PayloadFilename = "a/b.zip" },
		"rs bad sha":       func(p *Policy) { p.RemoteSupport.SHA256 = "short" },
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			p, _, err := ParsePolicy([]byte(validPolicyJSON()))
			if err != nil {
				t.Fatalf("base policy should parse: %v", err)
			}
			mut(p)
			code, err := p.Validate()
			if err == nil || code != ExitBadArgs {
				t.Fatalf("expected ExitBadArgs, got code=%v err=%v", code, err)
			}
		})
	}
}

func TestPolicy_EmptyRolloutDefaultsDisabled(t *testing.T) {
	p, _, err := ParsePolicy([]byte(validPolicyJSON()))
	if err != nil {
		t.Fatal(err)
	}
	p.RolloutMode = ""
	if code, err := p.Validate(); err != nil || code != ExitOK {
		t.Fatalf("empty rollout should default, got %v %v", code, err)
	}
	if p.RolloutMode != RolloutDisabled {
		t.Fatalf("empty rollout must default to disabled, got %q", p.RolloutMode)
	}
}
