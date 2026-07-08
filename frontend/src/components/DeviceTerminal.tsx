import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { createTerminalSession } from "../api/terminal";
import { getAuthToken } from "../api/client";

// Lazy-loaded (see DeviceDrawer) so xterm.js never ships on the main path — the
// flag-off bundle behavior is unchanged. Platform-independent: it drives the
// operator side of the relay; the agent side is provided by whatever platform
// adapter implements the terminal capability (Linux today).

type Phase = "connecting" | "open" | "closed" | "error";

interface Props {
  deviceId: number;
}

export default function DeviceTerminal({ deviceId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [message, setMessage] = useState<string>("Requesting terminal session…");

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let onResize: (() => void) | null = null;

    (async () => {
      try {
        const session = await createTerminalSession(deviceId, "bash");
        if (disposed || !containerRef.current) return;

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

        // Token is passed as a query param (WebSocket has no header support);
        // the operator ticket already scopes this to one session.
        const token = getAuthToken();
        const url = session.operator_ws_path + (token ? `&auth=${encodeURIComponent(token)}` : "");
        ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
          if (disposed) return;
          setPhase("open");
          setMessage("");
          sendResize();
        };
        ws.onmessage = (ev) => {
          if (!term) return;
          if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
          else term.write(ev.data as string);
        };
        ws.onclose = () => {
          if (disposed) return;
          setPhase("closed");
          setMessage("Terminal session closed.");
        };
        ws.onerror = () => {
          if (disposed) return;
          setPhase("error");
          setMessage("Terminal connection failed.");
        };

        term.onData((data) => {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
        });

        const sendResize = () => {
          if (!term || !ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
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
    })();

    return () => {
      disposed = true;
      if (onResize) window.removeEventListener("resize", onResize);
      try { ws?.close(); } catch { /* noop */ }
      try { term?.dispose(); } catch { /* noop */ }
    };
  }, [deviceId]);

  return (
    <div className="flex h-full min-h-[320px] flex-col gap-2">
      {phase !== "open" && (
        <div
          className="rounded-md px-3 py-2 text-xs"
          style={{
            color: phase === "error" ? "#f87171" : "var(--th-text-secondary)",
            background: "var(--th-bg-drawer-section)",
            border: "1px solid var(--th-border-drawer-section)",
          }}
        >
          {message}
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
