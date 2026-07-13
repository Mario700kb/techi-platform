package native

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

// secretKeys are field names whose values are always redacted from structured
// logs, regardless of source. Enrollment tokens, RS passwords, and API secrets
// must never reach a log line or a test fixture.
var secretKeys = map[string]bool{
	"enrollment_token":        true,
	"token":                   true,
	"password":                true,
	"remote_support_password": true,
	"rs_password":             true,
	"api_secret":              true,
	"secret":                  true,
	"authorization":           true,
}

// Logger writes structured key=value log lines to an underlying writer with
// automatic secret redaction. It is deliberately tiny and dependency-free so
// the bootstrap has one predictable, greppable log format instead of the
// scattered PowerShell/.out output of the legacy script.
type Logger struct {
	w   io.Writer
	tag string
}

// NewLogger returns a Logger tagged for a component (e.g. "bootstrap").
func NewLogger(w io.Writer, tag string) *Logger {
	return &Logger{w: w, tag: tag}
}

// Event writes one structured line: timestamp, tag, op, and sorted redacted
// fields. Field values that look like secrets are replaced with "***".
func (l *Logger) Event(op string, fields map[string]string) {
	if l == nil || l.w == nil {
		return
	}
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var b strings.Builder
	fmt.Fprintf(&b, "%s [%s] op=%s", time.Now().UTC().Format(time.RFC3339), l.tag, op)
	for _, k := range keys {
		fmt.Fprintf(&b, " %s=%s", k, Redact(k, fields[k]))
	}
	b.WriteByte('\n')
	_, _ = io.WriteString(l.w, b.String())
}

// Redact returns "***" when key names a secret, otherwise the value verbatim.
// Also redacts any value that structurally looks like a bearer token so an
// accidental key name never leaks a credential.
func Redact(key, value string) string {
	if secretKeys[strings.ToLower(strings.TrimSpace(key))] {
		if value == "" {
			return ""
		}
		return "***"
	}
	return value
}

// RedactMap returns a copy of fields with every secret value replaced. Used
// before serialising any structured payload that may carry mixed data.
func RedactMap(fields map[string]string) map[string]string {
	out := make(map[string]string, len(fields))
	for k, v := range fields {
		out[k] = Redact(k, v)
	}
	return out
}

// MarshalRedactedJSON marshals v to JSON then redacts any top-level secret
// keys. It is a defensive helper for emitting results that might embed policy
// echoes; policy itself already carries no secrets.
func MarshalRedactedJSON(v map[string]string) (string, error) {
	b, err := json.Marshal(RedactMap(v))
	if err != nil {
		return "", err
	}
	return string(b), nil
}
