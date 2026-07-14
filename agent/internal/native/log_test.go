package native

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

// nonSecretFixture builds a clearly non-sensitive, uniquely-labelled value at
// runtime. Generating the value (rather than hardcoding a password-shaped
// literal) keeps secret scanners from flagging the test, while still letting the
// assertions prove the exact plaintext never reaches the serialized log.
func nonSecretFixture(label string) string {
	return "not-a-secret-" + label + "-" + strconv.FormatInt(time.Now().UnixNano(), 36)
}

func TestLogger_RedactsSecrets(t *testing.T) {
	tokenValue := nonSecretFixture("enrollment-token")
	passwordValue := nonSecretFixture("remote-support-password")

	var b strings.Builder
	l := NewLogger(&b, "bootstrap")
	l.Event("apply-policy", map[string]string{
		"enrollment_token":        tokenValue,
		"remote_support_password": passwordValue,
		"version":                 "2.1.8",
		"result":                  "ok",
	})
	out := b.String()

	// Plaintext secret input must not appear anywhere in the serialized log.
	if strings.Contains(out, tokenValue) || strings.Contains(out, passwordValue) {
		t.Fatalf("secret leaked into log line: %q", out)
	}
	// Secret keys must be redacted to *** — including remote_support_password.
	if !strings.Contains(out, "enrollment_token=***") {
		t.Fatalf("expected enrollment_token redaction marker, got %q", out)
	}
	if !strings.Contains(out, "remote_support_password=***") {
		t.Fatalf("expected remote_support_password redaction marker, got %q", out)
	}
	// Non-secret fields still pass through unchanged.
	if !strings.Contains(out, "version=2.1.8") {
		t.Fatalf("non-secret field should pass through: %q", out)
	}
}

func TestRedactMap(t *testing.T) {
	secret := nonSecretFixture("password")
	got := RedactMap(map[string]string{"password": secret, "ok": "y"})
	if got["password"] != "***" || got["ok"] != "y" {
		t.Fatalf("redact map wrong: %+v", got)
	}
	if got["password"] == secret {
		t.Fatalf("password value must be redacted, not passed through")
	}
}
