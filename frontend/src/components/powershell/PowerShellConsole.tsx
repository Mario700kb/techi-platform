import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, Maximize2, Minimize2, RotateCcw, Terminal as TerminalIcon } from "lucide-react";
import { listConsoleScripts, runConsoleScript, type ConsoleScript, type TerminalSession } from "../../api/terminal";
import { useCachedQuery } from "../../hooks/useCachedQuery";
import { useSessionStore } from "../../store/sessionStore";
import type { TerminalHandle } from "../DeviceTerminal";
import { downloadConsoleRecording } from "../consoleDownload";
import CommandBar, { toConsoleInput } from "./CommandBar";
import { CONSOLE_APPEARANCE } from "./consoleTheme";

// The drawer's console is ~85 columns at 13 px; a point smaller fits a typical
// PowerShell table (and the banner) without wrapping.
const COMPACT_APPEARANCE = { ...CONSOLE_APPEARANCE, fontSize: 12 };
import { clock } from "./parts";
import SavedScripts, { ScriptRunModal } from "./SavedScripts";
import ScriptLibrary from "./ScriptLibrary";
import SessionCommands from "./SessionCommands";
import SessionDetails from "./SessionDetails";
import "./powershell.css";
import { applySent, applyTitle, commandHistory, EMPTY_LOG, visibleCommands, type CommandLog } from "./titleMarker";

const DeviceTerminal = lazy(() => import("../DeviceTerminal"));

export const IDLE_LIMIT_S = 15 * 60;
export const MAX_LIMIT_S = 60 * 60;

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export type ConsoleState = "connecting" | "open" | "ended";

export interface PowerShellConsoleProps {
  deviceId: number;
  deviceName: string;
  clientName?: string | null;
  /** Who is signed in on the device (sees nothing of the console). */
  signedInUser?: string | null;
  osCaption?: string | null;
  session: TerminalSession;
  /** "window": the own window (fills it); "drawer": compact, in the device drawer. */
  layout: "window" | "drawer";
  /** The operator ended the session (the socket is already closed). */
  onEnd: () => void;
  /** Start again after the session ended (asks for a new code). */
  onNewSession: () => void;
  /** The session ended by itself (device, idle or time limit). */
  onClosed?: () => void;
  /** A command brought from an alert: typed into the command bar, not run. */
  initialCommand?: string | null;
}

/**
 * The administrator PowerShell: header (who, what, recording, idle countdown),
 * the console with a command bar, and the session side panel (details, saved
 * scripts, this session's commands). One component for the own window and
 * the device drawer.
 */
export default function PowerShellConsole({
  deviceId,
  deviceName,
  clientName,
  signedInUser,
  osCaption,
  session,
  layout,
  onEnd,
  onNewSession,
  onClosed,
  initialCommand,
}: PowerShellConsoleProps) {
  const { user } = useSessionStore();
  const compact = layout === "drawer";
  const [state, setState] = useState<ConsoleState>("connecting");
  const [endedText, setEndedText] = useState("");
  const endedRef = useRef(false);
  const [startedAt] = useState(() => Date.now());
  const handle = useRef<TerminalHandle | null>(null);
  const [log, setLog] = useState<CommandLog>(EMPTY_LOG);
  const [runScript, setRunScript] = useState<ConsoleScript | null>(null);
  const [library, setLibrary] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const operator = user ? { username: user.username, role: user.role } : null;
  const [banner] = useState(
    () =>
      `\x1b[90mSession started by ${operator?.username ?? "you"} at ${clock(startedAt, true)} after a 2FA code` +
      `${osCaption ? ` · ${osCaption}` : ""}\x1b[0m`,
  );

  // Idle and hard limits, counted locally from the last byte either way.
  const lastActivity = useRef(startedAt);
  const [left, setLeft] = useState({ idle: IDLE_LIMIT_S, max: MAX_LIMIT_S });
  useEffect(() => {
    if (state === "ended") return;
    const tick = () => {
      const now = Date.now();
      setLeft({
        idle: IDLE_LIMIT_S - (now - lastActivity.current) / 1000,
        max: MAX_LIMIT_S - (now - startedAt) / 1000,
      });
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [state, startedAt]);
  const countdown = left.idle <= left.max ? `idle closes in ${mmss(left.idle)}` : `closes in ${mmss(left.max)}`;

  const onOpen = useCallback(() => {
    if (!endedRef.current) setState("open");
  }, []);
  const onActivity = useCallback(() => {
    lastActivity.current = Date.now();
  }, []);
  const onTitleChange = useCallback((title: string) => setLog((l) => applyTitle(l, title)), []);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const onSocketClosed = useCallback((text: string) => {
    if (endedRef.current) return;
    endedRef.current = true;
    setState("ended");
    setEndedText(text);
    onClosedRef.current?.();
  }, []);

  const endSession = () => {
    endedRef.current = true;
    handle.current?.close();
    setState("ended");
    setEndedText("Ended by you");
    onEnd();
  };

  const scripts = useCachedQuery<ConsoleScript[]>("mem.console.scripts", listConsoleScripts);
  const setScripts = scripts.setData;

  const commands = visibleCommands(log);
  const failed = commands.filter((c) => c.failed).length;
  const history = useMemo(() => commandHistory(log), [log]);
  const open = state === "open";

  const run = (text: string) => {
    if (handle.current?.send(toConsoleInput(text))) setLog((l) => applySent(l, text));
  };
  const interrupt = () => {
    handle.current?.send("\x03");
  };
  const runSaved = async (script: ConsoleScript) => {
    const result = await runConsoleScript(deviceId, session.session_id, script.id);
    if (!handle.current?.send(`${result.command}\r`)) throw new Error("The console is not connected.");
    const name = result.script?.name ?? script.name;
    setLog((l) => applySent(l, result.command, `Script · ${name}`));
    if (result.script) {
      setScripts((list) => list?.map((s) => (s.id === result.script.id ? { ...s, ...result.script } : s)));
    }
  };

  // Fullscreen: the console and its command bar.
  const workRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(workRef.current && document.fullscreenElement === workRef.current));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void workRef.current?.requestFullscreen?.().catch(() => setNotice("Fullscreen isn't available here."));
  };

  const download = () => {
    setNotice(null);
    downloadConsoleRecording(deviceId, session.session_id).catch(() =>
      setNotice("Couldn't download the transcript yet. Try again in a moment."),
    );
  };

  const subtitle = [clientName, `#${deviceId}`, "runs as NT AUTHORITY\\SYSTEM over the live channel"]
    .filter(Boolean)
    .join(" · ");

  const chip =
    state === "open" ? (
      <span className="ps-chip" data-tone="recording" title="Everything the console shows is recorded">
        <span className="ps-rec-dot" aria-hidden="true" />
        Recording
      </span>
    ) : state === "connecting" ? (
      <span className="ps-chip" data-tone="pending">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Connecting
      </span>
    ) : (
      <span className="ps-chip" data-tone="ended">
        Session ended
      </span>
    );
  const timer = state !== "ended" && <span className="ps-countdown">{countdown}</span>;
  const end = state !== "ended" && (
    <button type="button" className="ps-outline-btn" data-tone="danger" onClick={endSession}>
      End session
    </button>
  );
  const title = <h2 className="ps-title min-w-0 flex-1">{deviceName} · PowerShell (Administrator)</h2>;
  const sub = (
    <p className="ps-subtitle min-w-0 flex-1" title={subtitle}>
      {subtitle}
    </p>
  );

  // Drawer (720 px): two rows, so neither the title nor the subtitle is cut.
  const header = compact ? (
    <header className="ps-header" data-compact>
      <span className="ps-header-icon" aria-hidden="true">
        <TerminalIcon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {title}
          {chip}
          {end}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          {sub}
          {timer}
        </div>
      </div>
    </header>
  ) : (
    <header className="ps-header">
      <span className="ps-header-icon" aria-hidden="true">
        <TerminalIcon className="h-4 w-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        {title}
        {sub}
      </div>
      <div className="ps-header-actions">
        {chip}
        {timer}
        {end}
        <span className="ps-divider" aria-hidden="true" />
        <button
          type="button"
          className="ps-icon-btn"
          onClick={toggleFullscreen}
          aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
        <button
          type="button"
          className="ps-icon-btn"
          onClick={download}
          aria-label="Download transcript"
          title="Download transcript (.cast)"
        >
          <Download className="h-4 w-4" />
        </button>
      </div>
    </header>
  );

  const work = (
    <div ref={workRef} className="ps-work">
      <div className={compact ? "ps-screen h-[360px] flex-none" : "ps-screen min-h-0 flex-1"}>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center gap-2 text-[13px]" style={{ color: "#a1a1aa" }}>
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading console…
            </div>
          }
        >
          <DeviceTerminal
            key={session.session_id}
            deviceId={deviceId}
            session={session}
            bare
            appearance={compact ? COMPACT_APPEARANCE : CONSOLE_APPEARANCE}
            banner={banner}
            handleRef={handle}
            onOpen={onOpen}
            onActivity={onActivity}
            onClosed={onSocketClosed}
            onTitleChange={onTitleChange}
          />
        </Suspense>
      </div>
      {state === "ended" ? (
        <div className="ps-ended" role="status">
          <span className="min-w-0 flex-1 truncate">
            <strong>Session ended</strong>
            {endedText && endedText !== "Session ended." && <span className="ps-muted"> · {endedText}</span>}
          </span>
          <button type="button" className="ps-outline-btn" onClick={download}>
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download transcript
          </button>
          <button type="button" className="ps-outline-btn" data-tone="accent" onClick={onNewSession}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            New session
          </button>
        </div>
      ) : (
        <CommandBar
          history={history}
          disabled={!open}
          onRun={run}
          onInterrupt={interrupt}
          compact={compact}
          initialValue={initialCommand ?? ""}
        />
      )}
    </div>
  );

  const facts = {
    operator,
    startedAt,
    version: log.version,
    reported: log.reported,
    commands: commands.length,
    failed,
    signedInUser: signedInUser || null,
  };
  const saved = (className: string) => (
    <SavedScripts
      className={className}
      scripts={scripts.data}
      loading={scripts.loading}
      error={scripts.error}
      canRun={open}
      onRun={setRunScript}
      onOpenLibrary={() => setLibrary(true)}
    />
  );

  return (
    <div className="ps-root" data-layout={layout} data-state={state} data-testid="powershell-console">
      {compact ? (
        <>
          <div className="ps-frame">
            {header}
            {notice && (
              <p role="alert" className="ps-notice">
                {notice}
              </p>
            )}
            {work}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <SessionDetails facts={facts} className="ps-card" />
            {saved("ps-card")}
          </div>
          <SessionCommands commands={commands} className="ps-card mt-3" listClassName="max-h-[220px]" />
        </>
      ) : (
        <>
          {header}
          {notice && (
            <p role="alert" className="ps-notice">
              {notice}
            </p>
          )}
          <div className="ps-body">
            {work}
            <aside className="ps-side" aria-label="Session panel">
              <SessionDetails facts={facts} />
              {saved("")}
              <SessionCommands commands={commands} className="min-h-[160px] flex-1" />
            </aside>
          </div>
        </>
      )}

      {runScript && (
        <ScriptRunModal
          script={runScript}
          deviceName={deviceName}
          onRun={() => runSaved(runScript)}
          onClose={() => setRunScript(null)}
        />
      )}
      {library && (
        <ScriptLibrary
          scripts={scripts.data ?? []}
          onSaved={(s) =>
            setScripts((list) =>
              list?.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...(list ?? []), s],
            )
          }
          onDeleted={(id) => setScripts((list) => list?.filter((x) => x.id !== id))}
          onClose={() => setLibrary(false)}
        />
      )}
    </div>
  );
}
