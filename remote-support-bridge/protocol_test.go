package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseProtocolURIAcceptsTokenOnly(t *testing.T) {
	token := strings.Repeat("A", 43)
	got, err := parseProtocolURI("techiremotesupport://connect?token=" + token)
	if err != nil || got != token {
		t.Fatalf("parseProtocolURI() = %q, %v", got, err)
	}
}

func TestParseProtocolURIRejectsCredentialAndExtraData(t *testing.T) {
	token := strings.Repeat("A", 43)
	cases := []string{
		"techiremotesupport://connect?token=" + token + "&password=secret",
		"techiremotesupport://486641675?token=" + token,
		"rustdesk://connect?token=" + token,
		"techiremotesupport://connect/path?token=" + token,
		"techiremotesupport://connect?token=" + token + "#fragment",
		"techiremotesupport://connect?token=short",
	}
	for _, raw := range cases {
		if _, err := parseProtocolURI(raw); err == nil {
			t.Fatalf("accepted non-contract URI %q", raw)
		}
	}
}

func TestHTTPSRedemptionAndNoRedirect(t *testing.T) {
	token := strings.Repeat("T", 43)
	password := "Password-Not-In-URI"
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/remote-support/connect-tokens/redeem" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"remote_id":"486641675","password":"` + password + `","receipt":"` + strings.Repeat("R", 43) + `"}`))
	}))
	defer server.Close()
	api := &bridgeAPI{baseURL: server.URL, client: server.Client()}
	result, err := api.redeem(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	if result.Password != password || result.RemoteID != "486641675" {
		t.Fatal("redemption response mismatch")
	}

	redirectTarget := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("redirect was followed")
	}))
	defer redirectTarget.Close()
	redirectSource := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Redirect(w, nil, redirectTarget.URL, http.StatusFound)
	}))
	defer redirectSource.Close()
	client := redirectSource.Client()
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	redirectAPI := &bridgeAPI{baseURL: redirectSource.URL, client: client}
	if _, err := redirectAPI.redeem(context.Background(), token); err == nil {
		t.Fatal("redirect response was accepted")
	}
}

func TestPeerConfigHandoffRestoresExistingFile(t *testing.T) {
	root := t.TempDir()
	target, err := peerConfigPath(root, "486641675")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	original := []byte("password = [1, 2, 3]\nalias = 'kept-byte-for-byte'\n")
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}
	password := []byte("SecretPassword12")
	launched := false
	err = performPeerConfigHandoff(
		context.Background(),
		target,
		password,
		func(string) error { return nil },
		func(path string) error {
			current, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			if string(passwordFromTOML(current)) != string(password) {
				return errors.New("password was not handed to client config")
			}
			launched = true
			return os.WriteFile(path, []byte("password = [48, 48, 65, 66]\n"), 0o600)
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !launched {
		t.Fatal("client was not launched")
	}
	restored, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != string(original) {
		t.Fatalf("original peer config was not restored: %q", restored)
	}
	if _, err := os.Stat(target + ".techi-handoff"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("handoff journal was not removed")
	}
}

func TestPeerConfigHandoffRemovesNewFileAfterConsumption(t *testing.T) {
	target, _ := peerConfigPath(t.TempDir(), "486641675")
	err := performPeerConfigHandoff(
		context.Background(), target, []byte("SecretPassword12"),
		func(string) error { return nil },
		func(path string) error {
			return os.WriteFile(path, []byte("password = [48, 48, 65, 66]\n"), 0o600)
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("ephemeral peer config remains after consumption")
	}
}

func TestCancelledHandoffAlwaysRestoresOriginal(t *testing.T) {
	target, _ := peerConfigPath(t.TempDir(), "486641675")
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	original := []byte("alias = 'original'\n")
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	err := performPeerConfigHandoff(ctx, target, []byte("SecretPassword12"), func(string) error { return nil }, func(string) error { return nil })
	if err == nil || err.Error() != "handoff_cancelled" {
		t.Fatalf("expected cancellation, got %v", err)
	}
	restored, _ := os.ReadFile(target)
	if string(restored) != string(original) {
		t.Fatal("cancelled handoff did not restore original")
	}
}

func TestStaleHandoffRecovery(t *testing.T) {
	target, _ := peerConfigPath(t.TempDir(), "486641675")
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("password = [83]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target+".techi-backup", []byte("alias = 'original'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target+".techi-handoff", []byte("v1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := recoverStaleHandoff(target); err != nil {
		t.Fatal(err)
	}
	restored, _ := os.ReadFile(target)
	if string(restored) != "alias = 'original'\n" {
		t.Fatal("stale handoff was not restored")
	}
}
