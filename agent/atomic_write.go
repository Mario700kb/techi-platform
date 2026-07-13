package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// atomicWriteFile writes a sibling temporary file, flushes it, and renames it
// over path. A sibling is required so the rename stays on one filesystem.
func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	security, err := captureFileSecurity(path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".techi-remote-support-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("atomic rename: %w", err)
	}
	if err := restoreFileSecurity(path, security); err != nil {
		return fmt.Errorf("restore file security: %w", err)
	}
	return nil
}
