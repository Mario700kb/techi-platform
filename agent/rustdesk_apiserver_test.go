package main

import (
	"strings"
	"testing"
)

const dirtyConfig2 = "rendezvous_server = '139.162.158.208:21116'\r\nnat_type = 1\r\n\r\n[options]\r\ncustom-rendezvous-server = '139.162.158.208'\r\napi-server = 'https://api-rdp.techi.com.al'\r\nkey = 'abc='\r\n"

func TestPlatformAPIServerIsRemovedAndTheRestKept(t *testing.T) {
	cfg := &Config{APIURL: "https://api-rdp.techi.com.al", BackendURL: "https://api-rdp.techi.com.al/api/v1/agent/heartbeat"}
	hosts := platformHosts(cfg)

	got, changed := removeTOMLOptionIf(dirtyConfig2, "api-server", func(v string) bool { return apiServerPointsAtPlatform(v, hosts) })

	if !changed || strings.Contains(got, "api-server") {
		t.Fatalf("api-server not removed: changed=%v\n%s", changed, got)
	}
	for _, kept := range []string{"rendezvous_server = '139.162.158.208:21116'", "custom-rendezvous-server = '139.162.158.208'", "key = 'abc='", "nat_type = 1"} {
		if !strings.Contains(got, kept) {
			t.Fatalf("%q lost:\n%s", kept, got)
		}
	}
	if _, again := removeTOMLOptionIf(got, "api-server", func(string) bool { return true }); again {
		t.Fatal("second pass must be a no-op")
	}
}

func TestAnAPIServerSomeoneChoseIsLeftAlone(t *testing.T) {
	hosts := platformHosts(&Config{APIURL: "https://api-rdp.techi.com.al"})
	for _, value := range []string{"https://rustdesk-pro.example.com", "", "not a url at all ::"} {
		if apiServerPointsAtPlatform(value, hosts) {
			t.Fatalf("%q must not be treated as the platform", value)
		}
	}
	if !apiServerPointsAtPlatform("HTTPS://API-RDP.techi.com.al:443/", hosts) {
		t.Fatal("host comparison must ignore case, port and path")
	}
}

func TestOnlyTheOptionsSectionIsTouched(t *testing.T) {
	content := "api-server = 'https://api-rdp.techi.com.al'\n[options]\nkey = 'x'\n"
	if _, changed := removeTOMLOptionIf(content, "api-server", func(string) bool { return true }); changed {
		t.Fatal("a top-level key with the same name is not a Remote Support option")
	}
}

func TestRemoteSupportIsNotRestartedDuringASession(t *testing.T) {
	cases := []struct {
		cmdlines []string
		active   bool
	}{
		{[]string{`"C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" --service`}, false},
		{[]string{`"...\TECHI Remote Support.exe" --service`, `"...\TECHI Remote Support.exe" --server`}, false},
		{[]string{`"...\TECHI Remote Support.exe" --service`, `"...\TECHI Remote Support.exe" --cm`}, true},
		{[]string{`"...\TECHI Remote Support.exe" --service`, ""}, true},
		{nil, false},
	}
	for _, c := range cases {
		if got := remoteSupportSessionActive(c.cmdlines); got != c.active {
			t.Fatalf("remoteSupportSessionActive(%q) = %v, want %v", c.cmdlines, got, c.active)
		}
	}
}
