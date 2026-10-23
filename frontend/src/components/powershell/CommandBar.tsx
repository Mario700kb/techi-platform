import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownLeft } from "lucide-react";

const MAX_LINES = 4;

/** Lines joined the way a console expects them: one carriage return each. */
export function toConsoleInput(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").join("\r") + "\r";
}

/**
 * The command line under the console: Enter runs, Shift+Enter adds a line,
 * ↑/↓ walk this session's commands, Ctrl+C stops the running command.
 * Typing straight into the console keeps working (Tab completion etc.).
 */
export default function CommandBar({
  history,
  disabled,
  onRun,
  onInterrupt,
  compact = false,
  initialValue = "",
  placeholder = "Type a command · Enter runs · Shift+Enter new line · ↑↓ history · Ctrl+C stops",
}: {
  /** This session's commands, oldest first. */
  history: string[];
  disabled: boolean;
  onRun: (text: string) => void;
  onInterrupt: () => void;
  compact?: boolean;
  /** Typed in, not run: a command brought from an alert, read before Enter. */
  initialValue?: string;
  placeholder?: string;
}) {
  const [value, setValue] = useState(initialValue);
  // Position while walking the history; null = editing a new command.
  const [cursor, setCursor] = useState<number | null>(null);
  const draft = useRef("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const id = useId();

  // Grow with the text, up to four lines, then scroll.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    const border = px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    const max = (px(cs.lineHeight) || 20) * MAX_LINES + px(cs.paddingTop) + px(cs.paddingBottom) + border;
    el.style.height = "auto";
    // Empty: one line, whatever the (long) placeholder would wrap to.
    const one = (px(cs.lineHeight) || 20) + px(cs.paddingTop) + px(cs.paddingBottom) + border;
    if (el.scrollHeight) el.style.height = `${value ? Math.min(el.scrollHeight + border, max) : one}px`;
  }, [value]);

  const run = () => {
    if (disabled || !value.trim()) return;
    onRun(value);
    setValue("");
    setCursor(null);
    draft.current = "";
  };

  const recall = (index: number | null) => {
    setCursor(index);
    const next = index === null ? draft.current : history[index];
    setValue(next);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.selectionStart = el.selectionEnd = next.length;
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      run();
      return;
    }
    if ((e.key === "c" || e.key === "C") && e.ctrlKey && !e.metaKey && !e.altKey) {
      // With text selected, Ctrl+C copies as usual.
      if (el.selectionStart !== el.selectionEnd) return;
      e.preventDefault();
      if (!disabled) onInterrupt();
      return;
    }
    if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey) {
      // Only from the first line, so a multi-line command can still be edited.
      if (el.value.slice(0, el.selectionStart).includes("\n") || history.length === 0) return;
      e.preventDefault();
      if (cursor === null) {
        draft.current = value;
        recall(history.length - 1);
      } else if (cursor > 0) recall(cursor - 1);
      return;
    }
    if (e.key === "ArrowDown" && !e.shiftKey && !e.altKey) {
      if (cursor === null || el.value.slice(el.selectionEnd).includes("\n")) return;
      e.preventDefault();
      recall(cursor < history.length - 1 ? cursor + 1 : null);
    }
  };

  return (
    <div
      className={`flex items-center gap-2 ${compact ? "px-2.5 py-2" : "px-3 py-2.5"}`}
      style={{ background: "var(--th-bg-drawer-section)", borderTop: "1px solid var(--th-border-drawer-section)" }}
    >
      <label htmlFor={id} className="premium-kicker flex-none !text-[11px]">
        Command
      </label>
      <textarea
        id={id}
        ref={inputRef}
        rows={1}
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        onChange={(e) => {
          setValue(e.target.value);
          if (cursor !== null) setCursor(null);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="th-input ps-command-input min-w-0 flex-1 resize-none rounded-md border px-2.5 py-1.5 font-mono text-[12.5px] leading-5"
      />
      <button
        type="button"
        onClick={run}
        disabled={disabled || !value.trim()}
        className="th-btn th-btn-primary inline-flex min-h-8 flex-none items-center gap-1.5 rounded-md border px-3 text-[13px] font-semibold"
      >
        Run
        <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
