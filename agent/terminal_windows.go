//go:build windows

package main

// Administrator PowerShell console (2.1.29). The platform sends open_terminal
// (after the operator has passed a two-factor check); the agent dials the
// session's WebSocket and bridges it to powershell.exe running in a Windows
// pseudo console (ConPTY), so colours, line editing, tab completion and
// resizing behave like a local console.
//
// The console runs as the agent's service account (LocalSystem) — full rights
// on the device, which is what the operator asked for. Everything it prints
// is recorded by the platform; the platform closes an idle session after 15
// minutes and any session after an hour, and the agent ends its own side
// after an hour as well. Closing the session ends PowerShell and every
// process it started (job object, kill on close).
//
// ConPTY exists from Windows 10 1809 / Server 2019. Older systems do not
// report the capability, so the platform never offers the console there.

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/gorilla/websocket"
	"golang.org/x/sys/windows"
)

const (
	powershellSessionMax = 60 * time.Minute
	powershellCols       = 120
	powershellRows       = 30
)

var conPTYProc = windows.NewLazySystemDLL("kernel32.dll").NewProc("CreatePseudoConsole")

func conPTYAvailable() bool { return conPTYProc.Find() == nil }

func handleOpenTerminal(_ context.Context, _ *Config, params map[string]interface{}) actionResult {
	wsURL, _ := params["ws_url"].(string)
	if strings.TrimSpace(wsURL) == "" {
		return actionResult{err: fmt.Errorf("open_terminal: missing ws_url")}
	}
	if !conPTYAvailable() {
		return actionResult{err: fmt.Errorf("open_terminal: this Windows version has no pseudo console (Windows 10 1809 / Server 2019 or newer needed)")}
	}
	go runPowerShellSession(wsURL)
	return actionResult{message: "open_terminal: PowerShell session dialing"}
}

type pseudoConsole struct {
	hpc     windows.Handle
	input   *os.File // what we write: the console's keyboard
	output  *os.File // what we read: the console's screen
	process windows.Handle
	thread  windows.Handle
	job     windows.Handle
	once    sync.Once
}

// powershellInit gives the console the TECHI prompt and reports every command
// to the platform's console without printing anything: after each command
// the prompt sets the window title to
//
//	techi;<PowerShell version>;<history id>;<failed 0|1>;<milliseconds>;<command, base64 UTF-8>
//
// The pseudo console forwards title changes as an OSC 0 sequence, which the
// operator's terminal reads as the title and never draws. History id 0 means
// no command yet; a new id is a finished command (ids need not start at 1).
// Commands are cut to 400 characters.
const powershellInit = `$global:__techiLast = -1
function global:prompt {
  $ok = $?
  $id = 0; $fail = 0; $ms = 0; $b64 = ''
  $h = Get-History -Count 1
  if ($global:__techiLast -lt 0) {
    # First prompt: what history holds now is this start-up script itself.
    $global:__techiLast = if ($h) { $h.Id } else { 0 }
  } elseif ($h -and $h.Id -ne $global:__techiLast) {
    $global:__techiLast = $h.Id
    $id = $h.Id
    if (-not $ok) { $fail = 1 }
    $ms = [int]($h.EndExecutionTime - $h.StartExecutionTime).TotalMilliseconds
    $cmd = $h.CommandLine
    if ($cmd.Length -gt 400) { $cmd = $cmd.Substring(0, 400) }
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cmd))
  }
  $Host.UI.RawUI.WindowTitle = "techi;$($PSVersionTable.PSVersion);$id;$fail;$ms;$b64"
  $e = [char]27
  "$e[38;2;110;168;254mPS $($executionContext.SessionState.Path.CurrentLocation)>$e[0m "
}`

// powershellEncoded is the -EncodedCommand form: base64 of UTF-16LE.
func powershellEncoded(script string) string {
	units := utf16.Encode([]rune(script))
	raw := make([]byte, len(units)*2)
	for i, u := range units {
		binary.LittleEndian.PutUint16(raw[i*2:], u)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func powershellPath() string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	return root + `\System32\WindowsPowerShell\v1.0\powershell.exe`
}

// startPowerShell creates the pseudo console and starts PowerShell inside it,
// in a job that takes every child process down with it.
func startPowerShell(cols, rows int16) (*pseudoConsole, error) {
	var inRead, inWrite, outRead, outWrite windows.Handle
	if err := windows.CreatePipe(&inRead, &inWrite, nil, 0); err != nil {
		return nil, fmt.Errorf("input pipe: %w", err)
	}
	if err := windows.CreatePipe(&outRead, &outWrite, nil, 0); err != nil {
		windows.CloseHandle(inRead)
		windows.CloseHandle(inWrite)
		return nil, fmt.Errorf("output pipe: %w", err)
	}
	pc := &pseudoConsole{
		input:  os.NewFile(uintptr(inWrite), "conpty-in"),
		output: os.NewFile(uintptr(outRead), "conpty-out"),
	}
	err := windows.CreatePseudoConsole(windows.Coord{X: cols, Y: rows}, inRead, outWrite, 0, &pc.hpc)
	// The console holds its own copies of its ends of the pipes.
	windows.CloseHandle(inRead)
	windows.CloseHandle(outWrite)
	if err != nil {
		pc.input.Close()
		pc.output.Close()
		return nil, fmt.Errorf("pseudo console: %w", err)
	}

	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		pc.close()
		return nil, err
	}
	defer attrs.Delete()
	// The attribute's value is the console handle itself, not a pointer to it.
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, *(*unsafe.Pointer)(unsafe.Pointer(&pc.hpc)), unsafe.Sizeof(pc.hpc)); err != nil {
		pc.close()
		return nil, err
	}
	si := &windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	si.Cb = uint32(unsafe.Sizeof(*si))
	// A service's own (redirected) standard handles must not leak into the
	// console's process in place of the pseudo console.
	si.Flags = windows.STARTF_USESTDHANDLES

	cmdline, _ := windows.UTF16PtrFromString(`"` + powershellPath() + `" -NoLogo -NoExit -ExecutionPolicy Bypass -EncodedCommand ` + powershellEncoded(powershellInit))
	cwd := os.Getenv("SystemDrive")
	if cwd == "" {
		cwd = "C:"
	}
	cwdPtr, _ := windows.UTF16PtrFromString(cwd + `\`)
	var pi windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_SUSPENDED)
	if err := windows.CreateProcess(nil, cmdline, nil, nil, false, flags, nil, cwdPtr, &si.StartupInfo, &pi); err != nil {
		pc.close()
		return nil, fmt.Errorf("start PowerShell: %w", err)
	}
	pc.process, pc.thread = pi.Process, pi.Thread

	if job, err := windows.CreateJobObject(nil, nil); err == nil {
		info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err == nil {
			if windows.AssignProcessToJobObject(job, pi.Process) == nil {
				pc.job = job
			}
		}
		if pc.job == 0 {
			windows.CloseHandle(job)
		}
	}
	if _, err := windows.ResumeThread(pi.Thread); err != nil {
		pc.close()
		return nil, fmt.Errorf("resume PowerShell: %w", err)
	}
	return pc, nil
}

func (pc *pseudoConsole) resize(cols, rows int) {
	if cols > 0 && rows > 0 && cols < 1000 && rows < 1000 {
		_ = windows.ResizePseudoConsole(pc.hpc, windows.Coord{X: int16(cols), Y: int16(rows)})
	}
}

// close ends PowerShell and everything it started, then the console. Our end
// of the output pipe is closed before the console: on some Windows builds
// ClosePseudoConsole otherwise waits for someone to read what is left.
func (pc *pseudoConsole) close() {
	pc.once.Do(func() {
		if pc.job != 0 {
			windows.CloseHandle(pc.job) // kill on close: the whole tree
		} else if pc.process != 0 {
			_ = windows.TerminateProcess(pc.process, 1)
		}
		if pc.input != nil {
			pc.input.Close()
		}
		if pc.output != nil {
			pc.output.Close()
		}
		if pc.hpc != 0 {
			windows.ClosePseudoConsole(pc.hpc)
		}
		if pc.thread != 0 {
			windows.CloseHandle(pc.thread)
		}
		if pc.process != 0 {
			windows.CloseHandle(pc.process)
		}
	})
}

func runPowerShellSession(wsURL string) {
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		log.Printf("[powershell] dial failed: %v", err)
		return
	}
	defer conn.Close()

	pc, err := startPowerShell(powershellCols, powershellRows)
	if err != nil {
		log.Printf("[powershell] %v", err)
		_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\r\nPowerShell could not start on the device: "+err.Error()+"\r\n"))
		return
	}
	log.Printf("[powershell] session started")
	defer func() {
		pc.close()
		log.Printf("[powershell] session ended")
	}()

	var writeMu sync.Mutex
	send := func(data []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
		return conn.WriteMessage(websocket.BinaryMessage, data)
	}

	// The console's screen → operator.
	go func() {
		buf := make([]byte, 8192)
		for {
			n, err := pc.output.Read(buf)
			if n > 0 {
				if send(buf[:n]) != nil {
					_ = conn.Close()
					return
				}
			}
			if err != nil {
				if err != io.EOF {
					log.Printf("[powershell] console read: %v", err)
				}
				_ = conn.Close()
				return
			}
		}
	}()

	// PowerShell exits (the operator typed exit) → end the session.
	go func() {
		_, _ = windows.WaitForSingleObject(pc.process, windows.INFINITE)
		_ = conn.Close()
	}()

	// Hard cap, whatever the platform does.
	timer := time.AfterFunc(powershellSessionMax, func() { _ = conn.Close() })
	defer timer.Stop()

	// Operator keystrokes → the console; resize frames resize it.
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if msgType == websocket.TextMessage {
			if cols, rows, ok := parseResizeFrame(data); ok {
				pc.resize(cols, rows)
				continue
			}
		}
		if _, err := pc.input.Write(data); err != nil {
			return
		}
	}
}

// parseResizeFrame reads the terminal's {"t":"resize","cols":N,"rows":M}.
func parseResizeFrame(data []byte) (int, int, bool) {
	if !strings.Contains(string(data), `"resize"`) {
		return 0, 0, false
	}
	var frame struct {
		T    string `json:"t"`
		Cols int    `json:"cols"`
		Rows int    `json:"rows"`
	}
	if json.Unmarshal(data, &frame) != nil || frame.T != "resize" {
		return 0, 0, false
	}
	return frame.Cols, frame.Rows, true
}
