package native

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func writeTemp(t *testing.T, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, data, 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func shaOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestVerifyPayload(t *testing.T) {
	data := []byte("payload-bytes")
	good := shaOf(data)
	p := writeTemp(t, "payload.zip", data)

	if code, err := VerifyPayload(p, good); err != nil || code != ExitOK {
		t.Fatalf("valid payload rejected: code=%v err=%v", code, err)
	}
	if code, _ := VerifyPayload(p, shaOf([]byte("other"))); code != ExitIdentityFailed {
		t.Fatalf("bad sha should be ExitIdentityFailed, got %v", code)
	}
	if code, _ := VerifyPayload(filepath.Join(t.TempDir(), "nope.zip"), good); code != ExitPayloadMissing {
		t.Fatalf("missing payload should be ExitPayloadMissing, got %v", code)
	}
	empty := writeTemp(t, "empty.zip", nil)
	if code, _ := VerifyPayload(empty, good); code != ExitPayloadMissing {
		t.Fatalf("empty payload should be ExitPayloadMissing, got %v", code)
	}
	if code, _ := VerifyPayload(p, "notahash"); code != ExitBadArgs {
		t.Fatalf("bad expected-sha format should be ExitBadArgs, got %v", code)
	}
}

func TestNoopAuthenticodeVerifier(t *testing.T) {
	var v AuthenticodeVerifier = NoopAuthenticodeVerifier{}
	if err := v.VerifySignature("anything"); err != ErrSignatureNotEnforced {
		t.Fatalf("default verifier must never claim a file is signed, got %v", err)
	}
}
