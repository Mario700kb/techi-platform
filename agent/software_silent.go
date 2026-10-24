package main

import "strings"

// How an app that registered no quiet uninstall command can still be removed
// with nobody at the PC (2.1.43): installers whose silent switch is part of
// the installer itself, and a few common apps whose vendor documents one.
// Anything else stays "no silent uninstall": an interactive uninstaller run
// as SYSTEM waits, unseen, for clicks that never come.
//
//   - Inno Setup (it marks its uninstall entries "Inno Setup: …"):
//     unins000.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
//   - AnyDesk: AnyDesk.exe --silent --remove (AnyDesk's CLI documentation)
//   - Firefox: uninstall\helper.exe /S (Mozilla's NSIS helper)
//   - Google Chrome (per-machine): its setup.exe --uninstall … --force-uninstall,
//     which ends with exit code 19 when Chrome was removed
//
// NSIS in general (uninstall.exe /S) is left out: nothing in the registry
// tells an NSIS uninstaller from another, and TeamViewer's /S still asks
// whether to remove its settings.

type silentUninstall struct {
	command string
	okCodes []int // exit codes besides 0 and 3010 that mean "removed"
}

func silentUninstallFor(name, quiet, uninstallString string, inno bool) silentUninstall {
	if q := strings.TrimSpace(quiet); q != "" {
		return silentUninstall{command: q}
	}
	cmd := strings.TrimSpace(uninstallString)
	exe := commandExecutable(cmd)
	if exe == "" {
		return silentUninstall{}
	}
	base := strings.ToLower(exe[strings.LastIndexAny(exe, `\/`)+1:])
	lowerName := strings.ToLower(strings.TrimSpace(name))
	quoted := `"` + exe + `"`
	switch {
	case inno && isInnoUninstaller(base):
		return silentUninstall{command: quoted + " /VERYSILENT /SUPPRESSMSGBOXES /NORESTART"}
	case strings.HasPrefix(lowerName, "anydesk") && base == "anydesk.exe":
		return silentUninstall{command: quoted + " --silent --remove"}
	case strings.HasPrefix(lowerName, "mozilla firefox") && base == "helper.exe":
		return silentUninstall{command: quoted + " /S"}
	case lowerName == "google chrome" && base == "setup.exe" && strings.Contains(cmd, "--uninstall") && strings.Contains(cmd, "--system-level"):
		if !strings.Contains(cmd, "--force-uninstall") {
			cmd += " --force-uninstall"
		}
		return silentUninstall{command: cmd, okCodes: []int{19}}
	}
	return silentUninstall{}
}

// commandExecutable is the program a registered command line runs: the
// quoted first part, or everything up to ".exe" for an unquoted path with
// spaces, or the first word.
func commandExecutable(command string) string {
	command = strings.TrimSpace(command)
	if strings.HasPrefix(command, `"`) {
		if end := strings.Index(command[1:], `"`); end >= 0 {
			return command[1 : end+1]
		}
		return ""
	}
	if i := strings.Index(strings.ToLower(command), ".exe"); i >= 0 {
		return command[:i+4]
	}
	if fields := strings.Fields(command); len(fields) > 0 {
		return fields[0]
	}
	return ""
}

// isInnoUninstaller matches the names Inno Setup gives its uninstaller:
// unins000.exe, unins001.exe, … (not "uninstall.exe").
func isInnoUninstaller(base string) bool {
	if len(base) != len("unins000.exe") || !strings.HasPrefix(base, "unins") || !strings.HasSuffix(base, ".exe") {
		return false
	}
	for _, c := range base[5:8] {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
