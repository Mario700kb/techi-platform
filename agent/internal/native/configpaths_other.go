//go:build !windows

package native

func ResolveManifestConfigPaths(*BundleManifest) ([]string, error) {
	return nil, ErrNotWindows
}
