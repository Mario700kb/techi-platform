package main

import (
	"strings"
	"testing"
)

// Source-level cover for two Linux action handlers whose real behaviour spawns
// processes or restarts the service, so it cannot be exercised in a unit test.
// Both encode a defect that reached production on 2026-08-05 (device 812).

func TestSelfUpdateUsesTheServerSuppliedPackage(t *testing.T) {
	// It used to call performSelfUpdate(&AgentUpdate{Available: false}) — doing
	// nothing while reporting "triggered", so the action sat in `running`
	// forever waiting for a version change that could never come.
	src := readAgentFile(t, "actions_linux.go")

	if strings.Contains(src, "Available: false") {
		t.Fatal("self_update must not hand performSelfUpdate an unavailable update")
	}
	for _, param := range []string{"download_url", "version", "sha256"} {
		if !strings.Contains(src, `stringParam(params, "`+param+`")`) {
			t.Fatalf("self_update must read %q from the action parameters, as Windows does", param)
		}
	}
	if !strings.Contains(src, "Available: true") {
		t.Fatal("a self_update with a download URL must be applied")
	}
	if !strings.Contains(src, `missing 'download_url' parameter`) {
		t.Fatal("a self_update without a URL must fail loudly, not silently no-op")
	}
}

func TestRestartAgentSurvivesTheSignalItCauses(t *testing.T) {
	// `systemctl restart techi-agent` SIGTERMs the agent itself. Running it
	// under the action context cancelled that context, killing the systemctl
	// child: the restart happened but the action reported "signal: terminated".
	src := readAgentFile(t, "actions_linux.go")

	start := strings.Index(src, "func handleRestartAgent")
	if start < 0 {
		t.Fatal("handleRestartAgent must exist")
	}
	body := src[start:]
	if end := strings.Index(body, "\nfunc "); end > 0 {
		body = body[:end]
	}

	if strings.Contains(body, "runLinuxCommand(ctx") {
		t.Fatal("the restart must not run under the action context — the SIGTERM it triggers cancels it")
	}
	if !strings.Contains(body, "Setsid: true") {
		t.Fatal("the restart must be detached into its own session so it outlives the agent")
	}
	if !strings.Contains(body, "sleep 3") {
		t.Fatal("the restart must be delayed so the completion callback is sent before systemd stops us")
	}
	if !strings.Contains(body, "restart scheduled") {
		t.Fatal("the handler must report success; it cannot report anything after the restart lands")
	}
}
