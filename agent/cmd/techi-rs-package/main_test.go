package main

import (
	"os"
	"path/filepath"
	"testing"

	"techi-platform/agent/internal/native"
)

func writeSource(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for rel, body := range map[string]string{
		"TECHI Remote Support.exe": "MZ fake",
		"librustdesk.dll":          "dll",
		"data/app.so":              "so",
	} {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestPackager_ProducesValidSidecars(t *testing.T) {
	src := writeSource(t)
	out := t.TempDir()
	if err := run(src, "1.4.6", out, "TECHI Remote Support", "abc123"); err != nil {
		t.Fatalf("run: %v", err)
	}
	base := "TECHI-Remote-Support-1.4.6-windows-amd64"
	for _, suffix := range []string{".zip", ".zip.sha256", ".manifest.json", ".identity.json"} {
		if _, err := os.Stat(filepath.Join(out, base+suffix)); err != nil {
			t.Errorf("missing sidecar %s: %v", suffix, err)
		}
	}
	// The manifest must load + validate, and its bundle_sha256 must match the zip.
	m, err := native.LoadBundleManifest(filepath.Join(out, base+".manifest.json"))
	if err != nil {
		t.Fatalf("manifest invalid: %v", err)
	}
	zb, err := os.ReadFile(filepath.Join(out, base+".zip"))
	if err != nil {
		t.Fatal(err)
	}
	if native.HashBytesSHA256(zb) != m.BundleSHA256 {
		t.Fatalf("bundle_sha256 does not match the zip bytes")
	}
	// The freshly built zip must pass the executor's extraction+validation gate.
	dir := t.TempDir()
	if err := native.ExtractZipBytesSafe(zb, dir); err != nil {
		t.Fatal(err)
	}
	if err := native.VerifyExtractedBundle(dir, m); err != nil {
		t.Fatalf("canonical bundle must verify: %v", err)
	}
}

func TestPackager_Deterministic(t *testing.T) {
	src := writeSource(t)
	out1, out2 := t.TempDir(), t.TempDir()
	if err := run(src, "1.4.6", out1, "TECHI Remote Support", "c1"); err != nil {
		t.Fatal(err)
	}
	if err := run(src, "1.4.6", out2, "TECHI Remote Support", "c2"); err != nil {
		t.Fatal(err)
	}
	base := "TECHI-Remote-Support-1.4.6-windows-amd64.zip"
	a, _ := os.ReadFile(filepath.Join(out1, base))
	b, _ := os.ReadFile(filepath.Join(out2, base))
	if native.HashBytesSHA256(a) != native.HashBytesSHA256(b) {
		t.Fatalf("zip bytes must be deterministic regardless of commit")
	}
}
