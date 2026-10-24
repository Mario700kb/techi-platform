package main

import (
	"slices"
	"testing"
)

func TestSilentUninstallKnowsInnoAndAFewDocumentedApps(t *testing.T) {
	cases := []struct {
		name, quiet, uninstall string
		inno                   bool
		want                   string
		okCodes                []int
	}{
		{"Notepad++", `"C:\N\uninstall.exe" /S`, `"C:\N\uninstall.exe"`, false, `"C:\N\uninstall.exe" /S`, nil},
		{"WinSCP 6.3", "", `"C:\Program Files (x86)\WinSCP\unins000.exe"`, true,
			`"C:\Program Files (x86)\WinSCP\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART`, nil},
		{"AnyDesk", "", `"C:\Program Files (x86)\AnyDesk\AnyDesk.exe" --uninstall`, false,
			`"C:\Program Files (x86)\AnyDesk\AnyDesk.exe" --silent --remove`, nil},
		{"Mozilla Firefox (x64 en-US)", "", `"C:\Program Files\Mozilla Firefox\uninstall\helper.exe"`, false,
			`"C:\Program Files\Mozilla Firefox\uninstall\helper.exe" /S`, nil},
		{"Google Chrome", "", `"C:\Program Files\Google\Chrome\Application\130.0\Installer\setup.exe" --uninstall --channel=stable --system-level --verbose-logging`, false,
			`"C:\Program Files\Google\Chrome\Application\130.0\Installer\setup.exe" --uninstall --channel=stable --system-level --verbose-logging --force-uninstall`, []int{19}},
		// Per-user Chrome (no --system-level) lives in someone's profile: not offered.
		{"Google Chrome", "", `"C:\Users\x\AppData\Local\Google\Chrome\Application\setup.exe" --uninstall`, false, "", nil},
		// unins000.exe without the Inno marker, or Inno's marker on another exe: not trusted.
		{"Some App", "", `"C:\App\unins000.exe"`, false, "", nil},
		{"Some App", "", `"C:\App\uninstall.exe"`, true, "", nil},
		// NSIS and printer drivers stay out.
		{"TeamViewer", "", `"C:\Program Files\TeamViewer\uninstall.exe"`, false, "", nil},
		{"EPSON Advanced Printer Driver 4", "", `C:\Program Files\EPSON\setup.exe /uninstall`, false, "", nil},
		{"Nothing", "", "", false, "", nil},
	}
	for _, c := range cases {
		got := silentUninstallFor(c.name, c.quiet, c.uninstall, c.inno)
		if got.command != c.want || !slices.Equal(got.okCodes, c.okCodes) {
			t.Errorf("%s: got (%q, %v), want (%q, %v)", c.name, got.command, got.okCodes, c.want, c.okCodes)
		}
	}
}

func TestTheInventoryOffersInnoAndKnownAppsAsQuiet(t *testing.T) {
	raw := "HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WinSCP3_is1\r\n" +
		"    Inno Setup: Setup Version    REG_SZ    6.2.2\r\n" +
		"    Inno Setup: App Path    REG_SZ    C:\\Program Files (x86)\\WinSCP\\\r\n" +
		"    DisplayName    REG_SZ    WinSCP 6.3\r\n" +
		"    UninstallString    REG_SZ    \"C:\\Program Files (x86)\\WinSCP\\unins000.exe\"\r\n" +
		"\r\n" +
		"HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnyDesk\r\n" +
		"    DisplayName    REG_SZ    AnyDesk\r\n" +
		"    UninstallString    REG_SZ    \"C:\\Program Files (x86)\\AnyDesk\\AnyDesk.exe\" --uninstall\r\n" +
		"\r\n" +
		"HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EPSON APD4\r\n" +
		"    DisplayName    REG_SZ    EPSON Advanced Printer Driver 4\r\n" +
		"    UninstallString    REG_SZ    C:\\Program Files\\EPSON\\setup.exe /uninstall\r\n"
	apps := parseWindowsUninstallRegistry(raw)
	got := map[string]string{}
	for _, a := range apps {
		got[a.Name] = a.Uninstall
	}
	want := map[string]string{"WinSCP 6.3": "quiet", "AnyDesk": "quiet", "EPSON Advanced Printer Driver 4": ""}
	for name, method := range want {
		if got[name] != method {
			t.Errorf("%s: got %q, want %q (all: %v)", name, got[name], method, got)
		}
	}
}
