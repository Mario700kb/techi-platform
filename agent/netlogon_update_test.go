package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTempExe(t *testing.T, name string, content []byte) (string, string) {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, content, 0o644); err != nil {
		t.Fatalf("write temp exe: %v", err)
	}
	sum := sha256.Sum256(content)
	return p, hex.EncodeToString(sum[:])
}

func TestVerifyStagedAgentBinary_MissingSource(t *testing.T) {
	code, err := verifyStagedAgentBinary("", "")
	if code != netlogonUpdateBadArgs || err == nil {
		t.Fatalf("empty source: got code=%d err=%v want %d", code, err, netlogonUpdateBadArgs)
	}
	code, err = verifyStagedAgentBinary(filepath.Join(t.TempDir(), "nope.exe"), "")
	if code != netlogonUpdateIdentityMismatch || err == nil {
		t.Fatalf("missing file: got code=%d err=%v want %d", code, err, netlogonUpdateIdentityMismatch)
	}
}

func TestVerifyStagedAgentBinary_EmptyFile(t *testing.T) {
	p, _ := writeTempExe(t, "empty.exe", []byte{})
	code, err := verifyStagedAgentBinary(p, "")
	if code != netlogonUpdateIdentityMismatch || err == nil {
		t.Fatalf("empty file: got code=%d err=%v want %d", code, err, netlogonUpdateIdentityMismatch)
	}
}

func TestVerifyStagedAgentBinary_Directory(t *testing.T) {
	code, err := verifyStagedAgentBinary(t.TempDir(), "")
	if code != netlogonUpdateIdentityMismatch || err == nil {
		t.Fatalf("directory: got code=%d err=%v want %d", code, err, netlogonUpdateIdentityMismatch)
	}
}

func TestVerifyStagedAgentBinary_SHAMatch(t *testing.T) {
	p, sha := writeTempExe(t, "agent.exe", []byte("MZ fake agent payload"))
	code, err := verifyStagedAgentBinary(p, sha)
	if code != netlogonUpdateOK || err != nil {
		t.Fatalf("matching sha: got code=%d err=%v want %d", code, err, netlogonUpdateOK)
	}
	// Case-insensitive + whitespace tolerant.
	code, err = verifyStagedAgentBinary(p, "  "+sha[:32]+sha[32:]+"  ")
	if code != netlogonUpdateOK || err != nil {
		t.Fatalf("trimmed sha: got code=%d err=%v", code, err)
	}
}

func TestVerifyStagedAgentBinary_SHAMismatch(t *testing.T) {
	p, _ := writeTempExe(t, "agent.exe", []byte("MZ fake agent payload"))
	code, err := verifyStagedAgentBinary(p, "deadbeef"+strings.Repeat("00", 28))
	if code != netlogonUpdateIdentityMismatch || err == nil {
		t.Fatalf("sha mismatch: got code=%d err=%v want %d", code, err, netlogonUpdateIdentityMismatch)
	}
}

func TestVerifyStagedAgentBinary_NoSHASkipsHash(t *testing.T) {
	// No expected SHA: identity gate passes on any non-empty regular file.
	p, _ := writeTempExe(t, "agent.exe", []byte("anything"))
	code, err := verifyStagedAgentBinary(p, "")
	if code != netlogonUpdateOK || err != nil {
		t.Fatalf("no sha: got code=%d err=%v want %d", code, err, netlogonUpdateOK)
	}
}

func TestNetlogonUpdateExitCodesAreStable(t *testing.T) {
	// The NETLOGON deploy script maps these exact numbers to final_result
	// values; reordering them silently breaks the domain rollout contract.
	if netlogonUpdateOK != 0 || netlogonUpdateError != 1 || netlogonUpdateBadArgs != 2 ||
		netlogonUpdateIdentityMismatch != 3 || netlogonUpdateBusy != 4 {
		t.Fatal("netlogon self-update exit codes changed; update the deploy script contract too")
	}
}
