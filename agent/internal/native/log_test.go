package native

import (
	"strings"
	"testing"
)

func TestLogger_RedactsSecrets(t *testing.T) {
	var b strings.Builder
	l := NewLogger(&b, "bootstrap")
	l.Event("apply-policy", map[string]string{
		"enrollment_token":        "SECRET-TOKEN-VALUE",
		"remote_support_password": "hunter2",
		"version":                 "2.1.8",
		"result":                  "ok",
	})
	out := b.String()
	if strings.Contains(out, "SECRET-TOKEN-VALUE") || strings.Contains(out, "hunter2") {
		t.Fatalf("secret leaked into log line: %q", out)
	}
	if !strings.Contains(out, "enrollment_token=***") {
		t.Fatalf("expected redaction marker, got %q", out)
	}
	if !strings.Contains(out, "version=2.1.8") {
		t.Fatalf("non-secret field should pass through: %q", out)
	}
}

func TestRedactMap(t *testing.T) {
	got := RedactMap(map[string]string{"password": "x", "ok": "y"})
	if got["password"] != "***" || got["ok"] != "y" {
		t.Fatalf("redact map wrong: %+v", got)
	}
}
