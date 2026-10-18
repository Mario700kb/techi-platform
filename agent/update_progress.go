package main

// Self-update progress, shared by the Windows and Linux updaters.
//
// The operator watches a self_update live: the agent reports each stage to
// POST /api/v1/actions/{id}/progress with the OVERALL percentage, and the
// server adds the stages the agent cannot report itself (restarting when the
// command channel drops, confirming when it returns, completed when the
// heartbeat carries the new version).
//
//	downloading  5 → 80  (by bytes received)
//	verifying    85
//	installing   90
//	restarting   95      (also set server-side on channel loss)
//	confirming   97      (server-side only)
//	completed    100     (server-side, heartbeat verification)
//
// Progress reports are best-effort: they go out from their own goroutine with
// a short timeout, newer reports replace unsent older ones, and a dead server
// never slows the download. A failure is reported with Fail(reason) instead
// of only being logged, so the action no longer sits in "running" until the
// platform times it out.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	stageDownloading = "downloading"
	stageVerifying   = "verifying"
	stageInstalling  = "installing"
	stageRestarting  = "restarting"

	progressDownloadStart = 5
	progressDownloadEnd   = 80
	progressVerifying     = 85
	progressInstalling    = 90
	progressRestarting    = 95

	// percentUnknown omits "percent" from the report (unknown download size,
	// retry notices): the server keeps the bar where it is.
	percentUnknown = -1

	progressMessageMax  = 200
	progressPostTimeout = 5 * time.Second
	failPostTimeout     = 15 * time.Second
	reporterFlushWait   = 3 * time.Second

	selfUpdateDownloadAttempts       = 3
	selfUpdateDownloadTimeoutSeconds = 120

	// A download report goes out at most this often, and only when the
	// overall percentage moved by at least downloadReportMinStep.
	downloadReportInterval = time.Second
	downloadReportMinStep  = 2
)

// selfUpdateRetryDelay is the pause before download attempt n+1; a variable
// so tests do not wait 45 s.
var selfUpdateRetryDelay = func(attempt int) time.Duration {
	return time.Duration(attempt*15) * time.Second
}

// updateReporter receives a self-update's progress. The updater accepts a nil
// reporter (heartbeat-triggered updates have no action to report to).
type updateReporter interface {
	Progress(stage string, percent int, message string)
	Fail(reason string)
	// Flush waits, at most timeout, until queued progress has been sent.
	Flush(timeout time.Duration)
}

func reportProgress(rep updateReporter, stage string, percent int, message string) {
	if rep != nil {
		rep.Progress(stage, percent, message)
	}
}

func flushReporter(rep updateReporter, timeout time.Duration) {
	if rep != nil {
		rep.Flush(timeout)
	}
}

// ------------------------------------------------------------------ //
// Reporter bound to one remote action                                  //
// ------------------------------------------------------------------ //

type actionReporterKey struct{}

// withActionReporter is how runAction hands a handler the reporter for its
// action without changing every handler's signature.
func withActionReporter(ctx context.Context, rep *actionReporter) context.Context {
	return context.WithValue(ctx, actionReporterKey{}, rep)
}

// actionReporterFrom returns the action's reporter, or a nil interface when
// the context carries none.
func actionReporterFrom(ctx context.Context) updateReporter {
	if ctx == nil {
		return nil
	}
	if rep, ok := ctx.Value(actionReporterKey{}).(*actionReporter); ok && rep != nil {
		return rep
	}
	return nil
}

type progressReport struct {
	Stage   string `json:"stage"`
	Percent *int   `json:"percent,omitempty"`
	Message string `json:"message,omitempty"`
}

type actionReporter struct {
	id   int
	post func(path string, body interface{}, timeout time.Duration) error

	mu      sync.Mutex
	pending *progressReport
	sending bool
	failed  bool
}

func newActionReporter(cfg *Config, actionID int, secret string) *actionReporter {
	return &actionReporter{
		id: actionID,
		post: func(path string, body interface{}, timeout time.Duration) error {
			return postActionEndpointTimeout(cfg, path, body, secret, timeout)
		},
	}
}

// Progress queues a report and returns at once. A report not yet sent is
// replaced by a newer one: the server only needs the latest state.
func (r *actionReporter) Progress(stage string, percent int, message string) {
	if r == nil {
		return
	}
	rep := &progressReport{Stage: stage, Message: truncateProgressMessage(message)}
	if percent >= 0 {
		p := percent
		if p > 100 {
			p = 100
		}
		rep.Percent = &p
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failed {
		return
	}
	r.pending = rep
	if !r.sending {
		r.sending = true
		go r.drain()
	}
}

func (r *actionReporter) drain() {
	path := fmt.Sprintf("/api/v1/actions/%d/progress", r.id)
	for {
		r.mu.Lock()
		rep := r.pending
		r.pending = nil
		if rep == nil {
			r.sending = false
			r.mu.Unlock()
			return
		}
		r.mu.Unlock()
		if err := r.post(path, rep, progressPostTimeout); err != nil {
			log.Printf("[self_update] action %d: progress report failed (non-fatal): %v", r.id, err)
		}
	}
}

func (r *actionReporter) Flush(timeout time.Duration) {
	if r == nil {
		return
	}
	deadline := time.Now().Add(timeout)
	for {
		r.mu.Lock()
		idle := !r.sending && r.pending == nil
		r.mu.Unlock()
		if idle || time.Now().After(deadline) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Fail reports the action failed with reason. Later progress is dropped.
func (r *actionReporter) Fail(reason string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	if r.failed {
		r.mu.Unlock()
		return
	}
	r.failed = true
	r.pending = nil
	r.mu.Unlock()
	// Let a report already on the wire land first so it cannot arrive after
	// the failure (the server would refuse it anyway).
	r.Flush(reporterFlushWait)
	body := map[string]string{"error_message": reason, "stderr_output": ""}
	if err := r.post(fmt.Sprintf("/api/v1/actions/%d/fail", r.id), body, failPostTimeout); err != nil {
		log.Printf("[self_update] action %d: fail report error: %v", r.id, err)
	}
}

func truncateProgressMessage(message string) string {
	message = strings.TrimSpace(message)
	if len(message) <= progressMessageMax {
		return message
	}
	cut := progressMessageMax - 3
	// Do not split a UTF-8 sequence.
	for cut > 0 && message[cut]&0xC0 == 0x80 {
		cut--
	}
	return message[:cut] + "..."
}

// ------------------------------------------------------------------ //
// The update pipeline                                                  //
// ------------------------------------------------------------------ //

// runSelfUpdate downloads update.URL to dest, verifies the SHA-256 and calls
// install(dest). Every failure is reported through rep.Fail and returned.
// Progress runs downloading → verifying → installing; the caller reports
// restarting once install has handed off.
func runSelfUpdate(update *AgentUpdate, rep updateReporter, dest string, install func(string) error) error {
	fail := func(reason string) error {
		log.Printf("[self_update] %s", reason)
		if rep != nil {
			rep.Fail(reason)
		}
		return errors.New(reason)
	}

	reportProgress(rep, stageDownloading, progressDownloadStart, fmt.Sprintf("Downloading v%s", update.Version))
	if err := downloadWithRetries(update.URL, dest, rep); err != nil {
		return fail(err.Error())
	}

	reportProgress(rep, stageVerifying, progressVerifying, "Verifying the download (SHA-256)")
	if want := strings.ToLower(strings.TrimSpace(update.Checksum)); want != "" {
		got, err := fileSHA256Hex(dest)
		if err != nil || got != want {
			_ = os.Remove(dest)
			if err != nil {
				return fail(fmt.Sprintf("checksum mismatch: cannot read the download: %v", err))
			}
			return fail(fmt.Sprintf("checksum mismatch (expected %s, got %s)", shortSHA(want), shortSHA(got)))
		}
		log.Printf("[self_update] checksum verified")
	}

	reportProgress(rep, stageInstalling, progressInstalling, fmt.Sprintf("Installing v%s", update.Version))
	// The install hands off to a swap that stops this process: make sure the
	// server has heard "installing" before that.
	flushReporter(rep, reporterFlushWait)
	if err := install(dest); err != nil {
		return fail(fmt.Sprintf("swap could not start: %v", err))
	}
	return nil
}

func shortSHA(sum string) string {
	if len(sum) > 12 {
		return sum[:12]
	}
	return sum
}

func downloadWithRetries(url, dest string, rep updateReporter) error {
	onProgress := func(percent int, message string) {
		reportProgress(rep, stageDownloading, percent, message)
	}
	var lastErr error
	for attempt := 1; attempt <= selfUpdateDownloadAttempts; attempt++ {
		err := downloadWithProgress(url, dest, selfUpdateDownloadTimeoutSeconds, time.Now, onProgress)
		if err == nil {
			return nil
		}
		lastErr = err
		if attempt < selfUpdateDownloadAttempts {
			delay := selfUpdateRetryDelay(attempt)
			log.Printf("[self_update] download attempt %d failed: %v; retrying in %s", attempt, err, delay)
			reportProgress(rep, stageDownloading, percentUnknown,
				fmt.Sprintf("Download attempt %d of %d failed: %v; retrying in %s", attempt, selfUpdateDownloadAttempts, err, delay))
			time.Sleep(delay)
		}
	}
	return fmt.Errorf("download failed after %d attempts: %w", selfUpdateDownloadAttempts, lastErr)
}

// downloadWithProgress streams url into dest, calling onProgress with the
// overall percentage (percentUnknown when the size is unknown) and a plain
// message, throttled by downloadTracker, and once more when complete.
func downloadWithProgress(url, dest string, timeoutSeconds int, now func() time.Time, onProgress func(int, string)) error {
	if timeoutSeconds <= 0 {
		timeoutSeconds = selfUpdateDownloadTimeoutSeconds
	}
	client := &http.Client{Timeout: time.Duration(timeoutSeconds) * time.Second}
	resp, err := client.Get(url) //nolint:noctx
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	tracker := newDownloadTracker(resp.ContentLength, now)
	buf := make([]byte, 32*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				return werr
			}
			if pct, msg, ok := tracker.add(int64(n)); ok && onProgress != nil {
				onProgress(pct, msg)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			return rerr
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	if tracker.total > 0 && tracker.done != tracker.total {
		return fmt.Errorf("short download: %d of %d bytes", tracker.done, tracker.total)
	}
	if onProgress != nil {
		pct, msg := tracker.final()
		onProgress(pct, msg)
	}
	return nil
}

// downloadTracker turns bytes received into throttled progress reports.
type downloadTracker struct {
	total   int64 // <= 0: unknown
	done    int64
	lastPct int
	lastAt  time.Time
	now     func() time.Time
}

func newDownloadTracker(total int64, now func() time.Time) *downloadTracker {
	if now == nil {
		now = time.Now
	}
	return &downloadTracker{total: total, lastPct: progressDownloadStart, lastAt: now(), now: now}
}

// downloadOverallPercent maps bytes received onto the 5–80 download band.
func downloadOverallPercent(done, total int64) int {
	if total <= 0 {
		return progressDownloadStart
	}
	if done >= total {
		return progressDownloadEnd
	}
	return progressDownloadStart + int(int64(progressDownloadEnd-progressDownloadStart)*done/total)
}

func (t *downloadTracker) add(n int64) (int, string, bool) {
	t.done += n
	now := t.now()
	if now.Sub(t.lastAt) < downloadReportInterval {
		return 0, "", false
	}
	if t.total > 0 {
		pct := downloadOverallPercent(t.done, t.total)
		if pct-t.lastPct < downloadReportMinStep {
			return 0, "", false
		}
		t.lastPct, t.lastAt = pct, now
		return pct, fmt.Sprintf("Downloading %d%% (%s of %s MB)",
			int(100*t.done/t.total), formatMB(t.done), formatMB(t.total)), true
	}
	t.lastAt = now
	return percentUnknown, fmt.Sprintf("Downloading (%s MB so far)", formatMB(t.done)), true
}

// final is the report for a completed download, whatever the throttle says.
func (t *downloadTracker) final() (int, string) {
	return progressDownloadEnd, fmt.Sprintf("Downloaded %s MB", formatMB(t.done))
}

func formatMB(bytes int64) string {
	return fmt.Sprintf("%.1f", float64(bytes)/(1024*1024))
}

func fileSHA256Hex(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
