import { lazy, Suspense, useState } from "react";
import { Download, ExternalLink, PlaySquare, RotateCcw, Terminal as TerminalIcon } from "lucide-react";
import { listConsoleSessions, type ConsoleSessionSummary, type TerminalSession } from "../api/terminal";
import { formatDuration } from "../api/monitoring";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { formatLocalDateTime, parseUTC, timeAgo } from "../utils/time";
import { downloadConsoleRecording } from "./consoleDownload";
import { POWERSHELL_TERMS, PowerShellOpenModal } from "./PowerShellStepUp";
import PowerShellConsole from "./powershell/PowerShellConsole";
import { Button } from "./ui";

const ConsoleReplayModal = lazy(() => import("./ConsoleReplayModal"));

const END_REASON: Record<string, string> = {
  operator_closed: "Ended by operator",
  agent_gone: "Device disconnected",
  idle_timeout: "Closed after 15 min idle",
  max_duration: "Closed at the 60 min limit",
};

function sessionDuration(s: ConsoleSessionSummary): string {
  const from = s.started_at ?? s.created_at;
  if (!s.ended_at) return s.status === "active" ? "open" : "—";
  const seconds = Math.max(0, Math.round((parseUTC(s.ended_at).getTime() - parseUTC(from).getTime()) / 1000));
  return seconds < 60 ? `${seconds} s` : formatDuration(seconds);
}

function bytes(n: number | null): string {
  if (n == null) return "no recording";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function endReason(s: ConsoleSessionSummary): string {
  if (s.disconnect_reason) return END_REASON[s.disconnect_reason] ?? s.disconnect_reason.replace(/_/g, " ");
  if (s.status === "active") return "Open now";
  if (s.status === "pending") return "Never connected";
  return s.status.charAt(0).toUpperCase() + s.status.slice(1);
}

/**
 * Maintenance tab, Windows: the administrator PowerShell (opened with a fresh
 * two-factor code, recorded, closed by the platform after 15 min idle or 60
 * min) and the device's console history with replay and download.
 */
export default function DevicePowerShellPanel({
  deviceId,
  deviceName,
  clientName,
  currentUser,
  osCaption,
  capable,
  active,
  offline,
}: {
  deviceId: number;
  deviceName: string;
  clientName?: string | null;
  /** Who is signed in on the device. */
  currentUser?: string | null;
  osCaption?: string | null;
  /** The device reports the "powershell" capability (agent 2.1.29+). */
  capable: boolean;
  /** The Maintenance tab is showing; history loads on first show. */
  active: boolean;
  offline: boolean;
}) {
  const [askCode, setAskCode] = useState(false);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [endedText, setEndedText] = useState("");
  const [replay, setReplay] = useState<ConsoleSessionSummary | null>(null);

  const [historyFor, setHistoryFor] = useState(false);
  if (active && capable && !historyFor) setHistoryFor(true);
  const history = useCachedQuery<ConsoleSessionSummary[]>(
    historyFor ? `mem.device.${deviceId}.console-sessions` : null,
    () => listConsoleSessions(deviceId),
  );
  const reloadHistory = history.reload;

  const [downloadError, setDownloadError] = useState<string | null>(null);

  const onOpened = (s: TerminalSession) => {
    setEndedText("");
    setAskCode(false);
    setSession(s);
  };
  const endSession = () => {
    setSession(null);
    setEndedText("Ended by you");
    // The relay records the end when the socket closes; give it a moment.
    window.setTimeout(() => void reloadHistory(), 800);
  };

  const download = (sessionId: string) => {
    setDownloadError(null);
    downloadConsoleRecording(deviceId, sessionId).catch(() => setDownloadError("Couldn't download the recording."));
  };

  const openOwnWindow = () => {
    window.open(
      `/terminal/${deviceId}?engine=powershell&name=${encodeURIComponent(deviceName)}`,
      `techi-powershell-${deviceId}`,
      "popup,width=1100,height=720",
    );
  };

  const sessions = history.data ?? [];

  return (
    <section className="mb-4" aria-label="PowerShell">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="premium-kicker">PowerShell · Administrator</p>
        {capable && !session && (
          <button
            type="button"
            onClick={openOwnWindow}
            className="inline-flex items-center gap-1 text-[12px] font-medium"
            style={{ color: "var(--th-accent)" }}
          >
            Open in its own window
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {!capable ? (
        <div className="th-drawer-card">
          <p className="text-[13px]" style={{ color: "var(--th-text-muted)" }}>
            Needs agent 2.1.29 on Windows 10 1809 / Server 2019 or newer.
          </p>
        </div>
      ) : session ? (
        <PowerShellConsole
          key={session.session_id}
          layout="drawer"
          deviceId={deviceId}
          deviceName={deviceName}
          clientName={clientName}
          signedInUser={currentUser}
          osCaption={osCaption}
          session={session}
          onEnd={endSession}
          onNewSession={() => setAskCode(true)}
          onClosed={() => void reloadHistory()}
        />
      ) : (
        <div className="th-drawer-card">
          <div className="flex items-start gap-3">
            <span className="th-action-icon flex-none">
              <TerminalIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                Administrator console
              </p>
              <ul className="mt-1 space-y-0.5">
                {POWERSHELL_TERMS.map(({ text }) => (
                  <li key={text} className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                    {text}
                  </li>
                ))}
              </ul>
            </div>
            <Button
              size="sm"
              className="flex-none"
              onClick={() => setAskCode(true)}
              disabled={offline}
              title={offline ? "The device is offline" : undefined}
            >
              <TerminalIcon className="h-4 w-4" />
              Open PowerShell
            </Button>
          </div>
          {endedText && (
            <p className="mt-3 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              {endedText}
            </p>
          )}
        </div>
      )}

      {capable && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
              Console history
            </p>
            <button
              type="button"
              onClick={() => void reloadHistory()}
              className="th-icon-btn th-icon-btn-ghost !min-h-7 !min-w-7"
              title="Refresh console history"
              aria-label="Refresh console history"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="th-drawer-card !p-0">
            {history.loading ? (
              <div className="space-y-2 p-3" aria-hidden="true">
                {[0, 1].map((i) => (
                  <div
                    key={i}
                    className="h-10 animate-pulse rounded-md"
                    style={{ background: "var(--th-ring-track)", opacity: 0.6 }}
                  />
                ))}
              </div>
            ) : history.error && !history.data ? (
              <div className="flex items-center justify-between gap-3 p-3 text-[13px]">
                <span style={{ color: "var(--th-status-critical)" }}>Couldn't load console history.</span>
                <Button size="sm" variant="secondary" onClick={() => void reloadHistory()}>
                  Retry
                </Button>
              </div>
            ) : sessions.length === 0 ? (
              <p className="p-4 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                No console sessions on this device yet.
              </p>
            ) : (
              <ul aria-label="Console sessions">
                {sessions.map((s, i) => (
                  <li
                    key={s.session_id}
                    className="flex items-center gap-3 px-3 py-2.5"
                    style={i ? { borderTop: "1px solid var(--th-border-drawer-section)" } : undefined}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px]" style={{ color: "var(--th-text-primary)" }}>
                        <time dateTime={s.created_at} title={formatLocalDateTime(s.created_at)}>
                          {formatLocalDateTime(s.created_at)}
                        </time>
                        <span style={{ color: "var(--th-text-muted)" }}> · {s.operator_username ?? "unknown"}</span>
                      </p>
                      <p className="truncate text-[12px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
                        {sessionDuration(s)} · {endReason(s)} · {bytes(s.recording_bytes)}
                      </p>
                    </div>
                    <div className="flex flex-none items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="!min-h-7 !px-2"
                        disabled={s.recording_bytes == null}
                        onClick={() => setReplay(s)}
                        aria-label={`Replay session from ${timeAgo(s.created_at)}`}
                      >
                        <PlaySquare className="h-3.5 w-3.5" />
                        Replay
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="!min-h-7 !px-2"
                        disabled={s.recording_bytes == null}
                        onClick={() => download(s.session_id)}
                        aria-label={`Download session from ${timeAgo(s.created_at)}`}
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {downloadError && (
            <p role="alert" className="mt-2 text-[12px]" style={{ color: "var(--th-status-critical)" }}>
              {downloadError}
            </p>
          )}
        </div>
      )}

      {askCode && (
        <PowerShellOpenModal
          deviceId={deviceId}
          deviceName={deviceName}
          onOpened={onOpened}
          onClose={() => setAskCode(false)}
        />
      )}
      {replay && (
        <Suspense fallback={null}>
          <ConsoleReplayModal
            deviceId={deviceId}
            session={replay}
            subtitle={`${replay.operator_username ?? "unknown"} · ${formatLocalDateTime(replay.created_at)} · ${sessionDuration(replay)}`}
            onClose={() => setReplay(null)}
          />
        </Suspense>
      )}
    </section>
  );
}
