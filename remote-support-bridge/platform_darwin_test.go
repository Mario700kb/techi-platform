//go:build darwin

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestMacPathsUsePrivatePerUserLocations(t *testing.T) {
	home := "/Users/operator"
	if got := macConfigRoot(home); got != "/Users/operator/Library/Preferences/com.carriez.TECHI-Remote-Support" {
		t.Fatalf("unexpected config root %q", got)
	}
	if got := macRuntimeRoot(home); got != "/Users/operator/Library/Application Support/TECHI Remote Support/ConnectBridge" {
		t.Fatalf("unexpected runtime root %q", got)
	}
}

func TestMacHandoffFilesAreMode0600(t *testing.T) {
	path := filepath.Join(t.TempDir(), "handoff")
	if err := os.WriteFile(path, []byte("not-a-secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := restrictFileMode(path); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("handoff mode = %o", info.Mode().Perm())
	}
}

func TestMacClientCommandContainsIDOnly(t *testing.T) {
	cmd, err := macClientLaunchCommand("/Applications/TECHI Remote Support.app/Contents/MacOS/TECHI Remote Support Client", "486641675")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/Applications/TECHI Remote Support.app/Contents/MacOS/TECHI Remote Support Client", "--connect", "486641675"}
	if !reflect.DeepEqual(cmd.Args, want) {
		t.Fatalf("command args = %#v", cmd.Args)
	}
	joined := strings.ToLower(strings.Join(cmd.Args, " "))
	if strings.Contains(joined, "password") || strings.Contains(joined, "credential") || strings.Contains(joined, "token") {
		t.Fatal("client command contains credential material")
	}
}

func TestMacStartupCleanupRestoresBackupAndRemovesEphemeralState(t *testing.T) {
	peers := t.TempDir()
	target := filepath.Join(peers, "486641675.toml")
	if err := os.WriteFile(target, []byte("temporary"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target+".techi-backup", []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target+".techi-handoff", []byte("v1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cleanupStaleHandoffs(peers); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "original" {
		t.Fatalf("restored config = %q, %v", data, err)
	}
	for _, suffix := range []string{".techi-backup", ".techi-handoff"} {
		if _, err := os.Stat(target + suffix); !os.IsNotExist(err) {
			t.Fatalf("stale file remains: %s", suffix)
		}
	}
}

func TestMacStartupCleanupRemovesInterruptedNewPeerConfig(t *testing.T) {
	peers := t.TempDir()
	target := filepath.Join(peers, "486641675.toml")
	if err := os.WriteFile(target, []byte("temporary"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target+".techi-handoff", []byte("v1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cleanupStaleHandoffs(peers); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("interrupted ephemeral peer config remains")
	}
}
