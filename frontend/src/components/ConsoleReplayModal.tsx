import { useEffect, useRef, useState } from "react";
import { Download, Pause, Play, PlaySquare } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { getConsoleRecording, type ConsoleSessionSummary } from "../api/terminal";
import { saveCast } from "./consoleDownload";
import { Button, Modal } from "./ui";

// Lazy-loaded (see DevicePowerShellPanel) so xterm.js only ships when a
// recording is opened.

export interface Cast {
  cols: number;
  rows: number;
  /** [seconds, kind, data]: "o" output, "r" resize ("COLSxROWS"). */
  events: Array<[number, string, string]>;
}

/** asciicast v2: one JSON header line, then one JSON event per line. */
export function parseCast(text: string): Cast {
  const lines = text.split("\n").filter((l) => l.trim());
  let cols = 80;
  let rows = 24;
  const events: Cast["events"] = [];
  lines.forEach((line, i) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (i === 0 && value && !Array.isArray(value) && typeof value === "object") {
      const header = value as { width?: number; height?: number };
      if (header.width) cols = header.width;
      if (header.height) rows = header.height;
      return;
    }
    if (Array.isArray(value) && value.length >= 3 && typeof value[0] === "number") {
      events.push([value[0], String(value[1]), String(value[2])]);
    }
  });
  return { cols, rows, events };
}

function themeToken(name: string): string | undefined {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
}

function resize(term: Terminal, data: string) {
  const m = /^(\d+)x(\d+)$/.exec(data);
  if (m) term.resize(Math.max(20, Number(m[1])), Math.max(5, Number(m[2])));
}

// Long pauses (someone reading, thinking) play back as one second.
const MAX_GAP_S = 1;

export default function ConsoleReplayModal({
  deviceId,
  session,
  subtitle,
  onClose,
}: {
  deviceId: number;
  session: ConsoleSessionSummary;
  subtitle: string;
  onClose: () => void;
}) {
  const screenRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const timerRef = useRef<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [cast, setCast] = useState<Cast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getConsoleRecording(deviceId, session.session_id)
      .then((body) => {
        if (cancelled) return;
        setText(body);
        setCast(parseCast(body));
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Could not load the recording."));
    return () => {
      cancelled = true;
    };
  }, [deviceId, session.session_id]);

  // Instant render: the whole recording as it ended.
  useEffect(() => {
    if (!cast || !screenRef.current) return;
    const term = new Terminal({
      cols: cast.cols,
      rows: cast.rows,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 10_000,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 12,
      theme: {
        background: themeToken("--th-bg-card"),
        foreground: themeToken("--th-text-primary"),
        cursor: themeToken("--th-bg-card"),
      },
    });
    term.open(screenRef.current);
    for (const [, kind, data] of cast.events) {
      if (kind === "o") term.write(data);
      else if (kind === "r") resize(term, data);
    }
    termRef.current = term;
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      term.dispose();
      termRef.current = null;
    };
  }, [cast]);

  const stop = () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setPlaying(false);
  };

  const play = () => {
    const term = termRef.current;
    if (!term || !cast) return;
    stop();
    term.reset();
    term.resize(cast.cols, cast.rows);
    setPlaying(true);
    let i = 0;
    const step = () => {
      const [t, kind, data] = cast.events[i];
      if (kind === "o") term.write(data);
      else if (kind === "r") resize(term, data);
      i += 1;
      if (i >= cast.events.length) {
        timerRef.current = null;
        setPlaying(false);
        return;
      }
      const gap = Math.min(MAX_GAP_S, Math.max(0, cast.events[i][0] - t));
      timerRef.current = window.setTimeout(step, gap * 1000);
    };
    if (cast.events.length) step();
    else setPlaying(false);
  };

  const outputs = cast?.events.filter((e) => e[1] === "o").length ?? 0;

  return (
    <Modal
      title="Console recording"
      subtitle={subtitle}
      icon={PlaySquare}
      size="xl"
      onClose={onClose}
      footer={
        <>
          {text && (
            <Button variant="secondary" size="sm" onClick={() => saveCast(text, session.session_id)}>
              <Download className="h-4 w-4" />
              Download
            </Button>
          )}
          <Button size="sm" onClick={playing ? stop : play} disabled={!cast || outputs === 0}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {playing ? "Pause" : "Play from start"}
          </Button>
        </>
      }
    >
      {error ? (
        <p role="alert" className="th-drawer-callout text-[13px]" data-tone="critical">
          {error}
        </p>
      ) : !cast ? (
        <div
          className="h-[320px] animate-pulse rounded-lg"
          style={{ background: "var(--th-ring-track)", opacity: 0.6 }}
          aria-hidden="true"
        />
      ) : outputs === 0 ? (
        <p className="py-10 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
          The console showed nothing in this session.
        </p>
      ) : null}
      <div
        ref={screenRef}
        data-testid="replay-screen"
        className={cast && outputs > 0 ? "max-h-[60vh] overflow-auto rounded-lg p-2" : "hidden"}
        style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-drawer-section)" }}
        aria-label="Recorded console output"
        role="log"
      />
    </Modal>
  );
}
