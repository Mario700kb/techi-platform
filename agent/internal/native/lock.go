package native

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ExecutionLock is a machine-wide, cross-process lock owned by the TECHI
// bootstrap. It guards the whole observation→mutation→rollback→retry-scheduling
// sequence so two concurrent invocations can never race on the same service /
// install dir. It is a directory-based lock (atomic mkdir) with an owner-stamped
// PID + timestamp so a stale lock from a crashed run can be reclaimed safely.
type ExecutionLock struct {
	dir      string
	acquired bool
}

// lockStaleAfter bounds how long a lock is honoured before it is treated as
// abandoned by a crashed process. A full recovery finishes in well under this.
const lockStaleAfter = 15 * time.Minute

// AcquireExecutionLock atomically acquires the machine-wide lock under root
// (…/locks/remote-support.lock). It returns ExitBusy if another live invocation
// holds it. A lock older than lockStaleAfter is reclaimed once, explicitly.
func AcquireExecutionLock(root string) (*ExecutionLock, ExitCode, error) {
	if strings.TrimSpace(root) == "" {
		return nil, ExitBadArgs, fmt.Errorf("empty lock root")
	}
	locksDir := filepath.Join(root, "locks")
	if err := os.MkdirAll(locksDir, 0o700); err != nil {
		return nil, ExitError, err
	}
	dir := filepath.Join(locksDir, "remote-support.lock")

	tryAcquire := func() error { return os.Mkdir(dir, 0o700) }
	if err := tryAcquire(); err != nil {
		// Already held — decide whether it is stale.
		if info, statErr := os.Stat(dir); statErr == nil {
			if time.Since(info.ModTime()) > lockStaleAfter {
				// Reclaim only a directory carrying our exact owner stamp, and only
				// when it contains no unexpected files. Never RemoveAll here.
				ownerPath := filepath.Join(dir, "owner")
				owner, readErr := os.ReadFile(ownerPath)
				if readErr != nil || parsePIDFromOwner(owner) <= 0 || !strings.Contains(string(owner), "owner=techi-bootstrap") {
					return nil, ExitBusy, fmt.Errorf("stale lock is not TECHI-owned")
				}
				if err := os.Remove(ownerPath); err != nil {
					return nil, ExitBusy, err
				}
				if err := os.Remove(dir); err != nil {
					return nil, ExitBusy, fmt.Errorf("stale lock contains unexpected state: %w", err)
				}
				if err2 := tryAcquire(); err2 != nil {
					return nil, ExitBusy, fmt.Errorf("lock held (stale reclaim failed): %w", err2)
				}
			} else {
				return nil, ExitBusy, fmt.Errorf("another recovery is in progress")
			}
		} else {
			return nil, ExitBusy, fmt.Errorf("lock held: %w", err)
		}
	}
	// Stamp ownership; failure releases the just-created directory and aborts.
	if err := os.WriteFile(filepath.Join(dir, "owner"),
		[]byte(fmt.Sprintf("owner=techi-bootstrap pid=%d ts=%d\n", os.Getpid(), time.Now().Unix())), 0o600); err != nil {
		_ = os.Remove(dir)
		return nil, ExitError, err
	}
	return &ExecutionLock{dir: dir, acquired: true}, ExitOK, nil
}

// Release frees the lock. Safe to call multiple times.
func (l *ExecutionLock) Release() {
	if l == nil || !l.acquired {
		return
	}
	_ = os.Remove(filepath.Join(l.dir, "owner"))
	_ = os.Remove(l.dir)
	l.acquired = false
}

// parsePIDFromOwner is a tiny helper used by tests/diagnostics to read the PID
// stamped in an owner file.
func parsePIDFromOwner(data []byte) int {
	for _, tok := range strings.Fields(string(data)) {
		if strings.HasPrefix(tok, "pid=") {
			if n, err := strconv.Atoi(strings.TrimPrefix(tok, "pid=")); err == nil {
				return n
			}
		}
	}
	return 0
}
