package native

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeSource builds a small synthetic Remote Support runtime tree and returns
// its directory.
func makeSource(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string][]byte{
		"TECHI Remote Support.exe":                   []byte("MZ fake exe bytes"),
		"flutter_windows.dll":                        []byte("flutter runtime"),
		"librustdesk.dll":                            []byte("dll bytes here"),
		filepath.Join("data", "icudtl.dat"):          []byte("icu data"),
		filepath.Join("data", "app.so"):              []byte("shared object"),
		filepath.Join("data", "flutter_assets", "x"): []byte("asset"),
	}
	for rel, data := range files {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func buildTestBundle(t *testing.T, src string) ([]byte, *BundleManifest) {
	t.Helper()
	var buf bytes.Buffer
	m, err := BuildBundle(&buf, BuildOptions{
		SourceDir:        src,
		Product:          "TECHI Remote Support",
		Version:          "1.4.6",
		EntrypointName:   "TECHI Remote Support.exe",
		ServiceName:      "TECHI Remote Support",
		ServiceArguments: []string{"--service"},
		TrayTaskName:     "TECHI Remote Support Tray",
		TrayArguments:    []string{"--tray"},
	})
	if err != nil {
		t.Fatalf("BuildBundle: %v", err)
	}
	m.BundleSHA256 = HashBytesSHA256(buf.Bytes())
	return buf.Bytes(), m
}

func TestBundle_Deterministic(t *testing.T) {
	src := makeSource(t)
	a, _ := buildTestBundle(t, src)
	b, _ := buildTestBundle(t, src)
	if !bytes.Equal(a, b) {
		t.Fatalf("bundle bytes are not deterministic")
	}
	if HashBytesSHA256(a) != HashBytesSHA256(b) {
		t.Fatalf("bundle sha not deterministic")
	}
}

func TestBundle_ManifestCompleteAndValid(t *testing.T) {
	src := makeSource(t)
	_, m := buildTestBundle(t, src)
	if err := m.Validate(); err != nil {
		t.Fatalf("manifest invalid: %v", err)
	}
	if len(m.ExpectedRelativeFiles) != 6 {
		t.Fatalf("want 6 files, got %d", len(m.ExpectedRelativeFiles))
	}
	if m.Entrypoint != "TECHI Remote Support/TECHI Remote Support.exe" {
		t.Fatalf("entrypoint wrong: %q", m.Entrypoint)
	}
	// Every file path is under the single product dir with forward slashes.
	for _, f := range m.ExpectedRelativeFiles {
		if !strings.HasPrefix(f.Path, "TECHI Remote Support/") {
			t.Errorf("file not under product root: %q", f.Path)
		}
		if strings.Contains(f.Path, `\`) {
			t.Errorf("backslash in path: %q", f.Path)
		}
	}
}

func TestBundle_RejectsIncompleteRuntime(t *testing.T) {
	for name, mutate := range map[string]func(string) error{
		"missing app.so": func(root string) error {
			return os.Remove(filepath.Join(root, "data", "app.so"))
		},
		"zero-byte app.so": func(root string) error {
			return os.WriteFile(filepath.Join(root, "data", "app.so"), nil, 0o644)
		},
		"double-nested runtime": func(root string) error {
			nested := filepath.Join(root, "TECHI Remote Support")
			if err := os.MkdirAll(nested, 0o755); err != nil {
				return err
			}
			return os.Rename(filepath.Join(root, "data"), filepath.Join(nested, "data"))
		},
	} {
		t.Run(name, func(t *testing.T) {
			source := makeSource(t)
			if err := mutate(source); err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			_, err := BuildBundle(&out, BuildOptions{
				SourceDir: source, Product: "TECHI Remote Support", Version: "1.4.8",
				EntrypointName: "TECHI Remote Support.exe", ServiceName: "TECHI Remote Support",
				ServiceArguments: []string{"--service"}, TrayTaskName: "TECHI Remote Support Tray",
				TrayArguments: []string{"--tray"},
			})
			if err == nil {
				t.Fatal("incomplete runtime must fail packaging")
			}
		})
	}
}

func TestBundle_ManifestRejectsMissingRequiredRuntime(t *testing.T) {
	_, manifest := buildTestBundle(t, makeSource(t))
	for i, file := range manifest.ExpectedRelativeFiles {
		if strings.EqualFold(file.Path, "TECHI Remote Support/data/app.so") {
			manifest.ExpectedRelativeFiles = append(manifest.ExpectedRelativeFiles[:i], manifest.ExpectedRelativeFiles[i+1:]...)
			break
		}
	}
	if err := manifest.Validate(); err == nil || !strings.Contains(err.Error(), "data/app.so") {
		t.Fatalf("manifest without app.so must fail, got %v", err)
	}
}

func TestBundle_RoundTripVerify(t *testing.T) {
	src := makeSource(t)
	zb, m := buildTestBundle(t, src)
	dir := t.TempDir()
	if err := ExtractZipBytesSafe(zb, dir); err != nil {
		t.Fatalf("extract: %v", err)
	}
	if err := VerifyExtractedBundle(dir, m); err != nil {
		t.Fatalf("verify should pass: %v", err)
	}
}

func TestBundle_VerifyRejects(t *testing.T) {
	src := makeSource(t)
	zb, m := buildTestBundle(t, src)

	t.Run("missing file", func(t *testing.T) {
		dir := t.TempDir()
		if err := ExtractZipBytesSafe(zb, dir); err != nil {
			t.Fatal(err)
		}
		os.Remove(filepath.Join(dir, "TECHI Remote Support", "librustdesk.dll"))
		if err := VerifyExtractedBundle(dir, m); err == nil {
			t.Fatal("expected missing-file rejection")
		}
	})

	t.Run("hash mismatch", func(t *testing.T) {
		dir := t.TempDir()
		if err := ExtractZipBytesSafe(zb, dir); err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(dir, "TECHI Remote Support", "librustdesk.dll")
		os.WriteFile(p, []byte("tampered but same length!!"), 0o644)
		if err := VerifyExtractedBundle(dir, m); err == nil {
			t.Fatal("expected hash/size rejection")
		}
	})

	t.Run("unexpected extra file", func(t *testing.T) {
		dir := t.TempDir()
		if err := ExtractZipBytesSafe(zb, dir); err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(dir, "TECHI Remote Support", "evil.dll"), []byte("x"), 0o644)
		if err := VerifyExtractedBundle(dir, m); err == nil {
			t.Fatal("expected extra-file rejection")
		}
	})
}

// craftZip builds a raw zip with the given entry names/modes for hostile-input
// testing.
func craftZip(t *testing.T, entries []struct {
	name string
	mode os.FileMode
	body string
}) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.mode != 0 {
			h.SetMode(e.mode)
		}
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(e.body))
	}
	zw.Close()
	return buf.Bytes()
}

func TestExtractZipBytesSafe_Hostile(t *testing.T) {
	type ent = struct {
		name string
		mode os.FileMode
		body string
	}
	cases := map[string][]ent{
		"traversal":      {{`../evil.txt`, 0, "x"}},
		"absolute":       {{`/etc/passwd`, 0, "x"}},
		"drive":          {{`C:\Windows\x`, 0, "x"}},
		"unc":            {{`\\srv\share\x`, 0, "x"}},
		"duplicate":      {{`a.txt`, 0, "1"}, {`a.txt`, 0, "2"}},
		"case alias":     {{`a.txt`, 0, "1"}, {`A.TXT`, 0, "2"}},
		"ads":            {{`safe.txt:evil`, 0, "x"}},
		"reserved":       {{`CON.txt`, 0, "x"}},
		"trailing dot":   {{`safe.`, 0, "x"}},
		"trailing space": {{`safe `, 0, "x"}},
		"symlink":        {{`link`, os.ModeSymlink, "target"}},
	}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			zb := craftZip(t, entries)
			if err := ExtractZipBytesSafe(zb, t.TempDir()); err == nil {
				t.Fatalf("expected rejection of %s", name)
			}
		})
	}
}

func setCentralDirectorySizes(t *testing.T, data []byte, sizes []uint32) []byte {
	t.Helper()
	out := append([]byte(nil), data...)
	sig := []byte{'P', 'K', 1, 2}
	from := 0
	for _, size := range sizes {
		i := bytes.Index(out[from:], sig)
		if i < 0 {
			t.Fatal("central directory entry not found")
		}
		i += from
		binary.LittleEndian.PutUint32(out[i+24:i+28], size)
		from = i + 46
	}
	return out
}

func TestExtractZipBytesSafe_ResourceCaps(t *testing.T) {
	t.Run("entry count", func(t *testing.T) {
		entries := make([]struct {
			name string
			mode os.FileMode
			body string
		}, maxBundleEntries+1)
		for i := range entries {
			entries[i].name = fmt.Sprintf("f-%04d", i)
		}
		if err := ExtractZipBytesSafe(craftZip(t, entries), t.TempDir()); err == nil {
			t.Fatal("entry cap not enforced")
		}
	})
	t.Run("declared per file", func(t *testing.T) {
		zipBytes := craftZip(t, []struct {
			name string
			mode os.FileMode
			body string
		}{{"a", 0, "x"}})
		zipBytes = setCentralDirectorySizes(t, zipBytes, []uint32{uint32(maxBundleFileBytes + 1)})
		if err := ExtractZipBytesSafe(zipBytes, t.TempDir()); err == nil {
			t.Fatal("per-file cap not enforced")
		}
	})
	t.Run("declared total", func(t *testing.T) {
		entries := []struct {
			name string
			mode os.FileMode
			body string
		}{{"a", 0, "x"}, {"b", 0, "x"}, {"c", 0, "x"}, {"d", 0, "x"}}
		zipBytes := setCentralDirectorySizes(t, craftZip(t, entries), []uint32{400 << 20, 400 << 20, 400 << 20, 400 << 20})
		if err := ExtractZipBytesSafe(zipBytes, t.TempDir()); err == nil {
			t.Fatal("total expanded-size cap not enforced")
		}
	})
}

func TestManifest_StructuralRejections(t *testing.T) {
	src := makeSource(t)
	base := func() *BundleManifest { _, m := buildTestBundle(t, src); return m }

	cases := map[string]func(*BundleManifest){
		"bad version":         func(m *BundleManifest) { m.Version = "1.4" },
		"wrong platform":      func(m *BundleManifest) { m.Platform = "linux" },
		"wrong arch":          func(m *BundleManifest) { m.Architecture = "arm64" },
		"bad payload fmt":     func(m *BundleManifest) { m.PayloadFormatVersion = 2 },
		"bad bundle sha":      func(m *BundleManifest) { m.BundleSHA256 = "nope" },
		"entrypoint missing":  func(m *BundleManifest) { m.Entrypoint = "TECHI Remote Support/ghost.exe" },
		"empty files":         func(m *BundleManifest) { m.ExpectedRelativeFiles = nil },
		"traversal in path":   func(m *BundleManifest) { m.ExpectedRelativeFiles[0].Path = "../x" },
		"backslash in path":   func(m *BundleManifest) { m.ExpectedRelativeFiles[0].Path = `a\b` },
		"empty product root":  func(m *BundleManifest) { m.ProductRoot = "" },
		"nested product root": func(m *BundleManifest) { m.ProductRoot = "a/b" },
		"reserved root":       func(m *BundleManifest) { m.ProductRoot = "CON" },
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			m := base()
			mut(m)
			if err := m.Validate(); err == nil {
				t.Fatalf("expected rejection: %s", name)
			}
		})
	}
}

func TestBundle_CanonicalPromotionSourceNoDoubleNesting(t *testing.T) {
	_, manifest := buildTestBundle(t, makeSource(t))
	root := t.TempDir()
	source, err := PromoteSourceDir(root, manifest)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "TECHI Remote Support")
	if source != want {
		t.Fatalf("promotion source=%q want=%q", source, want)
	}
	if strings.Contains(strings.TrimPrefix(source, root), filepath.Join("TECHI Remote Support", "TECHI Remote Support")) {
		t.Fatalf("product root was double nested: %s", source)
	}
}

func TestParseBundleManifestRejectsTrailingJSON(t *testing.T) {
	_, manifest := buildTestBundle(t, makeSource(t))
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseBundleManifest(append(data, []byte(` {}`)...)); err == nil {
		t.Fatal("trailing JSON must be rejected")
	}
}

func TestParseBundleManifestRejectsDuplicateKeys(t *testing.T) {
	_, manifest := buildTestBundle(t, makeSource(t))
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	data = bytes.Replace(data, []byte(`"schema_version":1`), []byte(`"schema_version":1,"schema_version":1`), 1)
	if _, err := ParseBundleManifest(data); err == nil {
		t.Fatal("duplicate manifest key must be rejected")
	}
}

func TestIsNativeBundleFilename(t *testing.T) {
	if !IsNativeBundleFilename("TECHI-Remote-Support-1.4.6-windows-amd64.zip") {
		t.Fatal("zip should be accepted")
	}
	if IsNativeBundleFilename("TECHI-Remote-Support-1.4.6.msi") {
		t.Fatal("MSI must be refused as native payload")
	}
}

func TestBundle_NoSecretsOrConfigIncluded(t *testing.T) {
	// A source tree that accidentally contains config/id/log files: the packager
	// bundles whatever is under source, so the guarantee is enforced by NOT
	// pointing --source at a live install. Here we assert the manifest preserve/
	// never-overwrite lists name the config locations kept OUTSIDE the bundle.
	src := makeSource(t)
	_, m := buildTestBundle(t, src)
	joined := strings.ToLower(strings.Join(append(m.ConfigPathsToPreserve, m.NeverOverwrite...), " "))
	if !strings.Contains(joined, "techi remote support") {
		t.Fatalf("preserve list should name RS config location: %v", m.ConfigPathsToPreserve)
	}
	if !strings.Contains(joined, ".toml") {
		t.Fatalf("never-overwrite should protect RS .toml config: %v", m.NeverOverwrite)
	}
	// No bundled file should look like a secret/config/id/log.
	for _, f := range m.ExpectedRelativeFiles {
		low := strings.ToLower(f.Path)
		for _, bad := range []string{".toml", "id_ed25519", "password", ".log", "config.json"} {
			if strings.Contains(low, bad) {
				t.Errorf("bundle must not contain %q (%s)", bad, f.Path)
			}
		}
	}
}
