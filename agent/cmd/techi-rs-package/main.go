// Command techi-rs-package builds the canonical, deterministic native Remote
// Support bundle consumed by techi-bootstrap.exe repair-remote-support. It does
// NOT use or produce an MSI — the MSI stays a first-install fallback only.
//
//	techi-rs-package --source <dir> --version 1.4.6 --out <dir>
//
// Output (in --out):
//
//	TECHI-Remote-Support-<version>-windows-amd64.zip
//	TECHI-Remote-Support-<version>-windows-amd64.zip.sha256
//	TECHI-Remote-Support-<version>-windows-amd64.identity.json
//	TECHI-Remote-Support-<version>-windows-amd64.manifest.json
//
// The same bytes serve upload, activation, NETLOGON publication, and the canary.
// SHA256 is computed AFTER packaging. No signing occurs; identity reports
// signed:false.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"techi-platform/agent/internal/native"
)

func main() {
	src := flag.String("source", "installer/TECHI-Remote-Support", "Remote Support runtime source directory (authoritative bytes)")
	version := flag.String("version", "1.4.6", "Remote Support version X.Y.Z")
	out := flag.String("out", "dist/native", "output directory")
	product := flag.String("product", "TECHI Remote Support", "product directory name inside the bundle")
	commit := flag.String("commit", "", "build commit (optional)")
	flag.Parse()

	if err := run(*src, *version, *out, *product, *commit); err != nil {
		fmt.Fprintln(os.Stderr, "techi-rs-package: "+err.Error())
		os.Exit(1)
	}
}

func run(src, version, out, product, commit string) error {
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	base := fmt.Sprintf("TECHI-Remote-Support-%s-windows-amd64", version)
	zipPath := filepath.Join(out, base+".zip")

	// 1) Build the deterministic ZIP in memory + the manifest (per-file hashes).
	var buf bytes.Buffer
	manifest, err := native.BuildBundle(&buf, native.BuildOptions{
		SourceDir:        src,
		Product:          product,
		Version:          version,
		BuildCommit:      commit,
		EntrypointName:   "TECHI Remote Support.exe",
		ServiceName:      "TECHI Remote Support",
		ServiceArguments: []string{"--service"},
		TrayTaskName:     "TECHI Remote Support Tray",
		TrayArguments:    []string{"--tray"},
	})
	if err != nil {
		return err
	}

	// 2) bundle_sha256 is the SHA of the produced ZIP bytes.
	zipBytes := buf.Bytes()
	manifest.BundleSHA256 = native.HashBytesSHA256(zipBytes)

	// 3) Write the ZIP + sidecars.
	if err := os.WriteFile(zipPath, zipBytes, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(zipPath+".sha256",
		[]byte(manifest.BundleSHA256+"  "+base+".zip\n"), 0o644); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(out, base+".manifest.json"), manifest); err != nil {
		return err
	}
	identity := map[string]any{
		"schema":         "techi-native-identity/1",
		"product":        manifest.Product,
		"version":        manifest.Version,
		"platform":       "windows",
		"arch":           "amd64",
		"bundle_file":    base + ".zip",
		"bundle_sha256":  manifest.BundleSHA256,
		"file_count":     len(manifest.ExpectedRelativeFiles),
		"entrypoint":     manifest.Entrypoint,
		"build_commit":   commit,
		"built_at":       time.Now().UTC().Format(time.RFC3339),
		"signing_status": "unsigned",
		"signed":         false,
		"distribution":   "LAN-local; AV/EDR policies remain applicable",
	}
	if err := writeJSON(filepath.Join(out, base+".identity.json"), identity); err != nil {
		return err
	}

	// 4) Self-verify: re-extract and validate against the manifest we just wrote.
	if err := verifyRoundTrip(zipBytes, manifest); err != nil {
		return fmt.Errorf("self-verification failed: %w", err)
	}

	fmt.Printf("✅ %s\n   bundle_sha256=%s\n   files=%d\n",
		zipPath, manifest.BundleSHA256, len(manifest.ExpectedRelativeFiles))
	return nil
}

func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

// verifyRoundTrip extracts the freshly built ZIP to a temp dir and runs the
// same VerifyExtractedBundle gate the executor uses, proving the artifact is
// self-consistent before it ever reaches a device.
func verifyRoundTrip(zipBytes []byte, m *native.BundleManifest) error {
	dir, err := os.MkdirTemp("", "rs-bundle-verify-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	if err := native.ExtractZipBytesSafe(zipBytes, dir); err != nil {
		return err
	}
	return native.VerifyExtractedBundle(dir, m)
}
