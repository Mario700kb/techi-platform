package main

import (
	"os"
	"strings"
	"testing"
)

func testRustDeskIdentity(id, password string) []byte {
	return []byte("id = '" + id + "'\n" +
		"enc_id = 'encrypted-" + id + "'\n" +
		"password = '" + password + "'\n" +
		"salt = 'verified-salt'\n" +
		"key_pair = ['public', 'private']\n" +
		"key_confirmed = true\nserial = 0\n")
}

func TestCanonicalIdentityPrefersValidActiveUserOverLocalService(t *testing.T) {
	user := testRustDeskIdentity("123456789", "encrypted-password")
	service := testRustDeskIdentity("987654321", "random-plain-password")
	canonical, err := selectCanonicalRustDeskIdentity([]rustDeskIdentityCandidate{
		{path: `C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\TECHI Remote Support\config\TECHI Remote Support.toml`, content: service, valid: true},
		{path: `C:\Users\USER\AppData\Roaming\TECHI Remote Support\config\TECHI Remote Support.toml`, profileRoot: `C:\Users\USER\AppData\Roaming\TECHI Remote Support`, content: user, valid: true, userProfile: true, activeUser: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if canonical.id != "123456789" || !rustDeskIdentityMatches(user, canonical) {
		t.Fatalf("canonical identity changed: id=%q", canonical.id)
	}
	if rustDeskIdentityMatches(service, canonical) {
		t.Fatal("random LocalService password/identity must be replaced")
	}
	replacement := canonical.content
	if !rustDeskIdentityMatches(replacement, canonical) || strings.Contains(string(replacement), "random-plain-password") {
		t.Fatal("LocalService replacement did not use the verified encrypted user credential")
	}
}

func TestCanonicalIdentityPrefersConfigFileOverRootMirror(t *testing.T) {
	canonical, err := selectCanonicalRustDeskIdentity([]rustDeskIdentityCandidate{
		{path: `C:\Users\USER\AppData\Roaming\TECHI Remote Support\TECHI Remote Support.toml`, profileRoot: `C:\Users\USER\AppData\Roaming\TECHI Remote Support`, content: testRustDeskIdentity("987654321", "stale-password"), valid: true, userProfile: true, activeUser: true},
		{path: `C:\Users\USER\AppData\Roaming\TECHI Remote Support\config\TECHI Remote Support.toml`, profileRoot: `C:\Users\USER\AppData\Roaming\TECHI Remote Support`, content: testRustDeskIdentity("123456789", "encrypted-password"), valid: true, userProfile: true, activeUser: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if canonical.id != "123456789" {
		t.Fatalf("config identity was not preferred: %s", canonical.id)
	}
}

func TestCanonicalIdentityAcceptsVerifiedEncryptedID(t *testing.T) {
	content := []byte("enc_id = 'encrypted-device-id'\npassword = 'encrypted-password'\nsalt = 'verified-salt'\nserial = 0\n")
	canonical, err := selectCanonicalRustDeskIdentity([]rustDeskIdentityCandidate{{
		path: `C:\Users\USER\config\TECHI Remote Support.toml`, profileRoot: `C:\Users\USER`,
		content: content, valid: true, userProfile: true, activeUser: true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if canonical.id != "" || canonical.encID != "encrypted-device-id" {
		t.Fatalf("encrypted identity changed: id=%q enc_id=%q", canonical.id, canonical.encID)
	}
	materialized := append([]byte("id = '123456789'\n"), content...)
	if !rustDeskIdentityMatches(materialized, canonical) {
		t.Fatal("derived plaintext ID should not invalidate an enc_id-only canonical identity")
	}
}

func TestRequiredIdentityProfilesIncludeUserAndLocalService(t *testing.T) {
	profiles := []rustDeskSyncProfile{
		{root: `C:\Users\USER\AppData\Roaming\TECHI Remote Support`, role: rustDeskProfileUser, active: true},
		{root: `C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\TECHI Remote Support`, role: rustDeskProfileLocalService},
		{root: `C:\Windows\System32\config\systemprofile\AppData\Roaming\TECHI Remote Support`, role: rustDeskProfileSystem},
	}
	roots := requiredRustDeskSyncRoots(profiles, profiles[0].root, false)
	joined := strings.Join(roots, "|")
	if !strings.Contains(joined, `C:\Users\USER`) || !strings.Contains(joined, `ServiceProfiles\LocalService`) {
		t.Fatalf("repair_config targets missing: %v", roots)
	}
	if strings.Contains(joined, `systemprofile`) {
		t.Fatalf("unused system profile included: %v", roots)
	}
}

func TestRequiredIdentityProfilesIncludeSystemOnlyWhenUsed(t *testing.T) {
	profiles := []rustDeskSyncProfile{
		{root: `C:\Users\USER\RS`, role: rustDeskProfileUser, active: true},
		{root: `C:\Windows\ServiceProfiles\LocalService\RS`, role: rustDeskProfileLocalService},
		{root: `C:\Windows\System32\config\systemprofile\RS`, role: rustDeskProfileSystem},
	}
	roots := requiredRustDeskSyncRoots(profiles, profiles[0].root, true)
	if !strings.Contains(strings.Join(roots, "|"), `systemprofile`) {
		t.Fatalf("used system profile missing: %v", roots)
	}
}

func TestReinstallPreservesCanonicalID(t *testing.T) {
	content := testRustDeskIdentity("123456789", "encrypted-password")
	canonical, err := selectCanonicalRustDeskIdentity([]rustDeskIdentityCandidate{{
		path: `C:\Users\USER\config\TECHI Remote Support.toml`, profileRoot: `C:\Users\USER`,
		content: content, valid: true, userProfile: true, activeUser: true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !rustDeskIdentityMatches(content, canonical) || canonical.id != "123456789" {
		t.Fatal("reinstall identity was not preserved exactly")
	}
}

func TestIdentityMismatchDetected(t *testing.T) {
	if err := validateRustDeskIdentityIDs("123456789", "123456789"); err != nil {
		t.Fatalf("matching identities rejected: %v", err)
	}
	err := validateRustDeskIdentityIDs("123456789", "987654321")
	if err == nil || !strings.Contains(err.Error(), "identity_mismatch") {
		t.Fatalf("mismatch not detected: %v", err)
	}
}

func TestEncryptedCredentialIsNotReplacedByPlainPassword(t *testing.T) {
	if !hasProtectedRustDeskCredential(string(testRustDeskIdentity("123456789", "encrypted-password"))) {
		t.Fatal("valid password+salt identity was not protected")
	}
	if hasProtectedRustDeskCredential("id = '123456789'\npassword = 'random-plain-password'\n") {
		t.Fatal("plain password without salt was treated as protected")
	}
}

func TestRepairConfigStopsRuntimeBeforeSynchronizingProfiles(t *testing.T) {
	data, err := os.ReadFile("actions_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	start := strings.Index(source, "func handleRepairConfigRustDesk")
	if start < 0 {
		t.Fatal("repair_config handler source not found")
	}
	end := strings.Index(source[start:], "func handleDeployRemoteSupport")
	if end < 0 {
		t.Fatal("repair_config handler source not found")
	}
	handler := source[start : start+end]
	stop := strings.Index(handler, "stopRustDeskServiceFn()")
	sync := strings.Index(handler, "synchronizeCanonicalRustDeskConfig(cfg, canonical, false)")
	if stop < 0 || sync < 0 || stop > sync {
		t.Fatal("repair_config must stop Remote Support before writing synchronized configs")
	}
}

func TestReinstallRestoresAndValidatesCanonicalIdentity(t *testing.T) {
	data, err := os.ReadFile("rs_reinstall_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	for _, required := range []string{
		"loadCanonicalRustDeskIdentity()",
		"synchronizeCanonicalRustDeskConfig(o.cfg, o.canonical, true)",
		"validateCanonicalRustDeskIdentity(o.cfg, o.canonical)",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("reinstall canonical identity contract missing %q", required)
		}
	}
}
