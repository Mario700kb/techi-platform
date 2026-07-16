//go:build windows

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"techi-platform/agent/internal/native"
)

const remoteSupportMSIDisplayName = "TECHI Remote Support"

type remoteSupportConfigSnapshot struct {
	path          string
	content       []byte
	mode          os.FileMode
	isIdentity    bool
	originalValid bool
}

type windowsRemoteSupportReinstallOps struct {
	cfg            *Config
	params         map[string]interface{}
	version        string
	packagePath    string
	configs        []remoteSupportConfigSnapshot
	configsRemoved bool
}

func newWindowsRemoteSupportReinstallOps(cfg *Config, params map[string]interface{}) *windowsRemoteSupportReinstallOps {
	return &windowsRemoteSupportReinstallOps{cfg: cfg, params: params}
}

func (o *windowsRemoteSupportReinstallOps) ResolvePackage(_ context.Context) (string, error) {
	o.version = stringParam(o.params, "remote_support_msi_version")
	filename := stringParam(o.params, "remote_support_msi_filename")
	sha := strings.ToLower(stringParam(o.params, "remote_support_msi_sha256"))
	if o.version == "" || filename == "" || sha == "" {
		return "", fmt.Errorf("active Remote Support MSI metadata is incomplete")
	}
	if filename != filepath.Base(filename) || !strings.EqualFold(filepath.Ext(filename), ".msi") {
		return "", fmt.Errorf("invalid Remote Support MSI filename %q", filename)
	}
	if len(sha) != 64 || strings.Trim(sha, "0123456789abcdef") != "" {
		return "", fmt.Errorf("invalid Remote Support MSI SHA256")
	}
	baseURL := strings.TrimRight(backendBaseURL(o.cfg.BackendURL), "/")
	if !strings.HasPrefix(baseURL, "https://") {
		return "", fmt.Errorf("Remote Support MSI download requires HTTPS backend")
	}

	dir := filepath.Join(remoteSupportRepairLockRoot, "recovery", "remote-support-msi", sha[:16])
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create MSI cache: %w", err)
	}
	o.packagePath = filepath.Join(dir, filename)
	if _, err := native.VerifyPayload(o.packagePath, sha); err == nil {
		return o.version, nil
	}
	_ = os.Remove(o.packagePath)
	if err := downloadVerifiedRecoveryFile(
		baseURL+"/api/v1/agent-packages/remote-support-msi/download", o.packagePath, sha, o.cfg,
	); err != nil {
		return "", fmt.Errorf("download active Remote Support MSI: %w", err)
	}
	return o.version, nil
}

func (o *windowsRemoteSupportReinstallOps) PreserveIdentity(_ context.Context) error {
	o.configs = nil
	seenIdentity := ""
	paths := append([]string(nil), rustDeskIdentityPaths()...)
	paths = append(paths, rustDeskOptionsPaths()...)
	identityPaths := make(map[string]bool)
	for _, path := range rustDeskIdentityPaths() {
		identityPaths[strings.ToLower(filepath.Clean(path))] = true
	}
	for _, path := range paths {
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return fmt.Errorf("inspect config %s: %w", path, err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("config %s is not a regular file", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read config %s: %w", path, err)
		}
		minimal, err := native.PrepareMinimalRemoteSupportConfig(path, data)
		if err != nil {
			return fmt.Errorf("validate config %s: %w", path, err)
		}
		isIdentity := identityPaths[strings.ToLower(filepath.Clean(path))]
		if isIdentity && minimal.Identity != "" {
			if seenIdentity != "" && seenIdentity != minimal.Identity {
				return fmt.Errorf("conflicting Remote Support IDs across config profiles")
			}
			seenIdentity = minimal.Identity
		}
		o.configs = append(o.configs, remoteSupportConfigSnapshot{
			path: path, content: minimal.Content, mode: info.Mode().Perm(),
			isIdentity: isIdentity, originalValid: minimal.OriginalValid,
		})
	}
	return nil
}

func (o *windowsRemoteSupportReinstallOps) StopRuntime(ctx context.Context) error {
	if err := stopRemoteSupportService(ctx); err != nil {
		return err
	}
	if err := terminateExactImageProcesses(rustdeskDefaultInstallPath, rustdeskLegacyExePath); err != nil {
		return fmt.Errorf("stop Remote Support processes: %w", err)
	}
	return nil
}

func (o *windowsRemoteSupportReinstallOps) UninstallRegisteredMSI(ctx context.Context) error {
	codes, err := registeredRemoteSupportProductCodes()
	if err != nil {
		return err
	}
	for _, code := range codes {
		if err := runRemoteSupportMSI(ctx, "/x", code, "uninstall", true); err != nil {
			return err
		}
	}
	return removeRemoteSupportServiceRegistration(ctx)
}

func (o *windowsRemoteSupportReinstallOps) RemoveApplicationFiles(_ context.Context) error {
	installDir := filepath.Dir(rustdeskDefaultInstallPath)
	if attrs, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(installDir)); err == nil {
		if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return fmt.Errorf("refusing to remove reparse-point install directory %s", installDir)
		}
		if err := os.RemoveAll(installDir); err != nil {
			return fmt.Errorf("remove install directory %s: %w", installDir, err)
		}
	} else if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) && !errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		return fmt.Errorf("inspect install directory %s: %w", installDir, err)
	}
	if _, err := os.Stat(installDir); !os.IsNotExist(err) {
		return fmt.Errorf("install directory still exists after removal: %s", installDir)
	}

	o.configsRemoved = true
	for _, config := range o.configs {
		removeTomlReadOnly(config.path)
		if _, err := os.Lstat(config.path); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return fmt.Errorf("inspect old config %s: %w", config.path, err)
		}
		if config.originalValid {
			if err := os.Remove(config.path); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("remove old config %s: %w", config.path, err)
			}
			continue
		}
		if _, err := native.QuarantineCorruptRemoteSupportConfig(config.path, time.Now()); err != nil {
			return fmt.Errorf("quarantine corrupt config %s: %w", config.path, err)
		}
	}
	return nil
}

func (o *windowsRemoteSupportReinstallOps) InstallMSI(ctx context.Context) error {
	if err := runRemoteSupportMSI(ctx, "/i", o.packagePath, "install", false); err != nil {
		return err
	}
	if err := stopRemoteSupportService(ctx); err != nil {
		return fmt.Errorf("stop installer-started service before identity restore: %w", err)
	}
	if err := terminateExactImageProcesses(rustdeskDefaultInstallPath, rustdeskLegacyExePath); err != nil {
		return fmt.Errorf("stop installer-started processes before identity restore: %w", err)
	}
	return nil
}

func (o *windowsRemoteSupportReinstallOps) RestoreIdentity(_ context.Context) error {
	if !o.configsRemoved {
		return nil
	}
	updates := make([]rustDeskFileUpdate, 0, len(o.configs))
	for _, config := range o.configs {
		if !config.isIdentity {
			continue
		}
		before, readErr := os.ReadFile(config.path)
		existed := readErr == nil
		if readErr != nil && !os.IsNotExist(readErr) {
			return fmt.Errorf("read replacement config %s: %w", config.path, readErr)
		}
		mode := config.mode
		if mode == 0 {
			mode = 0o600
		}
		updates = append(updates, rustDeskFileUpdate{
			path: config.path, before: before, after: config.content, mode: mode, existed: existed, protect: true,
		})
	}
	freshOptions := []byte(buildRustDeskTOML(o.cfg))
	preparedOptions, err := native.PrepareMinimalRemoteSupportConfig(rustDeskOptionsFile, freshOptions)
	if err != nil {
		return fmt.Errorf("generate fresh managed options config: %w", err)
	}
	if !preparedOptions.OriginalValid {
		return fmt.Errorf("generated managed options config failed TOML validation")
	}
	authoritative := authoritativeRustDeskOptionsPath()
	if authoritative == "" {
		return fmt.Errorf("authoritative LocalSystem options path unavailable")
	}
	seenOptions := map[string]bool{}
	for _, path := range append(rustDeskOptionsPaths(), authoritative) {
		key := strings.ToLower(filepath.Clean(path))
		if seenOptions[key] {
			continue
		}
		seenOptions[key] = true
		before, readErr := os.ReadFile(path)
		existed := readErr == nil
		if readErr != nil && !os.IsNotExist(readErr) {
			return fmt.Errorf("read replacement options %s: %w", path, readErr)
		}
		if !existed && !strings.EqualFold(filepath.Clean(path), filepath.Clean(authoritative)) {
			continue
		}
		mode := os.FileMode(0o644)
		if info, statErr := os.Stat(path); statErr == nil {
			mode = info.Mode().Perm()
		}
		updates = append(updates, rustDeskFileUpdate{
			path: path, before: before, after: freshOptions, mode: mode, existed: existed, protect: true,
		})
	}
	if err := applyRustDeskFileUpdates(updates); err != nil {
		return fmt.Errorf("restore minimal identity and fresh options config: %w", err)
	}
	return nil
}

func (o *windowsRemoteSupportReinstallOps) StartService(_ context.Context) error {
	if _, err := ensureRustDeskService(); err != nil {
		return err
	}
	return nil
}

func (o *windowsRemoteSupportReinstallOps) ValidateInstallation(_ context.Context) error {
	installDir := filepath.Dir(rustdeskDefaultInstallPath)
	if err := native.ValidateRequiredRuntimeLayout(installDir); err != nil {
		return err
	}
	expectedIdentity := map[string][]byte{}
	for _, config := range o.configs {
		if config.isIdentity {
			expectedIdentity[strings.ToLower(filepath.Clean(config.path))] = config.content
		}
	}
	for _, path := range rustDeskIdentityPaths() {
		content, err := os.ReadFile(path)
		want, expected := expectedIdentity[strings.ToLower(filepath.Clean(path))]
		if os.IsNotExist(err) && !expected {
			continue
		}
		if err != nil {
			return fmt.Errorf("read restored identity config %s: %w", path, err)
		}
		prepared, err := native.PrepareMinimalRemoteSupportConfig(path, content)
		if err != nil {
			return fmt.Errorf("validate restored identity config %s: %w", path, err)
		}
		if !prepared.OriginalValid {
			return fmt.Errorf("restored identity config is invalid TOML: %s: %v", path, prepared.OriginalError)
		}
		if expected && !bytes.Equal(content, want) {
			return fmt.Errorf("restored identity config changed after service start: %s", path)
		}
	}
	optionsPath := authoritativeRustDeskOptionsPath()
	options, err := os.ReadFile(optionsPath)
	if err != nil {
		return fmt.Errorf("read fresh options config %s: %w", optionsPath, err)
	}
	preparedOptions, err := native.PrepareMinimalRemoteSupportConfig(optionsPath, options)
	if err != nil {
		return fmt.Errorf("validate fresh options config %s: %w", optionsPath, err)
	}
	if !preparedOptions.OriginalValid {
		return fmt.Errorf("fresh options config is invalid TOML: %s: %v", optionsPath, preparedOptions.OriginalError)
	}
	if !bytes.Equal(options, []byte(buildRustDeskTOML(o.cfg))) {
		return fmt.Errorf("fresh managed options config changed after service start: %s", optionsPath)
	}
	for _, path := range rustDeskOptionsPaths() {
		if strings.EqualFold(filepath.Clean(path), filepath.Clean(optionsPath)) {
			continue
		}
		content, readErr := os.ReadFile(path)
		if os.IsNotExist(readErr) {
			continue
		}
		if readErr != nil {
			return fmt.Errorf("read options config %s: %w", path, readErr)
		}
		prepared, prepareErr := native.PrepareMinimalRemoteSupportConfig(path, content)
		if prepareErr != nil {
			return fmt.Errorf("validate options config %s: %w", path, prepareErr)
		}
		if !prepared.OriginalValid {
			return fmt.Errorf("options config is invalid TOML: %s: %v", path, prepared.OriginalError)
		}
	}
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to Service Control Manager: %w", err)
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(rustdeskServiceName)
	if err != nil {
		return fmt.Errorf("open service %q: %w", rustdeskServiceName, err)
	}
	defer service.Close()
	status, err := service.Query()
	if err != nil {
		return fmt.Errorf("query service %q: %w", rustdeskServiceName, err)
	}
	if status.State != svc.Running {
		return fmt.Errorf("service %q state=%s, expected Running", rustdeskServiceName, remoteSupportServiceStateName(status.State))
	}
	return nil
}

func (o *windowsRemoteSupportReinstallOps) StartUI(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	status, detail, err := native.LaunchRemoteSupportUI(rustdeskDefaultInstallPath)
	if err != nil {
		return "", err
	}
	switch status {
	case "healthy":
		return remoteSupportReinstalledStatus, nil
	case "repaired_ui_pending_login":
		return remoteSupportReinstalledPendingLogin, nil
	default:
		return "", fmt.Errorf("unexpected UI validation status %q: %s", status, detail)
	}
}

func stopRemoteSupportService(ctx context.Context) error {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to Service Control Manager: %w", err)
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(rustdeskServiceName)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open service %q: %w", rustdeskServiceName, err)
	}
	defer service.Close()
	status, err := service.Query()
	if err != nil {
		return fmt.Errorf("query service %q: %w", rustdeskServiceName, err)
	}
	if status.State == svc.Stopped {
		return nil
	}
	if _, err := service.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
		return fmt.Errorf("stop service %q: %w", rustdeskServiceName, err)
	}
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("service %q did not stop within 30s", rustdeskServiceName)
		case <-ticker.C:
			status, err = service.Query()
			if err != nil {
				return fmt.Errorf("query service %q while stopping: %w", rustdeskServiceName, err)
			}
			if status.State == svc.Stopped {
				return nil
			}
		}
	}
}

func removeRemoteSupportServiceRegistration(ctx context.Context) error {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to Service Control Manager: %w", err)
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(rustdeskServiceName)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open stale service %q: %w", rustdeskServiceName, err)
	}
	if err := service.Delete(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
		service.Close()
		return fmt.Errorf("delete stale service %q: %w", rustdeskServiceName, err)
	}
	if err := service.Close(); err != nil {
		return fmt.Errorf("close deleted service %q: %w", rustdeskServiceName, err)
	}
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		probe, openErr := manager.OpenService(rustdeskServiceName)
		if errors.Is(openErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return nil
		}
		if openErr != nil {
			return fmt.Errorf("verify service %q removal: %w", rustdeskServiceName, openErr)
		}
		probe.Close()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("service %q remained registered for 30s after deletion", rustdeskServiceName)
		case <-ticker.C:
		}
	}
}

func registeredRemoteSupportProductCodes() ([]string, error) {
	seen := map[string]bool{}
	var codes []string
	for _, access := range []uint32{registry.READ | registry.WOW64_64KEY, registry.READ | registry.WOW64_32KEY} {
		root, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`, access)
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("open MSI uninstall registry: %w", err)
		}
		names, err := root.ReadSubKeyNames(-1)
		root.Close()
		if err != nil {
			return nil, fmt.Errorf("enumerate MSI uninstall registry: %w", err)
		}
		for _, name := range names {
			if !isMSIProductCode(name) {
				continue
			}
			key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\`+name, access)
			if err != nil {
				continue
			}
			displayName, _, valueErr := key.GetStringValue("DisplayName")
			key.Close()
			if valueErr == nil && displayName == remoteSupportMSIDisplayName && !seen[strings.ToUpper(name)] {
				seen[strings.ToUpper(name)] = true
				codes = append(codes, name)
			}
		}
	}
	sort.Strings(codes)
	return codes, nil
}

func runRemoteSupportMSI(ctx context.Context, operation, target, label string, allowAbsent bool) error {
	logDir := filepath.Join(remoteSupportRepairLockRoot, "recovery", "remote-support-msi", "logs")
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return fmt.Errorf("create MSI log directory: %w", err)
	}
	logPath := filepath.Join(logDir, fmt.Sprintf("%s-%s.log", label, time.Now().UTC().Format("20060102T150405.000000000Z")))
	args := []string{operation, target, "/qn", "/norestart", "/L*v", logPath}
	cmd := exec.CommandContext(ctx, system32ExePath("msiexec.exe"), args...)
	output, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("msiexec %s cancelled: %w; log=%s", label, ctxErr, logPath)
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		code := exitErr.ExitCode()
		if code == 1641 || code == 3010 || (allowAbsent && code == 1605) {
			return nil
		}
		return fmt.Errorf("msiexec %s exit code %d; output=%q; log=%s", label, code, strings.TrimSpace(string(output)), logPath)
	}
	return fmt.Errorf("start msiexec %s: %w; log=%s", label, err, logPath)
}

func remoteSupportServiceStateName(state svc.State) string {
	switch state {
	case svc.Stopped:
		return "Stopped"
	case svc.StartPending:
		return "StartPending"
	case svc.StopPending:
		return "StopPending"
	case svc.Running:
		return "Running"
	case svc.ContinuePending:
		return "ContinuePending"
	case svc.PausePending:
		return "PausePending"
	case svc.Paused:
		return "Paused"
	default:
		return fmt.Sprintf("Unknown(%d)", state)
	}
}
