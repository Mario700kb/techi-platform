import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import {
  createSshTerminalSession,
  createTerminalSession,
  getSshSessionDetail,
  SSH_FAILURE_MESSAGES,
  type SSHSessionCreateOptions,
  type TerminalSession,
} from "../api/terminal";

// Lazy-loaded (see DeviceDrawer) so xterm.js never ships on the main path — the
// flag-off bundle behavior is unchanged. Platform-independent: it drives the
// operator side of the relay; the agent side is provided by whatever platform
// adapter implements the terminal capability (Linux today) OR, in "ssh" mode
// (Embedded SSH Connect), by the backend itself acting as the SSH client —
// same websocket route, same xterm rendering, same reconnect/resize logic.

type Phase = "connecting" | "open" | "closed" | "error" | "reconnecting";

/** What a caller can do with an open console (the PowerShell command bar). */
export interface TerminalHandle {
  /** Send to the device as if typed; false when the socket is not open. */
  send: (data: string) => boolean;
  /** Close the socket: the operator ended the session. */
  close: () => void;
  focus: () => void;
}

export interface TerminalAppearance {
  theme: ITheme;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "bar" | "underline";
}

interface Props {
  deviceId: number;
  mode?: "agent" | "ssh";
  sshOptions?: SSHSessionCreateOptions;
  onSessionId?: (sessionId: string) => void;
  /** A session created by the caller (the administrator PowerShell, which
   *  needs a two-factor code first). The console attaches to it once and never
   *  opens a new one by itself: a new session needs a new code. */
  session?: TerminalSession;
  /** The attached session ended (operator, device, idle or time limit). */
  onClosed?: (message: string) => void;
  /** The console socket is open. */
  onOpen?: () => void;
  /** Bytes flowed either way; feeds the caller's idle countdown. */
  onActivity?: () => void;
  /** Hide the status strip while open (the caller draws its own header). */
  bare?: boolean;
  /** Own colours and font instead of the app theme's (the PowerShell console). */
  appearance?: TerminalAppearance;
  /** Written locally before connecting; never sent to the device. */
  banner?: string;
  /** OSC 0/2 title changes from the device (never drawn). */
  onTitleChange?: (title: string) => void;
  /** Filled while the console is mounted. */
  handleRef?: MutableRefObject<TerminalHandle | null>;
}

// WS close codes the backend never retries on its own — the session/ticket
// itself is invalid or the feature is off, so a brand-new session would fail
// identically. Auto-reconnect only makes sense for an abnormal network drop.
const NON_RETRYABLE_CODES = new Set([4001, 4003]);
const MAX_AUTO_RECONNECTS = 2;
const AUTO_RECONNECT_DELAY_MS = [1500, 3000];

// xterm paints on a canvas, so it needs resolved colour values, not var().
function themeToken(name: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
}

export default function DeviceTerminal({
  deviceId,
  mode = "agent",
  sshOptions,
  onSessionId,
  session: presetSession,
  onClosed,
  onOpen,
  onActivity,
  bare = false,
  appearance,
  banner,
  onTitleChange,
  handleRef,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [message, setMessage] = useState<string>("Requesting terminal session…");
  // Bumping this re-runs the connect effect — used for both the automatic
  // retry and the manual "Reconnect" button, so there is one connect path.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let onResize: (() => void) | null = null;
    let observer: ResizeObserver | null = null;
    let autoReconnects = 0;
    let sessionId: string | null = null;

    const connect = async () => {
      setPhase(attempt === 0 ? "connecting" : "reconnecting");
      setMessage(
        presetSession ? "Connecting to the console…" : attempt === 0 ? "Requesting terminal session…" : "Reconnecting…",
      );
      try {
        // Yield once: a mount that is torn down at once (React StrictMode)
        // must not spend a one-time ticket on a socket it closes straight away.
        await Promise.resolve();
        if (disposed) return;
        const session = presetSession
          ? presetSession
          : mode === "ssh"
            ? await createSshTerminalSession(deviceId, sshOptions)
            : await createTerminalSession(deviceId, "bash");
        if (disposed || !containerRef.current) return;
        sessionId = session.session_id;
        onSessionId?.(session.session_id);

        if (!term) {
          term = new Terminal(
            appearance
              ? { ...appearance, cursorBlink: true }
              : {
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 13,
                  theme: {
                    background: themeToken("--th-bg-card"),
                    foreground: themeToken("--th-text-primary"),
                    cursor: themeToken("--th-accent"),
                  },
                  cursorBlink: true,
                },
          );
          fit = new FitAddon();
          term.loadAddon(fit);
          term.open(containerRef.current);
          fit.fit();
          if (banner) term.writeln(banner);
          if (onTitleChange) term.onTitleChange(onTitleChange);
          term.onData((data) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(data);
              onActivity?.();
            }
          });
        } else {
          // Reconnect got a fresh backend session (fresh shell — the prior
          // PTY was already torn down with the old connection); keep the
          // same terminal widget but make that visible to the operator.
          term.reset();
          term.writeln("\x1b[2m[reconnected — new session]\x1b[0m");
        }

        // The one-time operator ticket in the path authenticates this socket;
        // the session token stays out of the URL (and out of access logs).
        ws = new WebSocket(session.operator_ws_path);
        ws.binaryType = "arraybuffer";
        if (handleRef) {
          const socket = ws;
          const screen = term;
          handleRef.current = {
            send: (data) => {
              if (socket.readyState !== WebSocket.OPEN) return false;
              socket.send(data);
              onActivity?.();
              return true;
            },
            close: () => socket.close(),
            focus: () => screen.focus(),
          };
        }

        const sendResize = () => {
          if (!term || !ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
        };

        ws.onopen = () => {
          if (disposed) return;
          autoReconnects = 0;
          setPhase("open");
          setMessage("");
          sendResize();
          onOpen?.();
        };
        ws.onmessage = (ev) => {
          if (!term) return;
          onActivity?.();
          if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
          else term.write(ev.data as string);
        };
        ws.onclose = (ev) => {
          if (disposed) return;
          if (presetSession) {
            const text = ev.code === 4001 ? "The console ticket expired. Open a new session." : "Session ended.";
            setPhase("closed");
            setMessage(text);
            onClosed?.(text);
            return;
          }
          const retryable = !NON_RETRYABLE_CODES.has(ev.code);
          if (retryable && autoReconnects < MAX_AUTO_RECONNECTS) {
            const delay = AUTO_RECONNECT_DELAY_MS[autoReconnects] ?? 3000;
            autoReconnects += 1;
            setPhase("reconnecting");
            setMessage(`Connection lost — reconnecting (${autoReconnects}/${MAX_AUTO_RECONNECTS})…`);
            window.setTimeout(() => {
              if (!disposed) setAttempt((a) => a + 1);
            }, delay);
            return;
          }
          setPhase("closed");
          setMessage(
            ev.code === 4003
              ? "Web Terminal is not enabled."
              : ev.code === 4001
                ? "Terminal session expired."
                : "Terminal session closed.",
          );
          // Embedded SSH Connect: replace the generic message above with the
          // precise reason (credential missing / host unreachable /
          // authentication failed / etc.) when the backend recorded one —
          // best-effort, never blocks the UI if it fails.
          if (mode === "ssh" && sessionId) {
            const sid = sessionId;
            getSshSessionDetail(deviceId, sid)
              .then((detail) => {
                if (disposed || !detail.disconnect_reason) return;
                const friendly = SSH_FAILURE_MESSAGES[detail.disconnect_reason];
                if (friendly) setMessage(friendly);
              })
              .catch(() => {
                /* best-effort only */
              });
          }
        };
        ws.onerror = () => {
          if (disposed) return;
          setPhase("error");
          setMessage("Terminal connection failed.");
        };

        onResize = () => {
          fit?.fit();
          sendResize();
        };
        window.addEventListener("resize", onResize);
        // A caller-sized console (side panel, growing command bar, fullscreen)
        // changes size without the window resizing.
        if (presetSession && typeof ResizeObserver !== "undefined" && containerRef.current) {
          let frame = 0;
          const refit = onResize;
          observer = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(refit);
          });
          observer.observe(containerRef.current);
        }
      } catch (e) {
        if (disposed) return;
        setPhase("error");
        setMessage(e instanceof Error ? e.message : "Failed to open terminal.");
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (onResize) window.removeEventListener("resize", onResize);
      observer?.disconnect();
      if (handleRef) handleRef.current = null;
      try {
        ws?.close();
      } catch {
        /* noop */
      }
      try {
        term?.dispose();
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, attempt]);

  const canManualReconnect = !presetSession && (phase === "closed" || phase === "error");

  return (
    <div className={bare ? "flex h-full min-h-0 flex-col gap-2" : "flex h-full min-h-[320px] flex-col gap-2"}>
      {phase !== "open" && (!bare || phase === "error") && (
        <div
          className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-xs"
          style={{
            color: phase === "error" ? "var(--th-status-critical)" : "var(--th-text-secondary)",
            background: "var(--th-bg-drawer-section)",
            border: "1px solid var(--th-border-drawer-section)",
          }}
        >
          <span>{message}</span>
          {canManualReconnect && (
            <button
              type="button"
              onClick={() => setAttempt((a) => a + 1)}
              className="rounded px-2 py-1 text-xs font-medium"
              style={{ background: "var(--th-accent)", color: "var(--th-on-accent)" }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        data-testid="terminal-screen"
        className={bare ? "min-h-0 flex-1 overflow-hidden p-2" : "min-h-[300px] flex-1 overflow-hidden rounded-lg p-2"}
        style={
          bare
            ? { background: appearance?.theme.background ?? "var(--th-bg-card)" }
            : { background: "var(--th-bg-card)", border: "1px solid var(--th-border-drawer-section)" }
        }
      />
    </div>
  );
}
