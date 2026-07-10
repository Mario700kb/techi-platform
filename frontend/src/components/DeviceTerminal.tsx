import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import {
  createSshTerminalSession,
  createTerminalSession,
  getSshSessionDetail,
  SSH_FAILURE_MESSAGES,
  type SSHSessionCreateOptions,
} from "../api/terminal";
import { getAuthToken } from "../api/client";

// Lazy-loaded (see DeviceDrawer) so xterm.js never ships on the main path — the
// flag-off bundle behavior is unchanged. Platform-independent: it drives the
// operator side of the relay; the agent side is provided by whatever platform
// adapter implements the terminal capability (Linux today) OR, in "ssh" mode
// (Embedded SSH Connect), by the backend itself acting as the SSH client —
// same websocket route, same xterm rendering, same reconnect/resize logic.

type Phase = "connecting" | "open" | "closed" | "error" | "reconnecting";

interface Props {
  deviceId: number;
  mode?: "agent" | "ssh";
  sshOptions?: SSHSessionCreateOptions;
  onSessionId?: (sessionId: string) => void;
}

// WS close codes the backend never retries on its own — the session/ticket
// itself is invalid or the feature is off, so a brand-new session would fail
// identically. Auto-reconnect only makes sense for an abnormal network drop.
const NON_RETRYABLE_CODES = new Set([4001, 4003]);
const MAX_AUTO_RECONNECTS = 2;
const AUTO_RECONNECT_DELAY_MS = [1500, 3000];

export default function DeviceTerminal({ deviceId, mode = "agent", sshOptions, onSessionId }: Props) {
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
    let autoReconnects = 0;
    let sessionId: string | null = null;

    const connect = async () => {
      setPhase(attempt === 0 ? "connecting" : "reconnecting");
      setMessage(attempt === 0 ? "Requesting terminal session…" : "Reconnecting…");
      try {
        const session =
          mode === "ssh"
            ? await createSshTerminalSession(deviceId, sshOptions)
            : await createTerminalSession(deviceId, "bash");
        if (disposed || !containerRef.current) return;
        sessionId = session.session_id;
        onSessionId?.(session.session_id);

        if (!term) {
          term = new Terminal({
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 13,
            theme: { background: "#0B0B0D", foreground: "#F5F5F7" },
            cursorBlink: true,
          });
          fit = new FitAddon();
          term.loadAddon(fit);
          term.open(containerRef.current);
          fit.fit();
          term.onData((data) => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
          });
        } else {
          // Reconnect got a fresh backend session (fresh shell — the prior
          // PTY was already torn down with the old connection); keep the
          // same terminal widget but make that visible to the operator.
          term.reset();
          term.writeln("\x1b[2m[reconnected — new session]\x1b[0m");
        }

        // Token is passed as a query param (WebSocket has no header support);
        // the operator ticket already scopes this to one session.
        const token = getAuthToken();
        const url = session.operator_ws_path + (token ? `&auth=${encodeURIComponent(token)}` : "");
        ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";

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
        };
        ws.onmessage = (ev) => {
          if (!term) return;
          if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
          else term.write(ev.data as string);
        };
        ws.onclose = (ev) => {
          if (disposed) return;
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
              .catch(() => { /* best-effort only */ });
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
      try { ws?.close(); } catch { /* noop */ }
      try { term?.dispose(); } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, attempt]);

  const canManualReconnect = phase === "closed" || phase === "error";

  return (
    <div className="flex h-full min-h-[320px] flex-col gap-2">
      {phase !== "open" && (
        <div
          className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-xs"
          style={{
            color: phase === "error" ? "#f87171" : "var(--th-text-secondary)",
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
              style={{ background: "var(--th-accent)", color: "#fff" }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        className="min-h-[300px] flex-1 overflow-hidden rounded-lg p-2"
        style={{ background: "#0B0B0D", border: "1px solid var(--th-border-drawer-section)" }}
      />
    </div>
  );
}
