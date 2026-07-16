package main

import (
	"context"
	"fmt"
	"strings"
)

const (
	remoteSupportReinstalledStatus       = "reinstalled"
	remoteSupportReinstalledPendingLogin = "reinstalled_ui_pending_login"
)

type remoteSupportReinstallOps interface {
	ResolvePackage(context.Context) (string, error)
	PreserveIdentity(context.Context) error
	StopRuntime(context.Context) error
	UninstallRegisteredMSI(context.Context) error
	RemoveApplicationFiles(context.Context) error
	InstallMSI(context.Context) error
	RestoreIdentity(context.Context) error
	StartService(context.Context) error
	ValidateInstallation(context.Context) error
	StartUI(context.Context) (string, error)
}

type remoteSupportReinstallResult struct {
	status  string
	version string
}

func executeRemoteSupportReinstall(ctx context.Context, ops remoteSupportReinstallOps) (result remoteSupportReinstallResult, err error) {
	version, err := reinstallPhaseValue(ctx, "resolve_package", ops.ResolvePackage)
	if err != nil {
		return result, err
	}
	result.version = version

	if err = reinstallPhase(ctx, "preserve_identity", ops.PreserveIdentity); err != nil {
		return result, err
	}
	if err = reinstallPhase(ctx, "stop_runtime", ops.StopRuntime); err != nil {
		return result, err
	}
	if err = reinstallPhase(ctx, "uninstall_msi", ops.UninstallRegisteredMSI); err != nil {
		return result, err
	}

	identityMayNeedRestore := true
	defer func() {
		if err == nil || !identityMayNeedRestore {
			return
		}
		if restoreErr := ops.RestoreIdentity(context.Background()); restoreErr != nil {
			err = fmt.Errorf("%w; emergency identity restore: %v", err, restoreErr)
		}
	}()

	if err = reinstallPhase(ctx, "remove_application_files", ops.RemoveApplicationFiles); err != nil {
		return result, err
	}
	if err = reinstallPhase(ctx, "install_msi", ops.InstallMSI); err != nil {
		return result, err
	}
	if err = reinstallPhase(ctx, "restore_identity", ops.RestoreIdentity); err != nil {
		return result, err
	}
	identityMayNeedRestore = false
	if err = reinstallPhase(ctx, "start_service", ops.StartService); err != nil {
		return result, err
	}
	if err = reinstallPhase(ctx, "validate_installation", ops.ValidateInstallation); err != nil {
		return result, err
	}
	status, err := reinstallPhaseValue(ctx, "start_ui", ops.StartUI)
	if err != nil {
		return result, err
	}
	result.status = status
	return result, nil
}

func reinstallPhase(ctx context.Context, phase string, fn func(context.Context) error) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("reinstall phase=%s: %w", phase, err)
	}
	if err := fn(ctx); err != nil {
		return fmt.Errorf("reinstall phase=%s: %w", phase, err)
	}
	return nil
}

func reinstallPhaseValue(ctx context.Context, phase string, fn func(context.Context) (string, error)) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", fmt.Errorf("reinstall phase=%s: %w", phase, err)
	}
	value, err := fn(ctx)
	if err != nil {
		return "", fmt.Errorf("reinstall phase=%s: %w", phase, err)
	}
	return value, nil
}

func isMSIProductCode(value string) bool {
	if len(value) != 38 || value[0] != '{' || value[37] != '}' {
		return false
	}
	for index, char := range value[1:37] {
		switch index {
		case 8, 13, 18, 23:
			if char != '-' {
				return false
			}
		default:
			if !strings.ContainsRune("0123456789abcdefABCDEF", char) {
				return false
			}
		}
	}
	return true
}
