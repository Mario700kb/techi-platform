package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeClock advances by step on every call, so each chunk read lands "later".
func fakeClock(step time.Duration) func() time.Time {
	var mu sync.Mutex
	t := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	return func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		t = t.Add(step)
		return t
	}
}

type report struct {
	stage   string
	percent int
	message string
}

type fakeReporter struct {
	mu      sync.Mutex
	reports []report
	fails   []string
}

func (f *fakeReporter) Progress(stage string, percent int, message string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reports = append(f.reports, report{stage, percent, message})
}

func (f *fakeReporter) Fail(reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fails = append(f.fails, reason)
}

func (f *fakeReporter) Flush(time.Duration) {}

func (f *fakeReporter) stages() []string {
	var out []string
	for _, r := range f.reports {
		if len(out) == 0 || out[len(out)-1] != r.stage {
			out = append(out, r.stage)
		}
	}
	return out
}

func noRetryDelay(t *testing.T) {
	t.Helper()
	prev := selfUpdateRetryDelay
	selfUpdateRetryDelay = func(int) time.Duration { return 0 }
	t.Cleanup(func() { selfUpdateRetryDelay = prev })
}

func TestDownloadOverallPercentMapsOntoTheDownloadBand(t *testing.T) {
	cases := []struct {
		done, total int64
		want        int
	}{
		{0, 100, 5},
		{50, 100, 42},
		{99, 100, 79},
		{100, 100, 80},
		{200, 100, 80},
		{10, 0, 5},
	}
	for _, c := range cases {
		if got := downloadOverallPercent(c.done, c.total); got != c.want {
			t.Errorf("downloadOverallPercent(%d, %d) = %d, want %d", c.done, c.total, got, c.want)
		}
	}
}

func TestDownloadTrackerThrottlesByTimeAndStep(t *testing.T) {
	base := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	now := base
	tr := newDownloadTracker(1000, func() time.Time { return now })

	now = base.Add(500 * time.Millisecond)
	if _, _, ok := tr.add(500); ok {
		t.Fatal("must not report within a second of the start")
	}
	now = base.Add(1100 * time.Millisecond)
	pct, msg, ok := tr.add(10) // 510 of 1000 bytes
	if !ok || pct != 43 {
		t.Fatalf("after a second: got (%d, %v), want 43", pct, ok)
	}
	if msg != "Downloading 51% (0.0 of 0.0 MB)" {
		t.Fatalf("message %q", msg)
	}
	now = base.Add(2500 * time.Millisecond)
	if _, _, ok := tr.add(10); ok { // 520 → 44: moved by 1 only
		t.Fatal("must not report a change below 2 points")
	}
	now = base.Add(2600 * time.Millisecond)
	if pct, _, ok := tr.add(30); !ok || pct != 46 { // 550 → 46
		t.Fatalf("got (%d, %v), want 46", pct, ok)
	}
	now = base.Add(3000 * time.Millisecond)
	if _, _, ok := tr.add(400); ok { // big jump, but under a second since the last report
		t.Fatal("must not report twice within a second")
	}
	pct, msg = tr.final()
	if pct != 80 || !strings.HasPrefix(msg, "Downloaded ") {
		t.Fatalf("final = (%d, %q)", pct, msg)
	}
}

func TestDownloadTrackerUnknownLengthOmitsPercent(t *testing.T) {
	base := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	now := base
	tr := newDownloadTracker(-1, func() time.Time { return now })
	now = base.Add(1500 * time.Millisecond)
	pct, msg, ok := tr.add(3 * 1024 * 1024)
	if !ok || pct != percentUnknown {
		t.Fatalf("got (%d, %v), want percentUnknown", pct, ok)
	}
	if msg != "Downloading (3.0 MB so far)" {
		t.Fatalf("message %q", msg)
	}
}

func TestDownloadWithProgressReportsKnownLength(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), 2*1024*1024)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		for off := 0; off < len(payload); off += 64 * 1024 {
			_, _ = w.Write(payload[off : off+64*1024])
		}
	}))
	defer srv.Close()

	var got []report
	dest := filepath.Join(t.TempDir(), "agent.bin")
	err := downloadWithProgress(srv.URL, dest, 10, fakeClock(400*time.Millisecond), func(p int, m string) {
		got = append(got, report{stageDownloading, p, m})
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) < 3 {
		t.Fatalf("want several reports, got %v", got)
	}
	last := got[len(got)-1]
	if last.percent != 80 || last.message != "Downloaded 2.0 MB" {
		t.Fatalf("last report %+v", last)
	}
	prev := progressDownloadStart
	for _, r := range got[:len(got)-1] {
		if r.percent < prev+downloadReportMinStep || r.percent > 80 {
			t.Fatalf("report %+v after %d breaks the 2-point step or the 5–80 band", r, prev)
		}
		if !strings.HasPrefix(r.message, "Downloading ") || !strings.HasSuffix(r.message, " of 2.0 MB)") {
			t.Fatalf("message %q", r.message)
		}
		prev = r.percent
	}
	data, _ := os.ReadFile(dest)
	if !bytes.Equal(data, payload) {
		t.Fatal("downloaded file differs")
	}
}

func TestDownloadWithProgressReportsUnknownLength(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		chunk := bytes.Repeat([]byte("y"), 256*1024)
		for i := 0; i < 8; i++ { // chunked: no Content-Length
			_, _ = w.Write(chunk)
			w.(http.Flusher).Flush()
		}
	}))
	defer srv.Close()

	var got []report
	dest := filepath.Join(t.TempDir(), "agent.bin")
	if err := downloadWithProgress(srv.URL, dest, 10, fakeClock(2*time.Second), func(p int, m string) {
		got = append(got, report{stageDownloading, p, m})
	}); err != nil {
		t.Fatal(err)
	}
	if len(got) < 2 {
		t.Fatalf("want progress and a final report, got %v", got)
	}
	for _, r := range got[:len(got)-1] {
		if r.percent != percentUnknown || !strings.Contains(r.message, "MB so far") {
			t.Fatalf("unknown-length report %+v must omit the percent and give bytes", r)
		}
	}
	if last := got[len(got)-1]; last.percent != 80 || last.message != "Downloaded 2.0 MB" {
		t.Fatalf("last report %+v", last)
	}
}

func agentServer(t *testing.T, payload []byte, status int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		_, _ = w.Write(payload)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func TestRunSelfUpdateReportsEveryStageAndInstalls(t *testing.T) {
	payload := []byte("new agent binary")
	srv := agentServer(t, payload, http.StatusOK)
	dest := filepath.Join(t.TempDir(), "techi-agent.new")
	rep := &fakeReporter{}
	var installed string
	err := runSelfUpdate(&AgentUpdate{Available: true, Version: "2.1.32", URL: srv.URL, Checksum: strings.ToUpper(sha256Hex(payload))},
		rep, dest, func(p string) error { installed = p; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if installed != dest {
		t.Fatalf("install got %q", installed)
	}
	if got := strings.Join(rep.stages(), ","); got != "downloading,verifying,installing" {
		t.Fatalf("stages %s", got)
	}
	if rep.reports[0].percent != 5 {
		t.Fatalf("first report %+v", rep.reports[0])
	}
	want := map[string]int{"verifying": 85, "installing": 90}
	for _, r := range rep.reports {
		if p, ok := want[r.stage]; ok && r.percent != p {
			t.Fatalf("%s reported %d, want %d", r.stage, r.percent, p)
		}
	}
	if len(rep.fails) != 0 {
		t.Fatalf("unexpected Fail %v", rep.fails)
	}
}

func TestRunSelfUpdateDownloadFailureCallsFail(t *testing.T) {
	noRetryDelay(t)
	srv := agentServer(t, nil, http.StatusNotFound)
	rep := &fakeReporter{}
	installCalled := false
	err := runSelfUpdate(&AgentUpdate{Available: true, Version: "2.1.32", URL: srv.URL},
		rep, filepath.Join(t.TempDir(), "x"), func(string) error { installCalled = true; return nil })
	if err == nil || installCalled {
		t.Fatalf("err=%v installCalled=%v", err, installCalled)
	}
	if len(rep.fails) != 1 || rep.fails[0] != "download failed after 3 attempts: HTTP 404" {
		t.Fatalf("fails %v", rep.fails)
	}
	retries := 0
	for _, r := range rep.reports {
		if strings.HasPrefix(r.message, "Download attempt ") {
			retries++
			if r.percent != percentUnknown {
				t.Fatalf("a retry notice must not move the bar: %+v", r)
			}
		}
	}
	if retries != 2 {
		t.Fatalf("want 2 retry notices, got %d", retries)
	}
}

func TestRunSelfUpdateChecksumMismatchCallsFail(t *testing.T) {
	srv := agentServer(t, []byte("tampered"), http.StatusOK)
	dest := filepath.Join(t.TempDir(), "x")
	rep := &fakeReporter{}
	installCalled := false
	err := runSelfUpdate(&AgentUpdate{Available: true, Version: "2.1.32", URL: srv.URL, Checksum: sha256Hex([]byte("genuine"))},
		rep, dest, func(string) error { installCalled = true; return nil })
	if err == nil || installCalled {
		t.Fatalf("err=%v installCalled=%v", err, installCalled)
	}
	if len(rep.fails) != 1 || !strings.HasPrefix(rep.fails[0], "checksum mismatch") {
		t.Fatalf("fails %v", rep.fails)
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Fatal("a mismatching download must be removed")
	}
}

func TestRunSelfUpdateSwapFailureCallsFail(t *testing.T) {
	srv := agentServer(t, []byte("bin"), http.StatusOK)
	rep := &fakeReporter{}
	err := runSelfUpdate(&AgentUpdate{Available: true, Version: "2.1.32", URL: srv.URL},
		rep, filepath.Join(t.TempDir(), "x"), func(string) error { return errors.New("access denied") })
	if err == nil {
		t.Fatal("want an error")
	}
	if len(rep.fails) != 1 || rep.fails[0] != "swap could not start: access denied" {
		t.Fatalf("fails %v", rep.fails)
	}
}

func TestRunSelfUpdateWithoutReporter(t *testing.T) {
	noRetryDelay(t)
	srv := agentServer(t, []byte("bin"), http.StatusOK)
	if err := runSelfUpdate(&AgentUpdate{Available: true, Version: "2.1.32", URL: srv.URL}, nil,
		filepath.Join(t.TempDir(), "x"), func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	bad := agentServer(t, nil, http.StatusInternalServerError)
	if err := runSelfUpdate(&AgentUpdate{Available: true, Version: "2.1.32", URL: bad.URL}, nil,
		filepath.Join(t.TempDir(), "y"), func(string) error { return nil }); err == nil {
		t.Fatal("want the download error")
	}
	var nilRep *actionReporter
	nilRep.Progress(stageDownloading, 10, "x")
	nilRep.Fail("x")
	nilRep.Flush(time.Millisecond)
}

type callback struct {
	path   string
	secret string
	body   map[string]interface{}
}

func callbackServer(t *testing.T) (*httptest.Server, func() []callback) {
	t.Helper()
	var mu sync.Mutex
	var calls []callback
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]interface{}
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		calls = append(calls, callback{r.URL.Path, r.Header.Get("X-Callback-Secret"), body})
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv, func() []callback {
		mu.Lock()
		defer mu.Unlock()
		return append([]callback(nil), calls...)
	}
}

func TestActionReporterPostsProgressAndFail(t *testing.T) {
	srv, calls := callbackServer(t)
	rep := newActionReporter(&Config{APIURL: srv.URL, TimeoutSeconds: 5}, 7, "s3cret")

	rep.Progress(stageDownloading, 42, "Downloading 49% (3.1 of 6.3 MB)")
	rep.Flush(2 * time.Second)
	rep.Progress(stageDownloading, percentUnknown, strings.Repeat("é", 300))
	rep.Flush(2 * time.Second)
	rep.Fail("checksum mismatch")
	rep.Progress(stageVerifying, 85, "after the failure")
	rep.Flush(2 * time.Second)

	got := calls()
	if len(got) != 3 {
		t.Fatalf("want 2 progress + 1 fail, got %+v", got)
	}
	for _, c := range got {
		if c.secret != "s3cret" {
			t.Fatalf("missing callback secret on %s", c.path)
		}
	}
	if got[0].path != "/api/v1/actions/7/progress" || got[0].body["stage"] != "downloading" || got[0].body["percent"] != float64(42) {
		t.Fatalf("first call %+v", got[0])
	}
	if _, has := got[1].body["percent"]; has {
		t.Fatalf("an unknown percent must be omitted: %+v", got[1].body)
	}
	if msg, _ := got[1].body["message"].(string); len(msg) > progressMessageMax || !strings.HasSuffix(msg, "...") {
		t.Fatalf("message not truncated to %d bytes: %d", progressMessageMax, len(msg))
	}
	if got[2].path != "/api/v1/actions/7/fail" || got[2].body["error_message"] != "checksum mismatch" {
		t.Fatalf("fail call %+v", got[2])
	}
}

func TestActionReporterCoalescesWhileAPostIsInFlight(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	var sent []string
	rep := &actionReporter{id: 1, post: func(_ string, body interface{}, _ time.Duration) error {
		r := body.(*progressReport)
		mu.Lock()
		sent = append(sent, r.Message)
		first := len(sent) == 1
		mu.Unlock()
		if first {
			<-release
		}
		return nil
	}}
	rep.Progress(stageDownloading, 10, "a")
	time.Sleep(50 * time.Millisecond) // "a" is on the wire
	rep.Progress(stageDownloading, 20, "b")
	rep.Progress(stageDownloading, 30, "c")
	close(release)
	rep.Flush(2 * time.Second)
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(sent, ",") != "a,c" {
		t.Fatalf("sent %v, want a,c", sent)
	}
}

func TestActionReporterFromContext(t *testing.T) {
	if actionReporterFrom(context.Background()) != nil {
		t.Fatal("no reporter in a bare context")
	}
	rep := &actionReporter{id: 3}
	if got := actionReporterFrom(withActionReporter(context.Background(), rep)); got != rep {
		t.Fatalf("got %v", got)
	}
	if actionReporterFrom(withActionReporter(context.Background(), nil)) != nil {
		t.Fatal("a nil reporter must come back as a nil interface")
	}
}
