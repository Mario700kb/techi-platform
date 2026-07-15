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

var requiredRuntimeFiles = []string{
	"TECHI Remote Support.exe",
	"flutter_windows.dll",
	"librustdesk.dll",
	"data/icudtl.dat",
	"data/app.so",
}

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
	SchemaVersion        int    `json:"schema_version"`
	PayloadFormatVersion int    `json:"payload_format_version"`
	Product              string `json:"product"`
	// ProductRoot is the SINGLE relative directory inside the ZIP that holds the
	// runtime. Promotion moves exactly this directory into the install root — the
	// root is declared, never inferred from arbitrary ZIP entries (which caused
	// C:\Program Files\TECHI Remote Support\TECHI Remote Support\… double nesting).
	ProductRoot           string       `json:"product_root"`
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
	return ParseBundleManifest(data)
}

// ParseBundleManifest parses and validates exact sidecar bytes. It also rejects
// trailing JSON so the hashed sidecar has one unambiguous meaning.
func ParseBundleManifest(data []byte) (*BundleManifest, error) {
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return nil, fmt.Errorf("invalid manifest json: %w", err)
	}
	var m BundleManifest
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("invalid manifest json: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return nil, fmt.Errorf("invalid manifest json: trailing data")
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
	if err := validateProductRoot(m.ProductRoot); err != nil {
		return fmt.Errorf("product_root: %w", err)
	}
	if m.ServiceName == "" {
		return fmt.Errorf("empty service_name")
	}
	if len(m.ServiceArguments) == 0 {
		return fmt.Errorf("empty service_arguments")
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
	rootPrefix := m.ProductRoot + "/"
	if !strings.HasPrefix(m.Entrypoint, rootPrefix) {
		return fmt.Errorf("entrypoint %q must be under product_root %q", m.Entrypoint, m.ProductRoot)
	}
	seen := map[string]bool{}
	entrypointListed := false
	for _, f := range m.ExpectedRelativeFiles {
		if err := validateBundleRelPath(f.Path); err != nil {
			return fmt.Errorf("file entry: %w", err)
		}
		if !strings.HasPrefix(f.Path, rootPrefix) {
			return fmt.Errorf("file %q must be under product_root %q", f.Path, m.ProductRoot)
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
	for _, required := range requiredRuntimeFiles {
		entry, ok := manifestFileByPath(m.ExpectedRelativeFiles, m.ProductRoot+"/"+required)
		if !ok {
			return fmt.Errorf("required runtime file %q missing from manifest", required)
		}
		if entry.Size <= 0 {
			return fmt.Errorf("required runtime file %q is empty", required)
		}
	}
	assetsPrefix := strings.ToLower(m.ProductRoot + "/data/flutter_assets/")
	hasAssets := false
	for _, file := range m.ExpectedRelativeFiles {
		if strings.HasPrefix(strings.ToLower(file.Path), assetsPrefix) && file.Size > 0 {
			hasAssets = true
			break
		}
	}
	if !hasAssets {
		return fmt.Errorf("required runtime directory data/flutter_assets is missing or empty")
	}
	return nil
}

func manifestFileByPath(files []BundleFile, want string) (BundleFile, bool) {
	for _, file := range files {
		if strings.EqualFold(file.Path, want) {
			return file, true
		}
	}
	return BundleFile{}, false
}

// ValidateRequiredRuntimeLayout proves the concrete Flutter runtime exists at
// the exact installed/source paths and rejects missing, empty, or double-nested
// layouts before packaging or health can succeed.
func ValidateRequiredRuntimeLayout(root string) error {
	for _, rel := range requiredRuntimeFiles {
		path := filepath.Join(root, filepath.FromSlash(rel))
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("required runtime file %q: %w", rel, err)
		}
		if !info.Mode().IsRegular() || info.Size() <= 0 {
			return fmt.Errorf("required runtime file %q is not a non-empty regular file", rel)
		}
	}
	assets := filepath.Join(root, "data", "flutter_assets")
	info, err := os.Stat(assets)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("required runtime directory data/flutter_assets is missing")
	}
	hasAsset := false
	err = filepath.Walk(assets, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.Mode().IsRegular() && info.Size() > 0 {
			hasAsset = true
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("scan data/flutter_assets: %w", err)
	}
	if !hasAsset {
		return fmt.Errorf("required runtime directory data/flutter_assets is empty")
	}
	return nil
}

// reservedDeviceNames are Windows reserved basenames that must never appear as
// a path segment (they resolve to devices, not files).
var reservedDeviceNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

// validateBundleRelPath rejects everything that is not a plain forward-slash
// relative path: backslashes, absolute/drive/UNC, `.`/`..` segments, NTFS
// alternate-data-stream colons, reserved device names, trailing dots/spaces,
// and control characters. These are the ZIP-entry hardening rules (#9).
func validateBundleRelPath(p string) error {
	if p == "" || p != strings.TrimSpace(p) {
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
		if strings.ContainsAny(seg, ":") {
			return fmt.Errorf("path %q contains a colon (ADS/drive)", p)
		}
		if strings.ContainsAny(seg, `<>"|?*`) {
			return fmt.Errorf("path segment %q contains an illegal Windows character", seg)
		}
		if seg != strings.TrimRight(seg, ". ") {
			return fmt.Errorf("path segment %q has a trailing dot/space", seg)
		}
		for _, r := range seg {
			if r < 0x20 {
				return fmt.Errorf("path %q contains a control character", p)
			}
		}
		base := seg
		if dot := strings.IndexByte(seg, '.'); dot >= 0 {
			base = seg[:dot]
		}
		if reservedDeviceNames[strings.ToLower(base)] {
			return fmt.Errorf("path segment %q is a reserved device name", seg)
		}
	}
	return nil
}

// validateProductRoot requires a single safe relative directory segment (no
// separators, no traversal, no reserved/illegal characters).
func validateProductRoot(root string) error {
	if strings.ContainsAny(root, `/\`) {
		return fmt.Errorf("product_root %q must be a single directory segment", root)
	}
	return validateBundleRelPath(root)
}

// PromoteSourceDir is the exact staged directory promotion must move into the
// install root: <extractedRoot>/<product_root>. It never infers the root from
// ZIP entries. It also confirms the entrypoint resolves under it.
func PromoteSourceDir(extractedRoot string, m *BundleManifest) (string, error) {
	if m == nil {
		return "", fmt.Errorf("nil manifest")
	}
	if err := validateProductRoot(m.ProductRoot); err != nil {
		return "", err
	}
	src, err := SafeJoinUnder(extractedRoot, m.ProductRoot)
	if err != nil {
		return "", err
	}
	epRel := strings.TrimPrefix(m.Entrypoint, m.ProductRoot+"/")
	if _, err := SafeJoinUnder(src, epRel); err != nil {
		return "", fmt.Errorf("entrypoint escapes product_root: %w", err)
	}
	return src, nil
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

// FilesUnderRoot returns the manifest's expected files keyed by their path
// RELATIVE TO product_root (i.e. how they appear in the install dir after
// promotion), each with its BundleFile.
func (m *BundleManifest) FilesUnderRoot() map[string]BundleFile {
	out := make(map[string]BundleFile, len(m.ExpectedRelativeFiles))
	prefix := m.ProductRoot + "/"
	for _, f := range m.ExpectedRelativeFiles {
		out[strings.TrimPrefix(f.Path, prefix)] = f
	}
	return out
}

// EntrypointUnderRoot returns the entrypoint path relative to product_root
// (e.g. "TECHI Remote Support.exe"), i.e. its location inside the install dir.
func (m *BundleManifest) EntrypointUnderRoot() string {
	return strings.TrimPrefix(m.Entrypoint, m.ProductRoot+"/")
}

// VerifyInstallDirAgainstManifest proves an INSTALL directory (product-root
// contents promoted into place) matches the manifest exactly: every file
// present with matching size+sha, no unexpected extra files, no symlink. Used
// by final validation (#7).
func VerifyInstallDirAgainstManifest(installDir string, m *BundleManifest) error {
	if m == nil {
		return fmt.Errorf("nil manifest")
	}
	if err := m.Validate(); err != nil {
		return err
	}
	if err := ValidateRequiredRuntimeLayout(installDir); err != nil {
		return err
	}
	expected := m.FilesUnderRoot()
	expectedFolded := make(map[string]BundleFile, len(expected))
	for rel, file := range expected {
		expectedFolded[strings.ToLower(filepath.ToSlash(rel))] = file
	}
	for rel, f := range expected {
		abs, err := SafeJoinUnder(installDir, rel)
		if err != nil {
			return fmt.Errorf("expected file %q: %w", rel, err)
		}
		info, err := os.Lstat(abs)
		if err != nil {
			return fmt.Errorf("missing installed file %q: %w", rel, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("installed file %q is a symlink", rel)
		}
		if info.Size() != f.Size {
			return fmt.Errorf("installed file %q size mismatch", rel)
		}
		got, err := HashFileSHA256(abs)
		if err != nil {
			return err
		}
		if !strings.EqualFold(got, f.SHA256) {
			return fmt.Errorf("installed file %q sha mismatch", rel)
		}
	}
	var extra []string
	err := filepath.Walk(installDir, func(path string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if fi.IsDir() {
			return nil
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("installed path is a symlink: %s", path)
		}
		rel, relErr := filepath.Rel(installDir, path)
		if relErr != nil {
			return relErr
		}
		if _, ok := expectedFolded[strings.ToLower(filepath.ToSlash(rel))]; !ok {
			extra = append(extra, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("scan installed files: %w", err)
	}
	if len(extra) > 0 {
		sort.Strings(extra)
		return fmt.Errorf("unexpected extra file(s) in install dir: %s", strings.Join(extra, ", "))
	}
	return nil
}

// IsNativeBundleFilename requires the RS recovery payload to be a .zip bundle,
// never an MSI. The executor uses this to refuse an MSI as the native payload.
func IsNativeBundleFilename(name string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(name)), ".zip")
}

// Bundle extraction bounds (#9): resist zip bombs and pathological archives.
const (
	maxBundleFileBytes  = 512 << 20  // per-file decompressed cap
	maxBundleTotalBytes = 1536 << 20 // total decompressed cap (~1.5 GB)
	maxBundleEntries    = 5000       // entry-count cap
)

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
	if len(zr.File) > maxBundleEntries {
		return fmt.Errorf("zip has %d entries, exceeds cap %d", len(zr.File), maxBundleEntries)
	}
	seen := map[string]bool{}
	var totalBytes int64
	for _, f := range zr.File {
		name := f.Name
		if strings.Contains(name, `\`) {
			return fmt.Errorf("unsafe zip entry %q: backslashes are forbidden", name)
		}
		if strings.HasSuffix(name, "/") {
			name = strings.TrimSuffix(name, "/")
			if err := validateBundleRelPath(filepath.ToSlash(name)); err != nil {
				return fmt.Errorf("unsafe zip directory %q: %w", f.Name, err)
			}
			continue // directory entry; created implicitly below
		}
		// Validate the entry name against the full path-hardening rule set
		// (colons/ADS, reserved names, trailing dot/space, control chars, ..).
		if err := validateBundleRelPath(filepath.ToSlash(name)); err != nil {
			return fmt.Errorf("unsafe zip entry %q: %w", name, err)
		}
		key := strings.ToLower(filepath.ToSlash(name))
		if seen[key] {
			return fmt.Errorf("duplicate zip entry %q (case-insensitive)", name)
		}
		seen[key] = true
		if f.Mode()&os.ModeSymlink != 0 || !f.Mode().IsRegular() {
			return fmt.Errorf("refusing non-regular zip entry %q", name)
		}
		if f.UncompressedSize64 > uint64(maxBundleFileBytes) {
			return fmt.Errorf("zip entry %q exceeds per-file cap %d", name, maxBundleFileBytes)
		}
		if uint64(totalBytes)+f.UncompressedSize64 > uint64(maxBundleTotalBytes) {
			return fmt.Errorf("zip total expanded size exceeds cap %d", maxBundleTotalBytes)
		}
		target, err := SafeJoinUnder(dir, name)
		if err != nil {
			return fmt.Errorf("unsafe zip entry %q: %w", name, err)
		}
		parent := filepath.Dir(target)
		if err := mkdirAllNoSymlink(dir, parent); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		outFile, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			rc.Close()
			return err
		}
		// Read one byte past the per-file cap so an oversized entry FAILS rather
		// than being silently truncated.
		written, cerr := io.Copy(outFile, io.LimitReader(rc, maxBundleFileBytes+1))
		outFile.Close()
		rc.Close()
		if cerr != nil {
			return cerr
		}
		if written > maxBundleFileBytes {
			return fmt.Errorf("zip entry %q exceeds per-file cap %d", name, maxBundleFileBytes)
		}
		totalBytes += written
		if totalBytes > maxBundleTotalBytes {
			return fmt.Errorf("zip total expanded size exceeds cap %d", maxBundleTotalBytes)
		}
	}
	return nil
}

// mkdirAllNoSymlink creates parent directories one segment at a time and
// refuses any existing symlink/reparse-like node. O_EXCL on the final file then
// prevents hard-link/alias overwrites inside a freshly owned staging tree.
func mkdirAllNoSymlink(root, parent string) error {
	rel, err := filepath.Rel(root, parent)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("parent %q escapes extraction root %q", parent, root)
	}
	cur := filepath.Clean(root)
	if fi, statErr := os.Lstat(cur); statErr != nil || !fi.IsDir() || isReparse(cur) {
		return fmt.Errorf("unsafe extraction root %q", cur)
	}
	if rel == "." {
		return nil
	}
	for _, seg := range strings.Split(rel, string(filepath.Separator)) {
		cur = filepath.Join(cur, seg)
		fi, statErr := os.Lstat(cur)
		if os.IsNotExist(statErr) {
			if err := os.Mkdir(cur, 0o700); err != nil && !os.IsExist(err) {
				return err
			}
			fi, statErr = os.Lstat(cur)
		}
		if statErr != nil || !fi.IsDir() || isReparse(cur) {
			return fmt.Errorf("refusing extraction through symlink/reparse path: %s", cur)
		}
	}
	return nil
}
