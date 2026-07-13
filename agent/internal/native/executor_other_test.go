//go:build !windows

package native

import "testing"

// On the non-Windows build NewWindowsExecutor is the refusing stub: every
// mutating primitive must return ErrNotWindows so live recovery can never run
// off Windows, while the pure payload verify still works.
func TestStubExecutorRefusesMutation(t *testing.T) {
	e := NewWindowsExecutor()
	_, stopErr := e.StopService(ExecuteParams{}, PriorState{})
	_, startErr := e.StartService(ExecuteParams{}, PriorState{})
	_, removeErr := e.RemoveStaleService(ExecuteParams{}, PriorState{})
	_, promoteErr := e.PromoteFiles(ExecuteParams{}, "a", nil)
	for name, err := range map[string]error{
		"StopService":        stopErr,
		"StartService":       startErr,
		"RemoveStaleService": removeErr,
		"PromoteFiles":       promoteErr,
		"ValidateFinal":      e.ValidateFinal(ExecuteParams{}, nil),
	} {
		if err != ErrNotWindows {
			t.Errorf("%s must refuse with ErrNotWindows, got %v", name, err)
		}
	}
}
