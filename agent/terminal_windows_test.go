//go:build windows

package main

import (
	"encoding/base64"
	"regexp"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Starts a real PowerShell in a pseudo console, types a command, reads its
// output, and checks that closing the console ends the process.
func TestPowerShellRunsInAPseudoConsole(t *testing.T) {
	if !conPTYAvailable() {
		t.Skip("no pseudo console on this Windows")
	}
	pc, err := startPowerShell(120, 30)
	if err != nil {
		t.Fatal(err)
	}
	defer pc.close()

	out := make(chan string, 64)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := pc.output.Read(buf)
			if n > 0 {
				out <- string(buf[:n])
			}
			if err != nil {
				close(out)
				return
			}
		}
	}()

	pc.resize(160, 40)
	var seen strings.Builder
	waitFor := func(what string, ok func(string) bool) {
		t.Helper()
		deadline := time.After(60 * time.Second)
		for !ok(seen.String()) {
			select {
			case chunk, open := <-out:
				if !open {
					t.Fatalf("console closed while waiting for %s; got %q", what, seen.String())
				}
				seen.WriteString(chunk)
			case <-deadline:
				t.Fatalf("no %s within 60 s; got %q", what, seen.String())
			}
		}
	}
	// The TECHI prompt reports each command in the window title, which the
	// pseudo console forwards as OSC 0/2: techi;<ps>;<id>;<failed>;<ms>;<b64>.
	marker := regexp.MustCompile("\x1b\\](?:0|2);techi;([^;\x07\x1b]*);(\\d+);(\\d+);(\\d+);([A-Za-z0-9+/=]*)(?:\x07|\x1b\\\\)")
	command := func(id string) (failed string, cmd string, found bool) {
		for _, m := range marker.FindAllStringSubmatch(seen.String(), -1) {
			if m[2] == id {
				decoded, _ := base64.StdEncoding.DecodeString(m[5])
				return m[3], string(decoded), true
			}
		}
		return "", "", false
	}
	waitFor("the first prompt", func(s string) bool { return marker.MatchString(s) })

	ok := "Write-Output ('techi-' + 'console-ok')"
	if _, err := pc.input.Write([]byte(ok + "\r")); err != nil {
		t.Fatal(err)
	}
	waitFor("the command output", func(s string) bool { return strings.Contains(s, "techi-console-ok") })
	waitFor("the first command's marker", func(string) bool { _, _, f := command("1"); return f })
	if failed, cmd, _ := command("1"); failed != "0" || cmd != ok {
		t.Fatalf("marker for command 1: failed=%s cmd=%q", failed, cmd)
	}

	if _, err := pc.input.Write([]byte("Get-Item C:\\techi-no-such-path\r")); err != nil {
		t.Fatal(err)
	}
	waitFor("the failing command's marker", func(string) bool { _, _, f := command("2"); return f })
	if failed, _, _ := command("2"); failed != "1" {
		t.Fatalf("a failing command must be reported as failed, got %s", failed)
	}
	// The prompt colour is drawn, not printed as text.
	if strings.Contains(strings.ReplaceAll(seen.String(), "\x1b[38;2;110;168;254m", ""), "38;2;110;168;254m") {
		t.Fatalf("prompt colour printed as text: %q", seen.String())
	}

	process := pc.process
	var dup windows.Handle
	me := windows.CurrentProcess()
	if err := windows.DuplicateHandle(me, process, me, &dup, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(dup)
	done := make(chan struct{})
	go func() { pc.close(); close(done) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("closing the console hung")
	}
	if event, _ := windows.WaitForSingleObject(dup, 10_000); event != windows.WAIT_OBJECT_0 {
		t.Fatal("PowerShell kept running after the session closed")
	}
}

func TestPowerShellEncodedCommandIsUTF16Base64(t *testing.T) {
	if got := powershellEncoded("ab"); got != "YQBiAA==" {
		t.Fatalf("got %s", got)
	}
}
