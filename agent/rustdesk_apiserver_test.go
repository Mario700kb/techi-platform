package main

import (
	"strings"
	"testing"
)

const platformConfig2 = "rendezvous_server = '139.162.158.208:21116'\r\nnat_type = 1\r\n\r\n[options]\r\ncustom-rendezvous-server = '139.162.158.208'\r\napi-server = 'https://api-rdp.techi.com.al'\r\nkey = 'abc='\r\n"

func TestAMissingAPIServerIsSetToThePlatform(t *testing.T) {
	cfg := &Config{APIURL: "https://api-rdp.techi.com.al/", BackendURL: "https://api-rdp.techi.com.al/api/v1/agent/heartbeat"}
	content := "rendezvous_server = '139.162.158.208:21116'\n\n[options]\ncustom-rendezvous-server = '139.162.158.208'\nkey = 'abc='\n"

	got, changed := setTOMLOptionIfEmpty(content, "api-server", platformAPIServer(cfg))

	if !changed || !strings.Contains(got, "api-server = 'https://api-rdp.techi.com.al'") {
		t.Fatalf("api-server not set: changed=%v\n%s", changed, got)
	}
	for _, kept := range []string{"rendezvous_server = '139.162.158.208:21116'", "custom-rendezvous-server = '139.162.158.208'", "key = 'abc='"} {
		if !strings.Contains(got, kept) {
			t.Fatalf("%q lost:\n%s", kept, got)
		}
	}
	if _, again := setTOMLOptionIfEmpty(got, "api-server", platformAPIServer(cfg)); again {
		t.Fatal("second pass must be a no-op")
	}
}

func TestAnEmptyAPIServerIsFilled(t *testing.T) {
	got, changed := setTOMLOptionIfEmpty("[options]\napi-server = ''\n", "api-server", "https://api-rdp.techi.com.al")
	if !changed || !strings.Contains(got, "api-server = 'https://api-rdp.techi.com.al'") || strings.Count(got, "api-server") != 1 {
		t.Fatalf("empty api-server not replaced:\n%s", got)
	}
}

func TestAnAPIServerAlreadySetIsKept(t *testing.T) {
	for _, content := range []string{platformConfig2, "[options]\napi-server = 'https://rustdesk-pro.example.com'\n"} {
		if got, changed := setTOMLOptionIfEmpty(content, "api-server", "https://api-rdp.techi.com.al"); changed || got != content {
			t.Fatalf("an api-server already set must be kept:\n%s", got)
		}
	}
}

func TestPlatformAPIServerIsTheBaseURL(t *testing.T) {
	cases := map[Config]string{
		{APIURL: "https://api-rdp.techi.com.al"}:                                 "https://api-rdp.techi.com.al",
		{APIURL: "https://api-rdp.techi.com.al/api/v1/"}:                         "https://api-rdp.techi.com.al",
		{BackendURL: "https://api-rdp.techi.com.al:8443/api/v1/agent/heartbeat"}: "https://api-rdp.techi.com.al:8443",
		{APIURL: "api-rdp.techi.com.al"}:                                         "https://api-rdp.techi.com.al",
		{}:                                                                       "",
	}
	for cfg, want := range cases {
		cfg := cfg
		if got := platformAPIServer(&cfg); got != want {
			t.Fatalf("platformAPIServer(%+v) = %q, want %q", cfg, got, want)
		}
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

func TestRemoteSessionReport(t *testing.T) {
	yes, no := true, false
	cases := []struct {
		cmdlines []string
		want     *bool
	}{
		{nil, &no},
		{[]string{`"...\TECHI Remote Support.exe" --service`}, &no},
		{[]string{`"...\TECHI Remote Support.exe" --service`, `"...\TECHI Remote Support.exe" --cm`}, &yes},
		{[]string{`"...\TECHI Remote Support.exe" --service`, ""}, nil},
	}
	for _, c := range cases {
		got := remoteSessionReport(c.cmdlines)
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("remoteSessionReport(%q) = %v, want %v", c.cmdlines, got, c.want)
		}
	}
}

func TestAnOptionsHeaderWithABOMOrSpacesIsFound(t *testing.T) {
	for _, content := range []string{
		"\ufeff[options]\r\nkey = 'abc='\r\n",
		"[ options ]\nkey = 'abc='\n",
	} {
		got, changed := setTOMLOptionIfEmpty(content, "api-server", "https://api-rdp.techi.com.al")
		if !changed {
			t.Fatalf("api-server not added to %q", content)
		}
		if strings.Count(got, "options") != 1 {
			t.Fatalf("a second [options] table was appended:\n%q", got)
		}
		if strings.HasPrefix(content, "\ufeff") && !strings.HasPrefix(got, "\ufeff") {
			t.Fatalf("the byte-order mark was dropped:\n%q", got)
		}
		if parseTOMLOptions(got)["api-server"] != "https://api-rdp.techi.com.al" {
			t.Fatalf("api-server not readable back from:\n%q", got)
		}
	}
}
