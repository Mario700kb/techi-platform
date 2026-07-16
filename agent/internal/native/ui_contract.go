package native

import (
	"fmt"
	"strings"
)

const (
	remoteSupportUIHealthyStatus      = "healthy"
	remoteSupportUIPendingLoginStatus = "repaired_ui_pending_login"
	remoteSupportUILaunchFailedStatus = "ui_launch_failed"
)

type uiSessionCandidate struct {
	id      uint32
	active  bool
	hasUser bool
}

func selectInteractiveSession(candidates []uiSessionCandidate, consoleSession uint32) (uint32, bool) {
	for _, candidate := range candidates {
		if candidate.id == consoleSession && candidate.id != 0 && candidate.active && candidate.hasUser {
			return candidate.id, true
		}
	}
	for _, candidate := range candidates {
		if candidate.id != 0 && candidate.active && candidate.hasUser {
			return candidate.id, true
		}
	}
	return 0, false
}

func remoteSupportMainWindowSizeUsable(width, height int32) bool {
	return width >= 200 && height >= 120
}

func remoteSupportMainWindowRejectionReason(width, height int32) string {
	var reasons []string
	if width < 200 {
		reasons = append(reasons, fmt.Sprintf("width %d < 200", width))
	}
	if height < 120 {
		reasons = append(reasons, fmt.Sprintf("height %d < 120", height))
	}
	return strings.Join(reasons, "; ")
}
