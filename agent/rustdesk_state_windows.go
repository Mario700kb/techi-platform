//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"
)

func classifyRustDeskWindowsState(installStatus, runtimeStatus, installPath, exeVersion string) (string, string) {
	serviceExists, servicePath := rustDeskServiceDefinition()
	root := filepath.Dir(rustdeskDefaultInstallPath)
	staleTmp := hasRustDeskTBDTemp(root)

	return classifyRustDeskObservedState(
		installStatus,
		runtimeStatus,
		installPath,
		exeVersion,
		serviceExists,
		servicePath,
		staleTmp,
		rustDeskPendingReboot(),
	)
}

func rustDeskServiceDefinition() (bool, string) {
	out, err := runWithTimeout(10*time.Second, scPath(), "qc", rustdeskServiceName)
	if err != nil {
		return false, ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(strings.ToUpper(line), "BINARY_PATH_NAME") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			return true, ""
		}
		return true, executableFromCommandLine(strings.TrimSpace(parts[1]))
	}
	return true, ""
}

func executableFromCommandLine(command string) string {
	command = strings.TrimSpace(command)
	if strings.HasPrefix(command, `"`) {
		if end := strings.Index(command[1:], `"`); end >= 0 {
			return command[1 : end+1]
		}
	}
	lower := strings.ToLower(command)
	if end := strings.Index(lower, ".exe"); end >= 0 {
		return strings.TrimSpace(command[:end+4])
	}
	return command
}

func sameWindowsExecutable(left, right string) bool {
	normalize := func(value string) string {
		return strings.ToLower(strings.TrimRight(filepath.Clean(strings.TrimSpace(value)), `\\/`))
	}
	return normalize(left) == normalize(right)
}

func hasRustDeskTBDTemp(root string) bool {
	entries, err := os.ReadDir(root)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		name := strings.ToLower(entry.Name())
		if strings.HasPrefix(name, "tbd") && strings.HasSuffix(name, ".tmp") {
			return true
		}
	}
	return false
}

func rustDeskPendingReboot() bool {
	key, err := registry.OpenKey(
		registry.LOCAL_MACHINE,
		`SYSTEM\CurrentControlSet\Control\Session Manager`,
		registry.QUERY_VALUE,
	)
	if err != nil {
		return false
	}
	defer key.Close()
	values, _, err := key.GetStringsValue("PendingFileRenameOperations")
	return err == nil && len(values) > 0
}
