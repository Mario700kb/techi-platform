package main

import "testing"

const uninstallRegSample = "\r\n" +
	"HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{23170F69-40C1-2702-2301-000001000000}\r\n" +
	"    DisplayName    REG_SZ    7-Zip 23.01 (x64 edition)\r\n" +
	"    DisplayVersion    REG_SZ    23.01.00.0\r\n" +
	"    Publisher    REG_SZ    Igor Pavlov\r\n" +
	"    WindowsInstaller    REG_DWORD    0x1\r\n" +
	"\r\n" +
	"HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notepad++\r\n" +
	"    DisplayName    REG_SZ    Notepad++ (64-bit x64)\r\n" +
	"    UninstallString    REG_SZ    \"C:\\Program Files\\Notepad++\\uninstall.exe\"\r\n" +
	"    QuietUninstallString    REG_SZ    \"C:\\Program Files\\Notepad++\\uninstall.exe\" /S\r\n" +
	"\r\n" +
	"HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Google Chrome\r\n" +
	"    DisplayName    REG_SZ    Google Chrome\r\n" +
	"    UninstallString    REG_SZ    \"C:\\Program Files\\Google\\Chrome\\Application\\setup.exe\" --uninstall\r\n" +
	"\r\n" +
	"HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NotAGuidButMsi\r\n" +
	"    DisplayName    REG_SZ    Odd Installer\r\n" +
	"    WindowsInstaller    REG_DWORD    0x1\r\n"

func TestWindowsSoftwareCarriesHowItCanBeUninstalled(t *testing.T) {
	apps := parseWindowsUninstallRegistry(uninstallRegSample)
	if len(apps) != 4 {
		t.Fatalf("want 4 apps, got %d: %+v", len(apps), apps)
	}
	want := map[string]struct{ method, key string }{
		"7-Zip 23.01 (x64 edition)": {"msi", `HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\{23170F69-40C1-2702-2301-000001000000}`},
		"Notepad++ (64-bit x64)":    {"quiet", `HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\Notepad++`},
		"Google Chrome":             {"", ""},
		"Odd Installer":             {"", ""}, // an MSI flag without a product code is not trusted
	}
	for _, app := range apps {
		w, ok := want[app.Name]
		if !ok {
			t.Fatalf("unexpected app %q", app.Name)
		}
		if app.Uninstall != w.method || app.UninstallKey != w.key {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", app.Name, app.Uninstall, app.UninstallKey, w.method, w.key)
		}
	}
	if apps[0].Version != "23.01.00.0" || apps[0].Publisher != "Igor Pavlov" {
		t.Errorf("existing fields changed: %+v", apps[0])
	}
}

func TestIsProductCode(t *testing.T) {
	for s, want := range map[string]bool{
		"{23170F69-40C1-2702-2301-000001000000}": true,
		"{23170f69-40c1-2702-2301-000001000000}": true,
		"23170F69-40C1-2702-2301-000001000000":   false,
		"{23170F69-40C1-2702-2301-00000100000}":  false,
		"{23170F69_40C1-2702-2301-000001000000}": false,
		"{ZZ170F69-40C1-2702-2301-000001000000}": false,
		"Notepad++":                              false,
	} {
		if got := isProductCode(s); got != want {
			t.Errorf("isProductCode(%q) = %v, want %v", s, got, want)
		}
	}
}
