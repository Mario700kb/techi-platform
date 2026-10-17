//go:build windows

package main

import (
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
	if _, err := pc.input.Write([]byte("Write-Output ('techi-' + 'console-ok')\r")); err != nil {
		t.Fatal(err)
	}
	var seen strings.Builder
	deadline := time.After(60 * time.Second)
	for !strings.Contains(seen.String(), "techi-console-ok") {
		select {
		case chunk, ok := <-out:
			if !ok {
				t.Fatalf("console closed before the output; got %q", seen.String())
			}
			seen.WriteString(chunk)
		case <-deadline:
			t.Fatalf("no output within 60 s; got %q", seen.String())
		}
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
