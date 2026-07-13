package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicWriteFileReplacesContentAndLeavesNoTemporaryFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte("identity-before"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := atomicWriteFile(path, []byte("identity-after"), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "identity-after" {
		t.Fatalf("content = %q", got)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "config.toml" {
		t.Fatalf("unexpected files after atomic write: %v", entries)
	}
}
