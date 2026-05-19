package main

import "testing"

func TestIsMachineAccount(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		// machine accounts (must be rejected)
		{"WORKGROUP\\DESKTOP-IM4V3G4$", true},
		{"DOMAIN\\server01$", true},
		{"machine$", true},
		{"NT AUTHORITY\\SYSTEM", true},
		{"NT AUTHORITY\\LOCAL SERVICE", true},
		{"NT AUTHORITY\\NETWORK SERVICE", true},
		{"BUILTIN\\Administrators", true},
		{"", true},
		// real users (must be accepted)
		{"DOMAIN\\mario", false},
		{"mario", false},
		{"administrator", false},
		{"CONTOSO\\alice", false},
		{"WORKGROUP\\mario", false},
	}
	for _, tt := range tests {
		got := isMachineAccount(tt.name)
		if got != tt.want {
			t.Errorf("isMachineAccount(%q) = %v, want %v", tt.name, got, tt.want)
		}
	}
}

func TestNormalizeLogonUIValue(t *testing.T) {
	tests := []struct {
		raw  string
		want string
	}{
		{`.\mario`, "mario"},
		{`.\administrator`, "administrator"},
		{`DOMAIN\mario`, `DOMAIN\mario`},
		{`CONTOSO\alice`, `CONTOSO\alice`},
		{`WORKGROUP\DESKTOP-IM4V3G4$`, ""},
		{`NT AUTHORITY\SYSTEM`, ""},
		{`BUILTIN\Administrators`, ""},
		{"machine$", ""},
		{"", ""},
		{"  mario  ", "mario"},
		{"  ", ""},
	}
	for _, tt := range tests {
		got := normalizeLogonUIValue(tt.raw)
		if got != tt.want {
			t.Errorf("normalizeLogonUIValue(%q) = %q, want %q", tt.raw, got, tt.want)
		}
	}
}
