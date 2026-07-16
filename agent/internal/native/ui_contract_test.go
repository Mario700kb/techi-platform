package native

import "testing"

func TestRemoteSupportMainWindowRejectsTrayHelper(t *testing.T) {
	if remoteSupportMainWindowSizeUsable(16, 16) {
		t.Fatal("16x16 tray helper must not satisfy UI validation")
	}
	if !remoteSupportMainWindowSizeUsable(800, 600) {
		t.Fatal("normal main window must satisfy UI validation")
	}
}

func TestSelectInteractiveSessionRejectsSessionZero(t *testing.T) {
	session, ok := selectInteractiveSession([]uiSessionCandidate{
		{id: 0, active: true, hasUser: true},
		{id: 4, active: true, hasUser: true},
	}, 0)
	if !ok || session != 4 {
		t.Fatalf("session = %d ok=%t", session, ok)
	}
}

func TestSelectInteractiveSessionNoLoggedInUser(t *testing.T) {
	if session, ok := selectInteractiveSession([]uiSessionCandidate{
		{id: 1, active: true, hasUser: false},
		{id: 2, active: false, hasUser: true},
	}, 1); ok || session != 0 {
		t.Fatalf("session = %d ok=%t", session, ok)
	}
}
