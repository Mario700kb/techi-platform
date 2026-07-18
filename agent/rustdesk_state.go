package main

import "strings"

func classifyRustDeskObservedState(
	installStatus, runtimeStatus, installPath string,
	exeVersion string,
	serviceExists bool,
	servicePath string,
	staleTmp bool,
	pendingReboot bool,
) (string, string) {
	exeExists := strings.TrimSpace(installPath) != ""
	versionValid := validRemoteSupportVersion(exeVersion)
	serviceRequired := remoteSupportVersionRequiresService(exeVersion)

	if exeExists && versionValid && !serviceRequired {
		if !serviceExists {
			return "installed", rustDeskStatusTrayOnly
		}
		return "installed", runtimeStatus
	}

	switch {
	case staleTmp && pendingReboot:
		return "damaged", "pending_reboot"
	case staleTmp:
		return "damaged", "partial_install"
	case !exeExists && serviceExists:
		return "damaged", "executable_missing"
	case exeExists && serviceRequired && !serviceExists:
		return "damaged", "service_missing"
	case exeExists && serviceRequired && serviceExists && !sameWindowsExecutable(servicePath, installPath):
		return "damaged", "stale_service"
	case !exeExists:
		return "not_installed", "not_installed"
	default:
		return installStatus, runtimeStatus
	}
}

func validRemoteSupportVersion(version string) bool {
	return remoteSupportVersionCore(version) != ""
}

func remoteSupportVersionRequiresService(version string) bool {
	return remoteSupportServiceRequiredVersions[remoteSupportVersionCore(version)]
}

// Service-required Remote Support versions must be added explicitly. Legacy
// 1.4.6 is tray-only capable and must never be damaged solely for missing SCM.
var remoteSupportServiceRequiredVersions = map[string]bool{}

func remoteSupportVersionCore(version string) string {
	version = strings.TrimSpace(version)
	if version == "" {
		return ""
	}

	parts := make([]string, 0, 3)
	var current strings.Builder
	flush := func() {
		if current.Len() == 0 || len(parts) >= 3 {
			current.Reset()
			return
		}
		parts = append(parts, current.String())
		current.Reset()
	}

	for _, r := range version {
		if r >= '0' && r <= '9' {
			current.WriteRune(r)
			continue
		}
		flush()
		if len(parts) >= 3 {
			break
		}
	}
	flush()

	if len(parts) < 3 {
		return ""
	}
	return strings.Join(parts[:3], ".")
}
