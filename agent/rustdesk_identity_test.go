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

func TestRequiredRepairProfilesIncludeOnlyUserRoamingAndLocalService(t *testing.T) {
	profiles := []rustDeskSyncProfile{
		{root: `C:\Users\USER\AppData\Roaming\TECHI Remote Support`, role: rustDeskProfileUser, active: true},
		{root: `C:\Users\USER\AppData\Local\TECHI Remote Support`, role: rustDeskProfileUser, active: true},
		{root: `C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\TECHI Remote Support`, role: rustDeskProfileLocalService},
		{root: `C:\Windows\System32\config\systemprofile\AppData\Roaming\TECHI Remote Support`, role: rustDeskProfileSystem},
	}
	roots, err := requiredRustDeskRepairSyncRoots(profiles)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(roots, "|")
	if !strings.Contains(joined, `C:\Users\USER`) || !strings.Contains(joined, `ServiceProfiles\LocalService`) {
		t.Fatalf("repair_config targets missing: %v", roots)
	}
	if len(roots) != 2 || strings.Contains(joined, `AppData\Local`) || strings.Contains(joined, `systemprofile`) {
		t.Fatalf("optional profile included: %v", roots)
	}
}

func TestRequiredRepairProfilesReportMissingRequiredProfile(t *testing.T) {
	_, err := requiredRustDeskRepairSyncRoots([]rustDeskSyncProfile{
		{root: `C:\Users\USER\AppData\Local\TECHI Remote Support`, role: rustDeskProfileUser, active: true},
		{root: `C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\TECHI Remote Support`, role: rustDeskProfileLocalService},
	})
	if err == nil || !strings.Contains(err.Error(), "active-user Roaming") {
		t.Fatalf("missing required profile was not identified exactly: %v", err)
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

func TestIdentityMismatchReportsExactField(t *testing.T) {
	canonical := rustDeskCanonicalIdentity{content: testRustDeskIdentity("123456789", "encrypted-password")}
	changed := []byte(strings.Replace(string(canonical.content), "verified-salt", "different-salt", 1))
	if field := rustDeskIdentityMismatchField(changed, canonical); field != "salt" {
		t.Fatalf("mismatch field = %q, want salt", field)
	}
}

func TestRepairIdentityMaterializesCanonicalUIIDAndCompleteMaterial(t *testing.T) {
	original := []byte("enc_id = 'profile-encrypted-id'\n" +
		"password = 'encrypted-password'\n" +
		"salt = 'verified-salt'\n" +
		"key_pair = [[1, 2], [3, 4]]\n" +
		"key_confirmed = true\n" +
		"keys_confirmed = { 'server' = true }\n")
	materialized, id, err := materializeRustDeskRepairIdentity(original, "90498408")
	if err != nil {
		t.Fatal(err)
	}
	fields := parseTOMLTopLevel(string(materialized))
	if id != "90498408" || fields["id"] != "90498408" || fields["enc_id"] != "" {
		t.Fatalf("canonical ID was not materialized safely: id=%q fields=%v", id, fields)
	}
	for _, field := range []string{"password", "salt", "key_pair", "key_confirmed", "keys_confirmed"} {
		if fields[field] != parseTOMLTopLevel(string(original))[field] {
			t.Fatalf("identity field %s changed", field)
		}
	}
}

func TestRepairIdentityAcceptsPlaintextIDWithoutKeyPair(t *testing.T) {
	content := []byte("id = '90498408'\nenc_id = 'stale-encrypted-id'\npassword = 'encrypted-password'\nsalt = 'verified-salt'\n")
	materialized, id, err := materializeRustDeskRepairIdentity(content, "1967664801")
	if err != nil {
		t.Fatal(err)
	}
	fields := parseTOMLTopLevel(string(materialized))
	if id != "90498408" || fields["id"] != "90498408" || fields["enc_id"] != "" {
		t.Fatalf("plaintext canonical ID did not win: id=%q fields=%v", id, fields)
	}
	for _, field := range []string{"key_pair", "key_confirmed", "keys_confirmed"} {
		if _, exists := fields[field]; exists {
			t.Fatalf("incomplete optional crypto field %s was copied", field)
		}
	}
}

func TestRepairIdentityDropsIncompleteKeyPairForPlaintextID(t *testing.T) {
	content := []byte("id = '90498408'\npassword = 'encrypted-password'\nsalt = 'verified-salt'\nkey_pair = []\nkey_confirmed = true\nkeys_confirmed = { 'server' = true }\n")
	materialized, _, err := materializeRustDeskRepairIdentity(content, "")
	if err != nil {
		t.Fatal(err)
	}
	fields := parseTOMLTopLevel(string(materialized))
	for _, field := range []string{"key_pair", "key_confirmed", "keys_confirmed"} {
		if _, exists := fields[field]; exists {
			t.Fatalf("incomplete crypto field %s was retained", field)
		}
	}
}

func TestRepairIdentityRejectsEncryptedIDWithoutCompleteCryptoMaterial(t *testing.T) {
	content := []byte("enc_id = 'profile-encrypted-id'\npassword = 'encrypted-password'\nsalt = 'verified-salt'\nkey_confirmed = true\n")
	_, _, err := materializeRustDeskRepairIdentity(content, "90498408")
	if err == nil || !strings.Contains(err.Error(), "complete key_pair/key_confirmed") {
		t.Fatalf("encrypted identity without complete crypto material was accepted: %v", err)
	}
}

func TestRepairRuntimeIdentityAcceptsProfileReencryptedCanonicalID(t *testing.T) {
	materialized, id, err := materializeRustDeskRepairIdentity(testRustDeskIdentity("90498408", "encrypted-password"), "")
	if err != nil {
		t.Fatal(err)
	}
	canonical := rustDeskCanonicalIdentity{content: materialized, id: id}
	reencryptedContent, _ := applyTOMLTopLevelPatch(string(materialized), "id", "")
	reencryptedContent, _ = applyTOMLTopLevelPatch(reencryptedContent, "enc_id", "service-encrypted-90498408")
	reencrypted := []byte(reencryptedContent)
	if field := rustDeskRepairRuntimeIdentityMismatchField(reencrypted, canonical); field != "" {
		t.Fatalf("profile re-encryption rejected at field %q", field)
	}
	changedKey := []byte(strings.Replace(string(reencrypted), "['public', 'private']", "['other', 'key']", 1))
	if field := rustDeskRepairRuntimeIdentityMismatchField(changedKey, canonical); field != "key_pair" {
		t.Fatalf("changed key pair mismatch field = %q", field)
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
	sync := strings.Index(handler, "synchronizeRepairRustDeskConfig(cfg, canonical)")
	if stop < 0 || sync < 0 || stop > sync {
		t.Fatal("repair_config must stop Remote Support before writing synchronized configs")
	}
	for _, required := range []string{
		"loadCanonicalRustDeskRepairIdentity(cfg)",
		"validateRepairRustDeskIdentity(cfg, canonical)",
		"native.LaunchRemoteSupportUI(rustdeskDefaultInstallPath)",
	} {
		if !strings.Contains(handler, required) {
			t.Fatalf("repair_config required-profile contract missing %q", required)
		}
	}
	if strings.Contains(handler, "synchronizeCanonicalRustDeskConfig") || strings.Contains(handler, "validateCanonicalRustDeskIdentity") {
		t.Fatal("repair_config must not use the reinstall profile contract")
	}
	serviceStart := strings.Index(handler, "startRustDeskServiceFn()")
	serviceValidation := strings.Index(handler, "service identity verification failed")
	uiStart := strings.Index(handler, "native.LaunchRemoteSupportUI(rustdeskDefaultInstallPath)")
	uiValidation := strings.Index(handler, "UI identity verification failed")
	if serviceStart < 0 || serviceValidation < serviceStart || uiStart < serviceValidation || uiValidation < uiStart {
		t.Fatal("repair_config must verify service identity before starting and verifying UI")
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
