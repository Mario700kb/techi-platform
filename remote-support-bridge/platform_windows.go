//go:build windows

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32        = windows.NewLazySystemDLL("user32.dll")
	messageBoxW   = user32.NewProc("MessageBoxW")
	kernel32      = windows.NewLazySystemDLL("kernel32.dll")
	createMutexW  = kernel32.NewProc("CreateMutexW")
	releaseMutex  = kernel32.NewProc("ReleaseMutex")
	waitForObject = kernel32.NewProc("WaitForSingleObject")
)

func platformProtocolURI(args []string) (string, error) {
	if len(args) != 1 {
		return "", errors.New("invalid_protocol_uri")
	}
	return args[0], nil
}

func cleanupPlatformHandoffs() error {
	return nil
}

func securePlatformHandoff(ctx context.Context, remoteID string, password []byte) error {
	if !remoteIDPattern.MatchString(remoteID) {
		return errors.New("invalid_remote_id")
	}
	if len(password) == 0 || len(password) > 512 {
		return errors.New("invalid_credential")
	}
	release, err := acquireBridgeMutex()
	if err != nil {
		return err
	}
	defer release()

	bridgePath, err := os.Executable()
	if err != nil {
		return errors.New("bridge_path_unavailable")
	}
	clientPath := filepath.Join(filepath.Dir(bridgePath), "TECHI Remote Support.exe")
	if info, statErr := os.Stat(clientPath); statErr != nil || info.IsDir() {
		return errors.New("client_missing")
	}
	return launchClientWithCredential(ctx, clientPath, remoteID, password)
}

// launchClientWithCredential mirrors the macOS secure handoff: launch the client
// with `--connect <id> --techi-connect-stdin`, deliver the one-time credential on
// stdin (never on the command line or in a URI), and wait for the client's
// TECHI_CONNECT_ACCEPTED_V1 acknowledgement. The client's baked-in secure-connect
// path (techi-remote-support: techi_secure_connect_from_stdin) forwards it over
// IPC to the running instance, which opens the session directly.
func launchClientWithCredential(ctx context.Context, clientPath, remoteID string, password []byte) error {
	cmd := exec.Command(clientPath, "--connect", remoteID, "--techi-connect-stdin")
	cmd.Dir = filepath.Dir(clientPath)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return errors.New("client_stdin_failed")
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return errors.New("client_ack_failed")
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return errors.New("client_launch_failed")
	}
	if _, err := stdin.Write(password); err != nil {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		return errors.New("client_stdin_failed")
	}
	if err := stdin.Close(); err != nil {
		_ = cmd.Process.Kill()
		return errors.New("client_stdin_failed")
	}

	ack := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(io.LimitReader(stdout, 65)).ReadString('\n')
		ack <- strings.TrimSpace(line)
	}()
	timer := time.NewTimer(8 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		return errors.New("handoff_cancelled")
	case <-timer.C:
		_ = cmd.Process.Kill()
		return errors.New("client_ack_timeout")
	case value := <-ack:
		if value != "TECHI_CONNECT_ACCEPTED_V1" {
			_ = cmd.Process.Kill()
			return errors.New("client_ack_failed")
		}
		return nil
	}
}

func acquireBridgeMutex() (func(), error) {
	name, _ := windows.UTF16PtrFromString(`Local\TECHIRemoteSupportConnectBridge`)
	handle, _, createErr := createMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return nil, createErr
	}
	wait, _, _ := waitForObject.Call(handle, 10_000)
	if wait != windows.WAIT_OBJECT_0 && wait != windows.WAIT_ABANDONED {
		windows.CloseHandle(windows.Handle(handle))
		return nil, errors.New("bridge_busy")
	}
	return func() {
		releaseMutex.Call(handle)
		windows.CloseHandle(windows.Handle(handle))
	}, nil
}

func showBridgeError(code string) {
	message := "TECHI Remote Support could not start the connection. Please try Connect again."
	if code == "token_expired_or_used" {
		message = "This Connect request expired or was already used. Return to TECHI Platform and click Connect again."
	}
	text, _ := windows.UTF16PtrFromString(message)
	title, _ := windows.UTF16PtrFromString(fmt.Sprintf("TECHI Remote Support Bridge %s", version))
	messageBoxW.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
}
