package native

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// bundleEpoch is the fixed, normalized modification time stamped on every ZIP
// entry so the same source tree always produces byte-identical archive headers
// (deterministic builds). 2020-01-01T00:00:00Z.
var bundleEpoch = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)

// BuildOptions configures a native bundle build.
type BuildOptions struct {
	SourceDir   string // directory holding the runtime files (e.g. TECHI-Remote-Support/)
	Product     string // product directory name inside the bundle (e.g. "TECHI Remote Support")
	Version     string // X.Y.Z
	BuildCommit string
	Publisher   string
	// Entrypoint is the product-relative EXE name (e.g. "TECHI Remote Support.exe").
	EntrypointName   string
	ServiceName      string
	ServiceArguments []string
	TrayTaskName     string
	TrayArguments    []string
}

// BuildBundle walks SourceDir deterministically, writes a normalized ZIP to w,
// and returns the manifest for it (with per-file hashes). BundleSHA256 is left
// empty: the caller computes it from the produced ZIP bytes (avoiding a cycle)
// and sets it. It refuses symlinks/irregular files so nothing unexpected is
// bundled.
func BuildBundle(w io.Writer, opts BuildOptions) (*BundleManifest, error) {
	if !versionRe.MatchString(opts.Version) {
		return nil, fmt.Errorf("version %q is not X.Y.Z", opts.Version)
	}
	if strings.ContainsAny(opts.Product, `/\`) || opts.Product == "" {
		return nil, fmt.Errorf("invalid product name %q", opts.Product)
	}

	files, err := collectBundleFiles(opts.SourceDir)
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no files found under %s", opts.SourceDir)
	}

	zw := zip.NewWriter(w)
	var entries []BundleFile
	for _, rel := range files { // already sorted
		abs := filepath.Join(opts.SourceDir, rel)
		info, err := os.Lstat(abs)
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return nil, fmt.Errorf("refusing non-regular file in bundle: %s", rel)
		}
		// Bundle path = <Product>/<rel> with forward slashes.
		bundleRel := path.Join(opts.Product, filepath.ToSlash(rel))
		if err := validateBundleRelPath(bundleRel); err != nil {
			return nil, err
		}

		data, err := os.ReadFile(abs)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(data)
		entries = append(entries, BundleFile{
			Path:       bundleRel,
			SHA256:     hex.EncodeToString(sum[:]),
			Size:       int64(len(data)),
			Executable: strings.HasSuffix(strings.ToLower(bundleRel), ".exe"),
			Signed:     false,
		})

		hdr := &zip.FileHeader{Name: bundleRel, Method: zip.Deflate}
		hdr.Modified = bundleEpoch
		hdr.SetMode(0o644)
		fw, err := zw.CreateHeader(hdr)
		if err != nil {
			return nil, err
		}
		if _, err := fw.Write(data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}

	entrypoint := path.Join(opts.Product, opts.EntrypointName)
	m := &BundleManifest{
		SchemaVersion:         BundleManifestSchemaVersion,
		PayloadFormatVersion:  BundlePayloadFormatVersion,
		Product:               opts.Product,
		ProductRoot:           opts.Product,
		Version:               opts.Version,
		Platform:              "windows",
		Architecture:          "amd64",
		Entrypoint:            entrypoint,
		ServiceName:           opts.ServiceName,
		ServiceArguments:      opts.ServiceArguments,
		TrayTaskName:          opts.TrayTaskName,
		TrayArguments:         opts.TrayArguments,
		ExpectedRelativeFiles: entries,
		BuildCommit:           opts.BuildCommit,
		BuildTimestamp:        bundleEpoch.Format(time.RFC3339),
		Publisher:             opts.Publisher,
		// RustDesk keeps its ID/config/password OUTSIDE the install dir, so the
		// bundle carries none of it; these lists document what recovery must
		// leave untouched. RustDesk config lives under ServiceProfiles/roaming.
		ConfigPathsToPreserve: []string{
			`C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\TECHI Remote Support`,
			`C:\Users\*\AppData\Roaming\TECHI Remote Support`,
		},
		NeverOverwrite: []string{
			"*/RustDesk.toml", "*/RustDesk2.toml", "*/*.toml",
		},
		MinimumSupportedWin: "10",
		SigningStatus:       "unsigned",
	}
	return m, nil
}

// collectBundleFiles returns the sorted, slash-normalized relative paths of all
// regular files under root.
func collectBundleFiles(root string) ([]string, error) {
	var out []string
	err := filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if fi.IsDir() {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return rerr
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

// HashBytesSHA256 returns the lowercase hex SHA256 of data.
func HashBytesSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
