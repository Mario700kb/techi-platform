// Package native is the small, deterministic Windows bootstrap/update source
// candidate; it does not yet replace the live GPO/CMD orchestration. Everything
// in this file is platform-neutral and unit-testable
// off Windows: the pure decision logic (policy contract, path safety, staging,
// SHA verification, structured results, and the Remote Support / Agent state
// machines) lives here; the Windows-only side effects (SCM, process
// termination, file promotion) are injected through interfaces so the
// decisions can be exercised with fakes.
package native

import (
	"encoding/json"
	"time"
)

// ExitCode is the deterministic, bounded process exit code contract shared by
// every native bootstrap operation. Values MUST NOT be reordered or reused:
// the GPO Scheduled Task and operators map each to a fixed meaning.
type ExitCode int

const (
	ExitOK              ExitCode = 0 // operation completed and validated
	ExitError           ExitCode = 1 // generic failure after arguments/identity were accepted
	ExitBadArgs         ExitCode = 2 // missing/invalid arguments or unparseable policy
	ExitIdentityFailed  ExitCode = 3 // SHA256/path identity check failed; NO mutation performed
	ExitBusy            ExitCode = 4 // another update/recovery already holds the lock
	ExitPendingReboot   ExitCode = 5 // work staged/partially done; a bounded boot retry is required
	ExitUnsafeTarget    ExitCode = 6 // a path escaped the allowed root; refused
	ExitPayloadMissing  ExitCode = 7 // required package/payload not present or empty
	ExitValidationError ExitCode = 8 // post-operation validation failed (rolled back where possible)
)

// String gives each exit code a stable, log-friendly name.
func (c ExitCode) String() string {
	switch c {
	case ExitOK:
		return "ok"
	case ExitError:
		return "error"
	case ExitBadArgs:
		return "bad_args"
	case ExitIdentityFailed:
		return "identity_failed"
	case ExitBusy:
		return "busy"
	case ExitPendingReboot:
		return "pending_reboot"
	case ExitUnsafeTarget:
		return "unsafe_target"
	case ExitPayloadMissing:
		return "payload_missing"
	case ExitValidationError:
		return "validation_error"
	default:
		return "unknown"
	}
}

// OperationResult is the single machine-readable record every native
// operation emits. It is JSON-serialisable so `--json` callers (canary
// tooling, CI, the future backend collector) get a deterministic contract.
type OperationResult struct {
	Operation string   `json:"operation"`
	Component string   `json:"component,omitempty"`
	Code      ExitCode `json:"code"`
	CodeName  string   `json:"code_name"`
	OK        bool     `json:"ok"`
	DryRun    bool     `json:"dry_run"`
	Message   string   `json:"message,omitempty"`
	Classify  string   `json:"classification,omitempty"`
	Planned   []string `json:"planned_actions,omitempty"`
	Performed []string `json:"performed_actions,omitempty"`
	// Rollback records the honest outcome of a transactional rollback, when one
	// was attempted after a failed mutation.
	Rollback  *RollbackResult `json:"rollback,omitempty"`
	Timestamp time.Time       `json:"timestamp"`
}

// NewResult builds a result with the derived convenience fields populated.
func NewResult(operation string, code ExitCode) OperationResult {
	return OperationResult{
		Operation: operation,
		Code:      code,
		CodeName:  code.String(),
		OK:        code == ExitOK,
		Timestamp: time.Now().UTC(),
	}
}

// JSON renders the result as a compact single line, stable for log ingestion.
func (r OperationResult) JSON() string {
	b, err := json.Marshal(r)
	if err != nil {
		// Marshalling OperationResult cannot realistically fail; fall back to a
		// minimal hand-built object so callers always get valid JSON.
		return `{"operation":"` + r.Operation + `","code_name":"marshal_error"}`
	}
	return string(b)
}
