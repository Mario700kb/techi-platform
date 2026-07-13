package native

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestExecutionLockConcurrentRunReturnsBusy(t *testing.T) {
	root := t.TempDir()
	first, code, err := AcquireExecutionLock(root)
	if err != nil || code != ExitOK {
		t.Fatalf("first acquire: code=%v err=%v", code, err)
	}
	defer first.Release()

	const contenders = 8
	var wg sync.WaitGroup
	results := make(chan ExitCode, contenders)
	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			lock, code, _ := AcquireExecutionLock(root)
			if lock != nil {
				lock.Release()
			}
			results <- code
		}()
	}
	wg.Wait()
	close(results)
	for got := range results {
		if got != ExitBusy {
			t.Fatalf("concurrent acquire returned %v, want ExitBusy", got)
		}
	}
}

func TestExecutionLockOwnedStaleReclaimAndUnownedRefusal(t *testing.T) {
	root := t.TempDir()
	lockDir := filepath.Join(root, "locks", "remote-support.lock")
	if err := os.MkdirAll(lockDir, 0o700); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-lockStaleAfter - time.Minute)
	if err := os.Chtimes(lockDir, old, old); err != nil {
		t.Fatal(err)
	}
	if lock, code, err := AcquireExecutionLock(root); lock != nil || code != ExitBusy || err == nil {
		t.Fatalf("unowned stale lock must be refused: lock=%v code=%v err=%v", lock, code, err)
	}
	if err := os.WriteFile(filepath.Join(lockDir, "owner"), []byte("owner=techi-bootstrap pid=999999 ts=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(lockDir, old, old); err != nil {
		t.Fatal(err)
	}
	lock, code, err := AcquireExecutionLock(root)
	if err != nil || code != ExitOK || lock == nil {
		t.Fatalf("owned stale reclaim: code=%v err=%v", code, err)
	}
	lock.Release()
}
