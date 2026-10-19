package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTheIdentityFileIsMadeWritableAgain(t *testing.T) {
	dirs := []string{t.TempDir(), t.TempDir(), t.TempDir()}
	identity := filepath.Join(dirs[0], remoteSupportIdentityFile)
	options := filepath.Join(dirs[1], remoteSupportOptionsFile)
	writable := filepath.Join(dirs[2], remoteSupportIdentityFile)
	for _, p := range []string{identity, options, writable} {
		if err := os.WriteFile(p, []byte("id = '499953666'\n"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(identity, 0444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(options, 0444); err != nil {
		t.Fatal(err)
	}

	healed := healRemoteSupportIdentity(dirs)

	if len(healed) != 1 || healed[0] != identity {
		t.Fatalf("healed %v, want only %s", healed, identity)
	}
	if isReadOnlyFile(identity) {
		t.Fatal("the identity file must be writable: the client stores its key pair and ID there")
	}
	if !isReadOnlyFile(options) {
		t.Fatal("only identity files are touched")
	}
	if again := healRemoteSupportIdentity(dirs); len(again) != 0 {
		t.Fatalf("second pass healed %v", again)
	}
}

func TestTheManagedOptionsGoToTheOptionsFile(t *testing.T) {
	if remoteSupportOptionsFile != "TECHI Remote Support2.toml" || remoteSupportIdentityFile != "TECHI Remote Support.toml" {
		t.Fatal("Config2 ([options]) is the \"2\" file; Config (id, key_pair) is the suffix-less one")
	}
}
