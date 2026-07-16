//go:build !windows

package native

func LaunchRemoteSupportUI(string) (string, string, error) {
	return "", "", ErrNotWindows
}
