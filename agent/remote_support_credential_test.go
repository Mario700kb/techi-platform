package main

import (
	"errors"
	"strings"
	"testing"
)

func TestRemoteSupportCredentialFingerprintPreservesExactPasswordBytes(t *testing.T) {
	got, err := remoteSupportCredentialFingerprint(
		"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
		42,
		7,
		" Spécial &?= 密码 ",
	)
	if err != nil {
		t.Fatal(err)
	}
	const want = "9f0b030a8db1ebb5a7342690ce19fd8907a26ed68198495ea42a3df3e3d35783"
	if got != want {
		t.Fatalf("fingerprint = %q, want %q", got, want)
	}
}

func TestRemoteSupportCredentialFingerprintRejectsWeakKey(t *testing.T) {
	if _, err := remoteSupportCredentialFingerprint("c2hvcnQ", 1, 1, "password"); err == nil {
		t.Fatal("expected weak verification key to be rejected")
	}
}

func TestSanitizeCredentialApplyError(t *testing.T) {
	got := sanitizeCredentialApplyError(errors.New("failed 'secret'\nnext\tline"))
	if strings.ContainsAny(got, "'\n\t") {
		t.Fatalf("unsafe error characters retained: %q", got)
	}
	if len(got) > 255 {
		t.Fatalf("sanitized error too long: %d", len(got))
	}
}
