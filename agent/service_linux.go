//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const linuxUnitPath = "/etc/systemd/system/techi-agent.service"

// isServiceCommand keeps the same verbs as Windows so the CLI is uniform.
func isServiceCommand(command string) bool {
	switch command {
	case "install", "uninstall", "start", "stop", "status":
		return true
	default:
		return false
	}
}

// runWindowsService is false on Linux: systemd runs the agent in the foreground
// (Type=simple) and calls runAgent directly, so there is no service dispatcher
// to hook here.
func runWindowsService(_ string, _ string) (bool, error) {
	return false, nil
}

func runServiceCommand(command string, configPath string, enrollmentToken string) error {
	switch command {
	case "install":
		return linuxInstallService(configPath, enrollmentToken)
	case "uninstall":
		return linuxUninstallService()
	case "start":
		return runSystemctl("start", "techi-agent")
	case "stop":
		return runSystemctl("stop", "techi-agent")
	case "status":
		return runSystemctl("status", "techi-agent")
	default:
		return fmt.Errorf("unknown service command %q", command)
	}
}

func runSystemctl(args ...string) error {
	cmd := exec.Command("systemctl", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func linuxInstallService(configPath, enrollmentToken string) error {
	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}
	self, _ = filepath.EvalSymlinks(self)

	execStart := self + " --config " + configPath
	if enrollmentToken != "" {
		execStart += " --enrollment-token " + enrollmentToken
	}

	unit := strings.Join([]string{
		"[Unit]",
		"Description=TECHI Agent",
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		"ExecStart=" + execStart,
		"Restart=always",
		"RestartSec=10",
		"# Hardening (kept permissive enough for remote actions)",
		"NoNewPrivileges=false",
		"",
		"[Install]",
		"WantedBy=multi-user.target",
		"",
	}, "\n")

	if err := os.WriteFile(linuxUnitPath, []byte(unit), 0644); err != nil {
		return fmt.Errorf("write unit: %w", err)
	}
	if err := runSystemctl("daemon-reload"); err != nil {
		return err
	}
	if err := runSystemctl("enable", "techi-agent"); err != nil {
		return err
	}
	return runSystemctl("start", "techi-agent")
}

func linuxUninstallService() error {
	_ = runSystemctl("stop", "techi-agent")
	_ = runSystemctl("disable", "techi-agent")
	if err := os.Remove(linuxUnitPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove unit: %w", err)
	}
	return runSystemctl("daemon-reload")
}
