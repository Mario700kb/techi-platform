package native

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MaxBootRetries is the exact, bounded number of boot-time recovery retries.
// After this many attempts the retry state is exhausted and the one-shot task
// must self-delete rather than loop forever (the incident's endless-repair
// failure mode).
const MaxBootRetries = 3

// RetryState is the TECHI-owned record of boot-retry attempts, persisted so a
// scheduled retry is strictly bounded and self-terminating. It is owned by the
// bootstrap; the retry task verifies ownership before touching it.
type RetryState struct {
	Owner       string `json:"owner"` // always "techi-bootstrap"
	Component   string `json:"component"`
	Version     string `json:"version"`
	Attempts    int    `json:"attempts"`
	MaxAttempts int    `json:"max_attempts"`
	FirstAt     int64  `json:"first_at_unix"`
	LastAt      int64  `json:"last_at_unix"`
}

const retryStateOwner = "techi-bootstrap"

// RetryStatePath is the fixed TECHI-owned location for a component's retry state.
func RetryStatePath(root, component string) (string, error) {
	if err := validateToken(component); err != nil {
		return "", err
	}
	return SafeJoinUnder(filepath.Join(root, "retry"), component+".retry.json")
}

// LoadRetryState reads the retry state, returning a zeroed (non-nil) state when
// absent. It refuses a state file not owned by the bootstrap.
func LoadRetryState(path string) (*RetryState, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &RetryState{Owner: retryStateOwner, MaxAttempts: MaxBootRetries}, nil
		}
		return nil, err
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return nil, fmt.Errorf("invalid retry state: %w", err)
	}
	var s RetryState
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil {
		return nil, fmt.Errorf("invalid retry state: %w", err)
	}
	if s.Owner != retryStateOwner {
		return nil, fmt.Errorf("retry state not owned by %s (owner=%q)", retryStateOwner, s.Owner)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return nil, fmt.Errorf("invalid retry state: trailing JSON")
	}
	if s.MaxAttempts != MaxBootRetries || s.Attempts < 0 || s.Attempts > MaxBootRetries {
		return nil, fmt.Errorf("invalid retry attempt bounds")
	}
	return &s, nil
}

// RecordAttempt increments and persists the attempt count. It returns the new
// state. The caller checks Exhausted() to decide whether to schedule another
// retry or self-delete.
func RecordAttempt(path, component, version string) (*RetryState, error) {
	s, err := LoadRetryState(path)
	if err != nil {
		return nil, err
	}
	if s.Component != "" && (s.Component != component || s.Version != version) {
		return nil, fmt.Errorf("retry state identity does not match %s/%s", component, version)
	}
	if s.Exhausted() {
		return nil, fmt.Errorf("retry attempt budget exhausted")
	}
	now := time.Now().Unix()
	if s.FirstAt == 0 {
		s.FirstAt = now
	}
	s.Owner = retryStateOwner
	s.Component = component
	s.Version = version
	s.Attempts++
	s.LastAt = now
	s.MaxAttempts = MaxBootRetries
	if err := writeRetryState(path, s); err != nil {
		return nil, err
	}
	return s, nil
}

// InitializeRetryState creates an owned zero-attempt retry record or validates
// the existing record's exact identity. Scheduling is not itself an attempt.
func InitializeRetryState(path, component, version string) (*RetryState, error) {
	if _, err := os.Stat(path); err == nil {
		s, err := LoadRetryState(path)
		if err != nil {
			return nil, err
		}
		if s.Component != component || s.Version != version {
			return nil, fmt.Errorf("retry state identity does not match %s/%s", component, version)
		}
		return s, nil
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	s := &RetryState{Owner: retryStateOwner, Component: component, Version: version, MaxAttempts: MaxBootRetries}
	if err := writeRetryState(path, s); err != nil {
		return nil, err
	}
	return s, nil
}

// RecordBootRetryInvocation increments an existing owned record. It refuses a
// forged --retry-owner invocation when no scheduled retry state exists.
func RecordBootRetryInvocation(path, component, version string) (*RetryState, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("owned retry state missing: %w", err)
	}
	return RecordAttempt(path, component, version)
}

func writeRetryState(path string, s *RetryState) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// Exhausted reports whether the bounded retry budget is spent.
func (s *RetryState) Exhausted() bool { return s.Attempts >= s.MaxAttempts }

// ClearRetryState removes the retry record (called on success / permanent
// failure / exhaustion). It refuses to remove a file it does not own.
func ClearRetryState(path string) error {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil
	}
	if s, err := LoadRetryState(path); err != nil || s.Owner != retryStateOwner {
		return fmt.Errorf("refusing to clear non-owned retry state: %s", path)
	}
	return os.Remove(path)
}
