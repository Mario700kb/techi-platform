//go:build !windows

package native

import "time"

// stubExecutor is the non-Windows Executor. Every mutating primitive refuses:
// live Remote Support recovery only runs on Windows. It exists so the package
// (and the standalone bootstrap) build and unit-test on Linux/macOS, and so a
// dry-run plan can be produced anywhere.
type stubExecutor struct{}

// NewWindowsExecutor returns the platform Executor. On non-Windows it is the
// refusing stub. Signature matches the Windows build so callers are portable.
func NewWindowsExecutor() Executor { return stubExecutor{} }

// VerifyPayload is a pure file hash check, so the stub performs it for real —
// a Linux/macOS dry-run still reports identity failures honestly.
func (stubExecutor) VerifyPayload(path, sha string) error {
	if _, err := VerifyPayload(path, sha); err != nil {
		return err
	}
	return nil
}
func (stubExecutor) PreserveConfig(string) error                  { return ErrNotWindows }
func (stubExecutor) StopService(string) error                     { return ErrNotWindows }
func (stubExecutor) StopTray(string) error                        { return ErrNotWindows }
func (stubExecutor) StopProcessExact(string, time.Duration) error { return ErrNotWindows }
func (stubExecutor) RemoveStaleService(string) error              { return ErrNotWindows }
func (stubExecutor) CleanupTmp(string) error                      { return ErrNotWindows }
func (stubExecutor) StagePayload(string, string, string) error    { return ErrNotWindows }
func (stubExecutor) PromoteFiles(string, string) error            { return ErrNotWindows }
func (stubExecutor) RestoreConfig(string) error                   { return ErrNotWindows }
func (stubExecutor) CreateService(string, string) error           { return ErrNotWindows }
func (stubExecutor) StartService(string) error                    { return ErrNotWindows }
func (stubExecutor) ScheduleBootRetry(string) error               { return ErrNotWindows }
func (stubExecutor) ValidateFinal(ExecuteParams) error            { return ErrNotWindows }
func (stubExecutor) Rollback(string) error                        { return ErrNotWindows }

// ObserveRemoteSupport cannot probe a real device off Windows; the caller must
// supply an observation fixture instead.
func ObserveRemoteSupport(ExecuteParams) (RSObservation, error) {
	return RSObservation{}, ErrNotWindows
}
