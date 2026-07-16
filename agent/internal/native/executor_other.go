//go:build !windows

package native

import "time"

// stubExecutor is the non-Windows Executor. Every mutating primitive refuses:
// live Remote Support recovery only runs on Windows. It exists so the package
// (and the standalone bootstrap) build and unit-test on Linux/macOS, and so a
// dry-run plan can be produced anywhere. Payload verification is pure, so the
// stub performs it for real.
type stubExecutor struct{}

// NewWindowsExecutor returns the platform Executor. On non-Windows it is the
// refusing stub. Signature matches the Windows build so callers are portable.
func NewWindowsExecutor() Executor { return stubExecutor{} }

func (stubExecutor) CaptureState(ExecuteParams) (PriorState, error) {
	return PriorState{}, ErrNotWindows
}

func (stubExecutor) VerifyPayload(path, sha string) error {
	if _, err := VerifyPayload(path, sha); err != nil {
		return err
	}
	return nil
}

func (stubExecutor) PreserveConfig(ExecuteParams) (UndoFunc, error) { return nil, ErrNotWindows }
func (stubExecutor) StopTray(ExecuteParams, PriorState) (UndoFunc, error) {
	return nil, ErrNotWindows
}
func (stubExecutor) StopService(ExecuteParams, PriorState) (UndoFunc, error) {
	return nil, ErrNotWindows
}
func (stubExecutor) StopProcessExact(string, time.Duration) (UndoFunc, error) {
	return nil, ErrNotWindows
}
func (stubExecutor) RemoveStaleService(ExecuteParams, PriorState) (UndoFunc, error) {
	return nil, ErrNotWindows
}
func (stubExecutor) CleanupTmp(ExecuteParams) (UndoFunc, error) { return nil, ErrNotWindows }
func (stubExecutor) StagePayload(ExecuteParams, string, *BoundBundle) (UndoFunc, error) {
	return nil, ErrNotWindows
}
func (stubExecutor) PromoteFiles(ExecuteParams, string, *BundleManifest) (UndoFunc, error) {
	return nil, ErrNotWindows
}
func (stubExecutor) RestoreConfig(ExecuteParams) (UndoFunc, error) { return nil, ErrNotWindows }
func (stubExecutor) CreateService(ExecuteParams, *BundleManifest, PriorState) (UndoFunc, error) {
	return nil, ErrNotWindows
}
func (stubExecutor) StartService(ExecuteParams, PriorState) (UndoFunc, error) {
	return nil, ErrNotWindows
}
func (stubExecutor) StartUI(ExecuteParams) (UndoFunc, error)            { return nil, ErrNotWindows }
func (stubExecutor) ScheduleBootRetry(ExecuteParams) (UndoFunc, error)  { return nil, ErrNotWindows }
func (stubExecutor) ValidateFinal(ExecuteParams, *BundleManifest) error { return ErrNotWindows }
func (stubExecutor) Health(ExecuteParams) string                        { return "unknown (non-windows)" }

func RunRemoteSupportUISessionProbe(string, uint32, bool) error { return ErrNotWindows }

// ObserveRemoteSupport cannot probe a real device off Windows; the caller must
// supply an observation fixture instead.
func ObserveRemoteSupport(ExecuteParams) (RSObservation, error) {
	return RSObservation{}, ErrNotWindows
}
