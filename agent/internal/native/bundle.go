package native

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// BundlePayloadFormatVersion is the on-disk contract version for the native
// Remote Support bundle. The executor refuses a bundle whose manifest declares
// a different payload_format_version.
const BundlePayloadFormatVersion = 1

// BundleManifestSchemaVersion versions the manifest JSON shape itself.
const BundleManifestSchemaVersion = 1

// BundleFile is one file inside the native bundle. Path is the bundle-relative
// path with forward slashes; SHA256 is lowercase hex.
type BundleFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	// Executable marks a file whose Authenticode signature is expected once
	// signing is implemented; Signed reports whether it is actually signed.
	Executable bool `json:"executable,omitempty"`
	Signed     bool `json:"signed"`
}

// BundleManifest is the immutable, versioned contract describing a native
// Remote Support bundle. It is a SIDECAR next to the .zip; bundle_sha256 is the
// SHA256 of the .zip bytes (so the manifest can carry it without a cycle).
type BundleManifest struct {
	SchemaVersion         int          `json:"schema_version"`
	PayloadFormatVersion  int          `json:"payload_format_version"`
	Product               string       `json:"product"`
	Version               string       `json:"version"`
	Platform              string       `json:"platform"`
	Architecture          string       `json:"architecture"`
	Entrypoint            string       `json:"entrypoint"`
	ServiceName           string       `json:"service_name"`
	ServiceArguments      []string     `json:"service_arguments"`
	TrayTaskName          string       `json:"tray_task_name,omitempty"`
	TrayArguments         []string     `json:"tray_arguments,omitempty"`
	ExpectedRelativeFiles []BundleFile `json:"expected_relative_files"`
	BundleSHA256          string       `json:"bundle_sha256"`
	BuildCommit           string       `json:"build_commit"`
	BuildTimestamp        string       `json:"build_timestamp"`
	Publisher             string       `json:"publisher,omitempty"`
	ConfigPathsToPreserve []string     `json:"config_paths_to_preserve"`
	NeverOverwrite        []string     `json:"never_overwrite_paths"`
	MinimumSupportedWin   string       `json:"minimum_supported_windows,omitempty"`
	// SigningStatus is "unsigned" until real Authenticode verification occurs.
	SigningStatus string `json:"signing_status"`
}

// LoadBundleManifest reads and structurally validates a manifest sidecar.
func LoadBundleManifest(path string) (*BundleManifest, error) {
	data, err := os.ReadFile(strings.TrimSpace(path))
	if err != nil {
		return nil, fmt.Errorf("cannot read manifest: %w", err)
	}
	var m BundleManifest
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("invalid manifest json: %w", err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// Validate enforces the manifest's structural contract before it is trusted.
func (m *BundleManifest) Validate() error {
	if m.SchemaVersion != BundleManifestSchemaVersion {
		return fmt.Errorf("unsupported manifest schema_version %d", m.SchemaVersion)
	}
	if m.PayloadFormatVersion != BundlePayloadFormatVersion {
		return fmt.Errorf("unsupported payload_format_version %d", m.PayloadFormatVersion)
	}
	if !versionRe.MatchString(m.Version) {
		return fmt.Errorf("manifest version %q is not X.Y.Z", m.Version)
	}
	if m.Platform != "windows" {
		return fmt.Errorf("unsupported platform %q", m.Platform)
	}
	if m.Architecture != "amd64" {
		return fmt.Errorf("unsupported architecture %q", m.Architecture)
	}
	if m.Product == "" {
		return fmt.Errorf("empty product")
	}
	if m.ServiceName == "" {
		return fmt.Errorf("empty service_name")
	}
	if !sha256Re.MatchString(strings.ToLower(m.BundleSHA256)) {
		return fmt.Errorf("bundle_sha256 must be 64 lowercase hex chars")
	}
	if len(m.ExpectedRelativeFiles) == 0 {
		return fmt.Errorf("expected_relative_files is empty")
	}
	if err := validateBundleRelPath(m.Entrypoint); err != nil {
		return fmt.Errorf("entrypoint: %w", err)
	}
	seen := map[string]bool{}
	entrypointListed := false
	for _, f := range m.ExpectedRelativeFiles {
		if err := validateBundleRelPath(f.Path); err != nil {
			return fmt.Errorf("file entry: %w", err)
		}
		key := strings.ToLower(f.Path)
		if seen[key] {
			return fmt.Errorf("duplicate manifest entry %q", f.Path)
		}
		seen[key] = true
		if !sha256Re.MatchString(strings.ToLower(f.SHA256)) {
			return fmt.Errorf("file %q sha256 must be 64 lowercase hex chars", f.Path)
		}
		if f.Size < 0 {
			return fmt.Errorf("file %q has negative size", f.Path)
		}
		if strings.EqualFold(f.Path, m.Entrypoint) {
			entrypointListed = true
		}
	}
	if !entrypointListed {
		return fmt.Errorf("entrypoint %q not present in expected_relative_files", m.Entrypoint)
	}
	return nil
}

// validateBundleRelPath rejects absolute paths, drive/UNC prefixes, backslashes
// (bundle paths are forward-slash only), and any ".." segment.
func validateBundleRelPath(p string) error {
	p = strings.TrimSpace(p)
	if p == "" {
		return fmt.Errorf("empty path")
	}
	if strings.Contains(p, `\`) {
		return fmt.Errorf("path %q must use forward slashes", p)
	}
	if strings.HasPrefix(p, "/") || hasDriveLetter(p) {
		return fmt.Errorf("path %q must be relative", p)
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." || seg == "." || seg == "" {
			return fmt.Errorf("path %q has an illegal segment", p)
		}
	}
	return nil
}

// VerifyExtractedBundle proves an extracted bundle directory matches the
// manifest EXACTLY before promotion: every expected file present with the right
// size + SHA256, the entrypoint present, and NO unexpected extra files. It
// refuses reparse points and path escapes. This is the gate the executor runs
// after extraction and before any promotion — never the MSI repair loop.
func VerifyExtractedBundle(dir string, m *BundleManifest) error {
	if m == nil {
		return fmt.Errorf("nil manifest")
	}
	expected := make(map[string]BundleFile, len(m.ExpectedRelativeFiles))
	for _, f := range m.ExpectedRelativeFiles {
		expected[filepath.ToSlash(f.Path)] = f
	}

	// 1) Every expected file must exist and match.
	for rel, f := range expected {
		abs, err := SafeJoinUnder(dir, rel)
		if err != nil {
			return fmt.Errorf("expected file %q: %w", rel, err)
		}
		info, err := os.Lstat(abs)
		if err != nil {
			return fmt.Errorf("missing expected file %q: %w", rel, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("expected file %q is a symlink/reparse point", rel)
		}
		if info.Size() != f.Size {
			return fmt.Errorf("file %q size %d != manifest %d", rel, info.Size(), f.Size)
		}
		got, err := HashFileSHA256(abs)
		if err != nil {
			return fmt.Errorf("cannot hash %q: %w", rel, err)
		}
		if !strings.EqualFold(got, f.SHA256) {
			return fmt.Errorf("file %q sha256 mismatch", rel)
		}
	}

	// 2) No unexpected extra files.
	var extra []string
	err := filepath.Walk(dir, func(path string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if fi.IsDir() {
			return nil
		}
		rel, rerr := filepath.Rel(dir, path)
		if rerr != nil {
			return rerr
		}
		rel = filepath.ToSlash(rel)
		if _, ok := expected[rel]; !ok {
			extra = append(extra, rel)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("scanning extracted dir: %w", err)
	}
	if len(extra) > 0 {
		sort.Strings(extra)
		return fmt.Errorf("unexpected extra file(s) in bundle: %s", strings.Join(extra, ", "))
	}

	// 3) Entrypoint present (already size/hash-checked above via expected set).
	if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(m.Entrypoint))); err != nil {
		return fmt.Errorf("entrypoint missing after extraction: %w", err)
	}
	return nil
}

// IsNativeBundleFilename requires the RS recovery payload to be a .zip bundle,
// never an MSI. The executor uses this to refuse an MSI as the native payload.
func IsNativeBundleFilename(name string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(name)), ".zip")
}

// maxBundleFileBytes bounds a single decompressed entry to resist zip bombs.
const maxBundleFileBytes = 512 << 20

// isReparse reports whether path is a symlink/junction/irregular node. It is
// cross-platform (Lstat-based); the Windows executor additionally checks the
// FILE_ATTRIBUTE_REPARSE_POINT flag for defense in depth.
func isReparse(path string) bool {
	fi, err := os.Lstat(path)
	if err != nil {
		return false
	}
	return fi.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0
}

// ExtractZipFileSafe extracts the zip at zipPath into dir. See ExtractZipBytesSafe.
func ExtractZipFileSafe(zipPath, dir string) error {
	data, err := os.ReadFile(zipPath)
	if err != nil {
		return err
	}
	return ExtractZipBytesSafe(data, dir)
}

// ExtractZipBytesSafe extracts a zip archive into dir with full hardening:
// every entry must resolve under dir (no absolute/UNC/drive/.. paths), no
// duplicate entry names, no symlink/irregular entries, and each file is size-
// bounded. It is the single safe extractor shared by the packager self-check
// and the Windows executor. It refuses to write through a reparse point.
func ExtractZipBytesSafe(data []byte, dir string) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, f := range zr.File {
		name := f.Name
		if strings.HasSuffix(name, "/") {
			continue // directory entry; created implicitly below
		}
		key := strings.ToLower(filepath.ToSlash(name))
		if seen[key] {
			return fmt.Errorf("duplicate zip entry %q", name)
		}
		seen[key] = true
		if f.Mode()&os.ModeSymlink != 0 || !f.Mode().IsRegular() {
			return fmt.Errorf("refusing non-regular zip entry %q", name)
		}
		target, err := SafeJoinUnder(dir, name)
		if err != nil {
			return fmt.Errorf("unsafe zip entry %q: %w", name, err)
		}
		parent := filepath.Dir(target)
		if err := os.MkdirAll(parent, 0o700); err != nil {
			return err
		}
		if isReparse(parent) {
			return fmt.Errorf("refusing to write through a reparse point: %s", target)
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		outFile, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			rc.Close()
			return err
		}
		_, cerr := io.Copy(outFile, io.LimitReader(rc, maxBundleFileBytes))
		outFile.Close()
		rc.Close()
		if cerr != nil {
			return cerr
		}
	}
	return nil
}
