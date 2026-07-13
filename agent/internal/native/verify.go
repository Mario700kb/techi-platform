package native

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
)

// HashFileSHA256 returns the lowercase hex SHA256 of path. It mirrors the
// Agent's existing hashFileSHA256 so the two share one verification contract;
// it lives here so the native package has no dependency on package main.
func HashFileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// VerifyPayload proves a staged payload exists, is non-empty, and matches the
// expected SHA256. It performs NO side effects: it is the identity gate that
// runs before any promotion/execution, so a mismatch can never mutate state.
// It returns a bounded exit code so callers map failures deterministically.
func VerifyPayload(path, expectedSHA string) (ExitCode, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return ExitBadArgs, fmt.Errorf("empty payload path")
	}
	info, err := os.Stat(path)
	if err != nil {
		return ExitPayloadMissing, fmt.Errorf("payload not accessible: %w", err)
	}
	if info.IsDir() {
		return ExitPayloadMissing, fmt.Errorf("payload is a directory, not a file: %s", path)
	}
	if info.Size() == 0 {
		return ExitPayloadMissing, fmt.Errorf("payload is empty: %s", path)
	}
	expectedSHA = strings.ToLower(strings.TrimSpace(expectedSHA))
	if !sha256Re.MatchString(expectedSHA) {
		return ExitBadArgs, fmt.Errorf("expected sha256 must be 64 lowercase hex chars")
	}
	actual, err := HashFileSHA256(path)
	if err != nil {
		return ExitIdentityFailed, fmt.Errorf("cannot hash payload: %w", err)
	}
	if actual != expectedSHA {
		return ExitIdentityFailed, fmt.Errorf("sha256 mismatch: expected %s got %s", expectedSHA, actual)
	}
	return ExitOK, nil
}

// AuthenticodeVerifier is the future signing hook. It is intentionally an
// interface with a no-op default so callers can wire real Authenticode
// verification later WITHOUT this package ever fabricating a certificate or
// pretending a file is signed. Until a real verifier is injected, signature
// verification is explicitly "not enforced".
type AuthenticodeVerifier interface {
	// VerifySignature returns nil when path carries a trusted Authenticode
	// signature. The default implementation returns ErrSignatureNotEnforced.
	VerifySignature(path string) error
}

// ErrSignatureNotEnforced is returned by the default verifier to make it
// unmistakable in logs that signing is not yet enforced on this build.
var ErrSignatureNotEnforced = fmt.Errorf("authenticode verification not enforced (no verifier configured)")

// NoopAuthenticodeVerifier is the default: it never claims a file is signed.
type NoopAuthenticodeVerifier struct{}

func (NoopAuthenticodeVerifier) VerifySignature(string) error { return ErrSignatureNotEnforced }
