//go:build windows

package main

import (
	"fmt"
	"os"
)

type rustDeskFileUpdate struct {
	path    string
	before  []byte
	after   []byte
	mode    os.FileMode
	existed bool
	protect bool
}

func applyRustDeskFileUpdates(updates []rustDeskFileUpdate) error {
	applied := make([]rustDeskFileUpdate, 0, len(updates))
	for _, update := range updates {
		removeTomlReadOnly(update.path)
		if err := atomicWriteFile(update.path, update.after, update.mode); err != nil {
			rollbackRustDeskFileUpdates(append(applied, update))
			return fmt.Errorf("write %s: %w", update.path, err)
		}
		if update.protect {
			setTomlReadOnly(update.path)
		}
		applied = append(applied, update)
	}
	return nil
}

func rollbackRustDeskFileUpdates(applied []rustDeskFileUpdate) {
	for i := len(applied) - 1; i >= 0; i-- {
		update := applied[i]
		removeTomlReadOnly(update.path)
		if update.existed {
			_ = atomicWriteFile(update.path, update.before, update.mode)
			if update.protect {
				setTomlReadOnly(update.path)
			}
		} else {
			_ = os.Remove(update.path)
		}
	}
}
