package native

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRetryStateBoundedAndIdentityBound(t *testing.T) {
	path := filepath.Join(t.TempDir(), "retry", "remote_support.retry.json")
	initial, err := InitializeRetryState(path, "remote_support", "1.4.6")
	if err != nil || initial.Attempts != 0 {
		t.Fatalf("initialize: state=%+v err=%v", initial, err)
	}
	for want := 1; want <= MaxBootRetries; want++ {
		state, err := RecordBootRetryInvocation(path, "remote_support", "1.4.6")
		if err != nil {
			t.Fatal(err)
		}
		if state.Attempts != want || state.Exhausted() != (want == MaxBootRetries) {
			t.Fatalf("attempt %d: %+v", want, state)
		}
	}
	if _, err := RecordBootRetryInvocation(path, "remote_support", "1.4.6"); err == nil {
		t.Fatal("attempt beyond exact retry bound must fail")
	}
	if err := ClearRetryState(path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("retry state not cleared: %v", err)
	}
}

func TestBootRetryInvocationRequiresScheduledState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "retry", "remote_support.retry.json")
	if _, err := RecordBootRetryInvocation(path, "remote_support", "1.4.6"); err == nil {
		t.Fatal("forged retry-owner invocation must be refused without owned state")
	}
}

func TestRetryStateRefusesForeignMalformedAndChangedIdentity(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	for name, data := range map[string]string{
		"foreign":   `{"owner":"someone-else","max_attempts":3}`,
		"trailing":  `{"owner":"techi-bootstrap","max_attempts":3} {}`,
		"unbounded": `{"owner":"techi-bootstrap","max_attempts":99}`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadRetryState(path); err == nil {
				t.Fatal("expected refusal")
			}
		})
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := RecordAttempt(path, "remote_support", "1.4.6"); err != nil {
		t.Fatal(err)
	}
	if _, err := RecordAttempt(path, "remote_support", "1.4.7"); err == nil {
		t.Fatal("changed retry version must be refused")
	}
}
