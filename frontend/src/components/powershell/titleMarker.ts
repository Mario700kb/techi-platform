/**
 * Agent 2.1.30+ sets the console title after every PowerShell command. It
 * reaches xterm.js as an OSC 0/2 title change and is never drawn:
 *
 *   techi;<PowerShell version>;<history id>;<failed 0|1>;<duration ms>;<command, base64 of UTF-8>
 *
 * History id 0 means no command yet (the first prompt); a new id is a
 * finished command. Anything else (a script that sets its own title) is
 * ignored.
 */
export interface TitleMarker {
  version: string;
  historyId: number;
  failed: boolean;
  durationMs: number;
  command: string;
}

const VERSION = /^[0-9][0-9A-Za-z.+-]{0,40}$/;
const UINT = /^\d{1,15}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeUtf8Base64(value: string): string | null {
  if (!BASE64.test(value)) return null;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function parseTitleMarker(title: string): TitleMarker | null {
  const parts = title.split(";");
  if (parts.length !== 6 || parts[0] !== "techi") return null;
  const [, version, id, failed, duration, encoded] = parts;
  if (!VERSION.test(version) || !UINT.test(id) || !UINT.test(duration)) return null;
  if (failed !== "0" && failed !== "1") return null;
  const command = decodeUtf8Base64(encoded);
  if (command === null) return null;
  return {
    version,
    historyId: Number(id),
    failed: failed === "1",
    durationMs: Number(duration),
    command,
  };
}

/** The comment the platform appends to a saved-script run line. */
const SCRIPT_TAG = /#\s*TECHI script:\s*(.+?)\s+v\d+\s*$/;

/** "Script · <name>" for a saved-script run, null for anything else. */
export function scriptName(command: string): string | null {
  const m = SCRIPT_TAG.exec(command);
  return m ? m[1] : null;
}

export interface ConsoleCommand {
  key: string;
  /** When the command started (ms since epoch). */
  at: number;
  /** What the list shows: the command, or "Script · <name>". */
  label: string;
  /** The command as run (for the tooltip and the command-bar history). */
  command: string;
  /** Known only from the title marker (agent 2.1.30+). */
  failed: boolean | null;
  durationMs: number | null;
  script: boolean;
}

export interface CommandLog {
  /** The agent reports finished commands in the title (2.1.30+). */
  reported: boolean;
  version: string | null;
  lastId: number;
  /** From title markers. */
  finished: ConsoleCommand[];
  /** Sent through the command bar or a saved script (the 2.1.29 fallback). */
  sent: ConsoleCommand[];
}

export const EMPTY_LOG: CommandLog = { reported: false, version: null, lastId: 0, finished: [], sent: [] };

let seq = 0;
const nextKey = () => `c${++seq}`;

/** Fold one console title into the log; unchanged when it isn't a marker or the id was seen. */
export function applyTitle(log: CommandLog, title: string, now = Date.now()): CommandLog {
  const marker = parseTitleMarker(title);
  if (!marker) return log;
  const base: CommandLog =
    log.reported && log.version === marker.version ? log : { ...log, reported: true, version: marker.version };
  if (marker.historyId === 0 || marker.historyId === log.lastId) return base;
  const name = scriptName(marker.command);
  return {
    ...base,
    lastId: marker.historyId,
    finished: [
      ...log.finished,
      {
        key: nextKey(),
        at: now - marker.durationMs,
        label: name ? `Script · ${name}` : marker.command,
        command: marker.command,
        failed: marker.failed,
        durationMs: marker.durationMs,
        script: Boolean(name),
      },
    ],
  };
}

/** Record a command the operator sent from the bar or a saved script. */
export function applySent(log: CommandLog, command: string, label = command, now = Date.now()): CommandLog {
  return {
    ...log,
    sent: [
      ...log.sent,
      { key: nextKey(), at: now, label, command, failed: null, durationMs: null, script: label !== command },
    ],
  };
}

/** What "This session" lists: reported commands when the agent reports them. */
export function visibleCommands(log: CommandLog): ConsoleCommand[] {
  return log.reported ? log.finished : log.sent;
}

/** The command-bar history: this session's commands, oldest first, no scripts, no repeats in a row. */
export function commandHistory(log: CommandLog): string[] {
  const out: string[] = [];
  for (const c of visibleCommands(log)) {
    if (c.script || !c.command.trim()) continue;
    if (out[out.length - 1] !== c.command) out.push(c.command);
  }
  return out;
}
