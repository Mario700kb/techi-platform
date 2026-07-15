//go:build darwin

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

const (
	macConfigDirectory = "com.carriez.TECHI-Remote-Support"
	macClientName      = "TECHI Remote Support Client"
)

func platformProtocolURI(args []string) (string, error) {
	if len(args) != 1 || args[0] != "--stdin-uri" {
		return "", errors.New("invalid_protocol_uri")
	}
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 1025))
	if err != nil || len(data) == 0 || len(data) > 1024 {
		zero(data)
		return "", errors.New("invalid_protocol_uri")
	}
	raw := strings.TrimSpace(string(data))
	zero(data)
	return raw, nil
}

func macConfigRoot(home string) string {
	return filepath.Join(home, "Library", "Preferences", macConfigDirectory)
}

func macRuntimeRoot(home string) string {
	return filepath.Join(home, "Library", "Application Support", "TECHI Remote Support", "ConnectBridge")
}

func cleanupPlatformHandoffs() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return errors.New("home_unavailable")
	}
	release, err := acquireMacBridgeLock(macRuntimeRoot(home))
	if err != nil {
		return err
	}
	defer release()
	return cleanupStaleHandoffs(filepath.Join(macConfigRoot(home), "peers"))
}

func cleanupStaleHandoffs(peersRoot string) error {
	targets := map[string]struct{}{}
	for _, suffix := range []string{".techi-handoff", ".techi-backup"} {
		matches, err := filepath.Glob(filepath.Join(peersRoot, "*"+suffix))
		if err != nil {
			return errors.New("stale_handoff_scan_failed")
		}
		for _, match := range matches {
			targets[strings.TrimSuffix(match, suffix)] = struct{}{}
		}
	}
	for target := range targets {
		if err := recoverStaleHandoff(target); err != nil {
			return errors.New("stale_handoff_recovery_failed")
		}
	}
	return nil
}

func securePlatformHandoff(ctx context.Context, remoteID string, password []byte) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return errors.New("home_unavailable")
	}
	release, err := acquireMacBridgeLock(macRuntimeRoot(home))
	if err != nil {
		return err
	}
	defer release()

	configRoot := macConfigRoot(home)
	if err := cleanupStaleHandoffs(filepath.Join(configRoot, "peers")); err != nil {
		return errors.New("stale_handoff_recovery_failed")
	}
	target, err := peerConfigPath(configRoot, remoteID)
	if err != nil {
		return err
	}
	clientPath, err := macClientPath()
	if err != nil {
		return err
	}
	return performPeerConfigHandoff(ctx, target, password, restrictFileMode, func(_ string) error {
		cmd, err := macClientLaunchCommand(clientPath, remoteID)
		if err != nil {
			return err
		}
		return cmd.Start()
	})
}

func acquireMacBridgeLock(runtimeRoot string) (func(), error) {
	if err := os.MkdirAll(runtimeRoot, 0o700); err != nil {
		return nil, errors.New("runtime_directory_failed")
	}
	if err := os.Chmod(runtimeRoot, 0o700); err != nil {
		return nil, errors.New("runtime_directory_permissions_failed")
	}
	lock, err := os.OpenFile(filepath.Join(runtimeRoot, "bridge.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, errors.New("bridge_lock_failed")
	}
	if err := os.Chmod(lock.Name(), 0o600); err != nil {
		_ = lock.Close()
		return nil, errors.New("bridge_lock_permissions_failed")
	}
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = lock.Close()
		return nil, errors.New("bridge_busy")
	}
	return func() {
		_ = unix.Flock(int(lock.Fd()), unix.LOCK_UN)
		_ = lock.Close()
	}, nil
}

func restrictFileMode(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("handoff_not_regular_file")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return err
	}
	info, err = os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		return errors.New("handoff_permissions_failed")
	}
	return nil
}

func macClientPath() (string, error) {
	helper, err := os.Executable()
	if err != nil {
		return "", errors.New("bridge_path_unavailable")
	}
	contents := filepath.Dir(filepath.Dir(helper))
	client := filepath.Join(contents, "MacOS", macClientName)
	if info, err := os.Stat(client); err != nil || !info.Mode().IsRegular() {
		return "", errors.New("client_missing")
	}
	return client, nil
}

func macClientLaunchCommand(clientPath, remoteID string) (*exec.Cmd, error) {
	if !remoteIDPattern.MatchString(remoteID) {
		return nil, errors.New("invalid_remote_id")
	}
	cmd := exec.Command(clientPath, "--connect", remoteID)
	cmd.Dir = filepath.Dir(clientPath)
	return cmd, nil
}

func showBridgeError(_ string) {}
