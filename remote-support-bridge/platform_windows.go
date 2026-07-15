//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
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
	release, err := acquireBridgeMutex()
	if err != nil {
		return err
	}
	defer release()

	appData := os.Getenv("APPDATA")
	if appData == "" {
		return errors.New("appdata_unavailable")
	}
	target, err := peerConfigPath(filepath.Join(appData, "TECHI Remote Support", "config"), remoteID)
	if err != nil {
		return err
	}
	return performPeerConfigHandoff(ctx, target, password, restrictFileACL, func(_ string) error {
		bridgePath, err := os.Executable()
		if err != nil {
			return err
		}
		clientPath := filepath.Join(filepath.Dir(bridgePath), "TECHI Remote Support.exe")
		if _, err := os.Stat(clientPath); err != nil {
			return err
		}
		cmd := exec.Command(clientPath, "--connect", remoteID)
		cmd.Dir = filepath.Dir(clientPath)
		return cmd.Start()
	})
}

func restrictFileACL(path string) error {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return err
	}
	sid := user.User.Sid.String()
	cmd := exec.Command(
		filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe"),
		path,
		"/inheritance:r",
		"/grant:r",
		"*"+sid+":(F)",
		"*S-1-5-18:(F)",
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Run()
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
