import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, MutableRefObject } from "react";
import { Loader2 } from "lucide-react";

import { ApiError } from "../../api/client";
import { closeCommandModeSession, getCommandModeResult, runCommandModeCommand } from "../../api/terminal";
import type { TerminalHandle } from "../DeviceTerminal";
import { CONSOLE_FONT, CONSOLE_THEME } from "./consoleTheme";

/** Where powershell.exe starts as the agent's service account. */
const START_CWD = "C:\\Windows\\system32";
const POLL_MS = 700;

type Line = { key: number; text: string; tone?: "prompt" | "error" | "muted" };

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

/** The bar's console input ("line\rline\r") back to the command it was. */
function fromConsoleInput(data: string): string {
  return data.replace(/\r$/, "").split("\r").join("\n");
}

function failure(err: unknown): { text: string; ended: boolean } {
  if (err instanceof ApiError) return { text: err.message, ended: err.status === 410 || err.status === 404 };
  return { text: err instanceof Error && err.message ? err.message : "The platform did not answer.", ended: false };
}

/**
 * The console screen for Windows without a pseudo console (Server 2012 R2 /
 * 2016): each command runs on its own as the agent's run_powershell and its
 * output comes back here. Speaks the same handle and callbacks as the live
 * terminal, so the console around it (command bar, saved scripts, session
 * details, the command list) works unchanged. The folder is carried from one
 * command to the next; a command cannot be answered or stopped while it runs.
 * As in the live console, commands are typed straight into the screen, at the
 * prompt; the command bar under it works as well.
 */
export default function CommandModeScreen({
  deviceId,
  sessionId,
  banner,
  handleRef,
  onOpen,
  onActivity,
  onClosed,
  onTitleChange,
}: {
  deviceId: number;
  sessionId: string;
  banner: string;
  handleRef: MutableRefObject<TerminalHandle | null>;
  onOpen: () => void;
  onActivity: () => void;
  onClosed: (message: string) => void;
  onTitleChange: (title: string) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [running, setRunning] = useState<{ command: string; since: number } | null>(null);
  const [, setTick] = useState(0);
  const cwd = useRef<string | null>(null);
  const version = useRef("5.1");
  const count = useRef(0);
  const busy = useRef(false);
  const ended = useRef(false);
  const seq = useRef(0);
  const screen = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  const [opened, setOpened] = useState(false);
  const [isEnded, setIsEnded] = useState(false);
  const [promptCwd, setPromptCwd] = useState(START_CWD);
  const [draft, setDraft] = useState("");
  // This session's commands for ↑/↓ at the prompt (from the prompt and the bar).
  const history = useRef<string[]>([]);
  const cursor = useRef<number | null>(null);
  const callbacks = useRef({ onOpen, onActivity, onClosed, onTitleChange });
  callbacks.current = { onOpen, onActivity, onClosed, onTitleChange };

  const print = (text: string, tone?: Line["tone"]) =>
    setLines((prev) => [...prev, ...text.split("\n").map((t) => ({ key: ++seq.current, text: t, tone }))]);

  const end = (message: string) => {
    if (ended.current) return;
    ended.current = true;
    busy.current = false;
    setRunning(null);
    setIsEnded(true);
    callbacks.current.onClosed(message);
  };

  /** Run one command and wait for its result; null when the session ended. */
  const execute = async (command: string) => {
    const queued = await runCommandModeCommand(deviceId, sessionId, command, cwd.current);
    for (;;) {
      await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
      if (ended.current) return null;
      const result = await getCommandModeResult(deviceId, sessionId, queued.action_id);
      if (result.done) return result;
    }
  };

  const run = async (command: string, quiet = false) => {
    busy.current = true;
    const started = Date.now();
    if (!quiet) {
      print(`PS ${cwd.current ?? START_CWD}> ${command}`, "prompt");
      setRunning({ command, since: started });
    }
    try {
      const result = await execute(command);
      if (!result) return null;
      if (result.cwd) {
        cwd.current = result.cwd;
        setPromptCwd(result.cwd);
      }
      if (!quiet) {
        if (result.output) print(result.output);
        if (result.stderr) print(result.stderr, "error");
        if (result.error) print(result.error, "error");
        if (result.truncated) print("[the agent returns at most ~4,000 characters per command]", "muted");
        count.current += 1;
        const ms = result.duration_ms ?? Date.now() - started;
        callbacks.current.onTitleChange(
          `techi;${version.current};${count.current};${result.failed ? 1 : 0};${ms};${utf8Base64(command.slice(0, 400))}`,
        );
      }
      callbacks.current.onActivity();
      return result;
    } catch (err) {
      const { text, ended: gone } = failure(err);
      if (gone) end(text);
      else if (!quiet) print(text, "error");
      return null;
    } finally {
      busy.current = false;
      setRunning(null);
    }
  };

  const queue = useRef<string[]>([]);
  const drain = async () => {
    while (!ended.current && !busy.current && queue.current.length > 0) {
      const next = queue.current.shift() as string;
      await run(next);
    }
  };

  /** A command from the prompt or the bar: typed while one runs, it waits its turn. */
  const enqueue = (command: string) => {
    if (history.current[history.current.length - 1] !== command) history.current.push(command);
    cursor.current = null;
    queue.current.push(command);
    if (!busy.current) void drain();
  };

  const stopNote = () =>
    print("A running command cannot be stopped in command mode; it ends by itself within 5 minutes.", "muted");

  const onPromptKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const command = draft;
      setDraft("");
      if (command.trim()) enqueue(command);
      else print(`PS ${cwd.current ?? START_CWD}>`, "prompt");
      return;
    }
    if (e.key === "c" && e.ctrlKey && !window.getSelection()?.toString()) {
      e.preventDefault();
      if (draft) {
        print(`PS ${cwd.current ?? START_CWD}> ${draft}^C`, "prompt");
        setDraft("");
      } else stopNote();
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const list = history.current;
      if (list.length === 0) return;
      e.preventDefault();
      const at = cursor.current;
      const next =
        e.key === "ArrowUp" ? (at === null ? list.length - 1 : Math.max(0, at - 1)) : at === null ? null : at + 1;
      if (next === null || next >= list.length) {
        cursor.current = null;
        setDraft("");
      } else {
        cursor.current = next;
        setDraft(list[next]);
      }
    }
  };

  const focusPrompt = () => input.current?.focus({ preventScroll: true });

  useEffect(() => {
    handleRef.current = {
      send: (data: string) => {
        if (ended.current) return false;
        if (data === "\x03") {
          stopNote();
          return true;
        }
        const command = fromConsoleInput(data);
        if (!command.trim()) return true;
        enqueue(command);
        return true;
      },
      close: () => {
        if (ended.current) return;
        ended.current = true;
        setIsEnded(true);
        void closeCommandModeSession(deviceId, sessionId).catch(() => undefined);
      },
      focus: focusPrompt,
    };
    return () => {
      handleRef.current = null;
    };
    // The handle reads refs only; it is set once per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, sessionId]);

  // First contact: the device's PowerShell version, which also proves it answers.
  useEffect(() => {
    print(banner, "muted");
    print(
      "Command mode: this Windows has no pseudo console. Each command runs on its own and its output comes back; " +
        "the folder is kept between commands, variables are not.",
      "muted",
    );
    void run("$PSVersionTable.PSVersion.ToString()", true).then((result) => {
      if (ended.current) return;
      if (!result || result.failed) {
        end(result?.error ?? "The device did not answer.");
        return;
      }
      const reported = result.output.trim().split("\n")[0]?.trim();
      if (reported && /^[0-9][0-9.]*$/.test(reported)) version.current = reported;
      print(`Connected · PowerShell ${version.current}`, "muted");
      setOpened(true);
      callbacks.current.onOpen();
      void drain();
      callbacks.current.onTitleChange(`techi;${version.current};0;0;0;`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, sessionId]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    screen.current?.scrollTo?.({ top: screen.current.scrollHeight });
  }, [lines, running, draft]);

  // Ready to type as soon as the device answered, like the live console.
  useEffect(() => {
    if (opened) focusPrompt();
  }, [opened]);

  const theme = CONSOLE_THEME;
  const showPrompt = opened && !isEnded && !running;
  return (
    // A click anywhere on the screen puts the cursor at the prompt, as in the
    // live console; keyboard users reach the prompt itself with Tab.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={screen}
      onMouseUp={() => {
        if (showPrompt && !window.getSelection()?.toString()) focusPrompt();
      }}
      className="h-full overflow-auto px-3 py-2 text-[12.5px] leading-[1.45]"
      style={{ fontFamily: CONSOLE_FONT, color: theme.foreground, background: theme.background }}
      aria-label="PowerShell output"
      aria-live="polite"
      data-testid="command-mode-screen"
    >
      {lines.map((line) => (
        <div
          key={line.key}
          className="whitespace-pre-wrap break-words"
          style={{
            color:
              line.tone === "prompt"
                ? theme.blue
                : line.tone === "error"
                  ? theme.red
                  : line.tone === "muted"
                    ? theme.brightBlack
                    : undefined,
          }}
        >
          {line.text || "\u00a0"}
        </div>
      ))}
      {running && (
        <div className="flex items-center gap-2" style={{ color: theme.brightBlack }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Running on the device… {Math.round((Date.now() - running.since) / 1000)} s
        </div>
      )}
      {showPrompt && (
        <div className="flex items-baseline whitespace-pre">
          <label htmlFor={inputId} style={{ color: theme.blue }}>
            PS {promptCwd}&gt;{" "}
          </label>
          <input
            id={inputId}
            ref={input}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              cursor.current = null;
            }}
            onKeyDown={onPromptKey}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            aria-label="PowerShell command"
            className="ps-cmd-prompt min-w-0 flex-1 border-0 bg-transparent p-0"
            style={{ font: "inherit", color: theme.foreground, caretColor: theme.cursor }}
            data-testid="command-mode-prompt"
          />
        </div>
      )}
    </div>
  );
}
