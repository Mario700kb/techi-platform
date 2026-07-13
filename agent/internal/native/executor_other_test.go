//go:build !windows

package native

import "testing"

// On the non-Windows build NewWindowsExecutor is the refusing stub: every
// mutating primitive must return ErrNotWindows so live recovery can never run
// off Windows, while the pure payload verify still works.
func TestStubExecutorRefusesMutation(t *testing.T) {
	e := NewWindowsExecutor()
	for name, err := range map[string]error{
		"StopService":        e.StopService("RustDesk"),
		"StartService":       e.StartService("RustDesk"),
		"RemoveStaleService": e.RemoveStaleService("RustDesk"),
		"PromoteFiles":       e.PromoteFiles("a", "b"),
		"Rollback":           e.Rollback("b"),
		"ValidateFinal":      e.ValidateFinal(ExecuteParams{}),
	} {
		if err != ErrNotWindows {
			t.Errorf("%s must refuse with ErrNotWindows, got %v", name, err)
		}
	}
}
