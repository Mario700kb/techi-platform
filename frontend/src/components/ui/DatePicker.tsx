import { KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import clsx from "clsx";
import { APP_TIME_ZONE, DISPLAY_LOCALE } from "../../utils/time";
import Button from "./Button";

interface DatePickerProps {
  /** "YYYY-MM-DD", or "YYYY-MM-DDTHH:MM" with withTime; "" when empty. Same strings as the native inputs. */
  value: string;
  onChange: (value: string) => void;
  /** Adds hour and minute; the value becomes "YYYY-MM-DDTHH:MM" (wall-clock, Tirana). */
  withTime?: boolean;
  /** Earliest / latest selectable day, "YYYY-MM-DD". */
  min?: string;
  max?: string;
  /** Time used when a day is picked before any time was set (withTime only). */
  defaultTime?: string;
  placeholder?: string;
  /** Offer "Clear" (default true). */
  clearable?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Omit when a wrapping <label> already names the control. */
  "aria-label"?: string;
  "aria-describedby"?: string;
}

interface Day {
  y: number;
  m: number; // 0-11
  d: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const toKey = ({ y, m, d }: Day) => `${y}-${pad(m + 1)}-${pad(d)}`;
const fromKey = (key: string): Day | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) };
};
const addDays = (day: Day, n: number): Day => {
  const date = new Date(Date.UTC(day.y, day.m, day.d + n));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate() };
};
const addMonths = (day: Day, n: number): Day => {
  const first = new Date(Date.UTC(day.y, day.m + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return { y: first.getUTCFullYear(), m: first.getUTCMonth(), d: Math.min(day.d, last) };
};
/** 0 = Monday … 6 = Sunday. */
const weekday = (day: Day) => (new Date(Date.UTC(day.y, day.m, day.d)).getUTCDay() + 6) % 7;

/** Today on the Tirana calendar, whatever the viewer's own time zone. */
function tiranaNow(): { day: Day; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: APP_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return {
    day: { y: Number(parts.year), m: Number(parts.month) - 1, d: Number(parts.day) },
    time: `${parts.hour}:${parts.minute}`,
  };
}

const UTC_DATE = (day: Day) => new Date(Date.UTC(day.y, day.m, day.d));
const fmt = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(DISPLAY_LOCALE, { ...options, timeZone: "UTC" });
const DISPLAY = fmt({ day: "numeric", month: "short", year: "numeric" });
const MONTH_TITLE = fmt({ month: "long", year: "numeric" });
const MONTH_SHORT = fmt({ month: "short" });
const DAY_LABEL = fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  fmt({ weekday: "short" }).format(UTC_DATE({ y: 2024, m: 0, d: 1 + i })),
);
const WEEKDAYS_LONG = Array.from({ length: 7 }, (_, i) =>
  fmt({ weekday: "long" }).format(UTC_DATE({ y: 2024, m: 0, d: 1 + i })),
);

/**
 * Themed date (and optional time) picker. Replaces <input type="date"> /
 * "datetime-local", whose calendar the browser draws and CSS cannot style,
 * with one that matches the rest of the UI. Weeks start on Monday; "today"
 * is the Tirana date. Keyboard: arrows move a day/week, PageUp/PageDown a
 * month (with Shift a year), Home/End the week, Enter picks, Esc closes.
 */
export default function DatePicker({
  value,
  onChange,
  withTime = false,
  min,
  max,
  defaultTime = "00:00",
  placeholder,
  clearable = true,
  disabled,
  id,
  className,
  ...aria
}: DatePickerProps) {
  const selected = fromKey(value);
  const time = withTime && /T(\d{2}:\d{2})/.exec(value)?.[1];
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"days" | "months">("days");
  const [focusDay, setFocusDay] = useState<Day>(() => selected ?? tiranaNow().day);
  const [pos, setPos] = useState({ top: 0, left: 0, up: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const minDay = min ? fromKey(min) : null;
  const maxDay = max ? fromKey(max) : null;
  const outOfRange = (day: Day) =>
    (minDay !== null && toKey(day) < toKey(minDay)) || (maxDay !== null && toKey(day) > toKey(maxDay));

  const place = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 296;
    const height = withTime ? 420 : 368;
    const up = r.bottom + 6 + height > window.innerHeight - 8 && r.top - 6 - height > 8;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPos({ top: up ? r.top - 6 - height : r.bottom + 6, left, up });
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    setView("days");
    setFocusDay(fromKey(value) ?? tiranaNow().day);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onMove = () => place();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        // Capture phase, so a dialog behind the picker does not close too.
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      // Tabbing past either end of the panel goes back to the field, so the
      // picker never stays open with focus somewhere else.
      const panel = panelRef.current;
      if (e.key !== "Tab" || !panel?.contains(document.activeElement)) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"),
      ).filter((el) => el.tabIndex >= 0);
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      if (document.activeElement === edge) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep keyboard focus on the focused day as it moves (and when the panel opens).
  useEffect(() => {
    if (open && view === "days")
      panelRef.current?.querySelector<HTMLElement>(`[data-day="${toKey(focusDay)}"]`)?.focus();
  }, [focusDay, open, view]);

  const commit = (day: Day, nextTime?: string) => {
    if (withTime) onChange(`${toKey(day)}T${nextTime ?? time ?? defaultTime}`);
    else onChange(toKey(day));
  };

  const pick = (day: Day) => {
    if (outOfRange(day)) return;
    commit(day);
    setFocusDay(day);
    if (!withTime) close();
  };

  const grid = useMemo(() => {
    const first: Day = { y: focusDay.y, m: focusDay.m, d: 1 };
    const start = addDays(first, -weekday(first));
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [focusDay.y, focusDay.m]);

  const onGridKey = (e: KeyboardEvent) => {
    const moves: Record<string, () => Day> = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      Home: () => addDays(focusDay, -weekday(focusDay)),
      End: () => addDays(focusDay, 6 - weekday(focusDay)),
      PageUp: () => addMonths(focusDay, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focusDay, e.shiftKey ? 12 : 1),
    };
    if (moves[e.key]) {
      e.preventDefault();
      setFocusDay(moves[e.key]());
    }
  };

  const today = tiranaNow();
  const todayKey = toKey(today.day);
  const selectedKey = selected ? toKey(selected) : null;
  const label = selected ? DISPLAY.format(UTC_DATE(selected)) + (withTime && time ? `, ${time}` : "") : null;

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-label={aria["aria-label"]}
        aria-describedby={aria["aria-describedby"]}
        disabled={disabled}
        className={clsx("th-select th-date-trigger", className)}
        data-open={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <CalendarDays className="h-4 w-4 flex-none" style={{ color: "var(--th-text-muted)" }} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left tabular-nums">
          {label ?? (
            <span style={{ color: "var(--th-text-faint)" }}>
              {placeholder ?? (withTime ? "Select date and time" : "Select date")}
            </span>
          )}
        </span>
        <ChevronDown
          className={clsx("h-4 w-4 flex-none transition-transform", open && "rotate-180")}
          style={{ color: "var(--th-text-muted)" }}
          aria-hidden
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={dialogId}
            role="dialog"
            aria-label={withTime ? "Choose date and time" : "Choose date"}
            className="th-menu th-datepicker"
            data-up={pos.up}
            style={{ position: "fixed", top: pos.top, left: pos.left }}
          >
            <div className="th-datepicker-head">
              <button
                type="button"
                className="th-datepicker-title"
                aria-label={view === "days" ? "Choose month and year" : "Back to days"}
                onClick={() => setView((v) => (v === "days" ? "months" : "days"))}
              >
                {view === "days" ? MONTH_TITLE.format(UTC_DATE(focusDay)) : focusDay.y}
                <ChevronDown className={clsx("h-4 w-4", view === "months" && "rotate-180")} aria-hidden />
              </button>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="th-datepicker-nav"
                  aria-label={view === "days" ? "Previous month" : "Previous year"}
                  onClick={() => setFocusDay((d) => addMonths(d, view === "days" ? -1 : -12))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="th-datepicker-nav"
                  aria-label={view === "days" ? "Next month" : "Next year"}
                  onClick={() => setFocusDay((d) => addMonths(d, view === "days" ? 1 : 12))}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>

            {view === "days" ? (
              <div role="grid" aria-label={MONTH_TITLE.format(UTC_DATE(focusDay))}>
                <div role="row" className="th-datepicker-row">
                  {WEEKDAYS.map((name, i) => (
                    <span key={name} role="columnheader" className="th-datepicker-weekday" title={WEEKDAYS_LONG[i]}>
                      {name.slice(0, 2)}
                    </span>
                  ))}
                </div>
                {Array.from({ length: 6 }, (_, week) => (
                  <div role="row" className="th-datepicker-row" key={week}>
                    {grid.slice(week * 7, week * 7 + 7).map((day) => {
                      const key = toKey(day);
                      const isFocus = key === toKey(focusDay);
                      return (
                        <span role="gridcell" key={key} aria-selected={key === selectedKey}>
                          <button
                            type="button"
                            data-day={key}
                            tabIndex={isFocus ? 0 : -1}
                            className="th-datepicker-day"
                            data-outside={day.m !== focusDay.m || undefined}
                            data-today={key === todayKey || undefined}
                            data-selected={key === selectedKey || undefined}
                            aria-label={DAY_LABEL.format(UTC_DATE(day))}
                            aria-current={key === todayKey ? "date" : undefined}
                            disabled={outOfRange(day)}
                            onClick={() => pick(day)}
                            onKeyDown={onGridKey}
                          >
                            {day.d}
                          </button>
                        </span>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : (
              <div className="th-datepicker-months">
                {Array.from({ length: 12 }, (_, m) => (
                  <button
                    key={m}
                    type="button"
                    className="th-datepicker-month"
                    data-selected={selected?.y === focusDay.y && selected.m === m ? true : undefined}
                    data-today={today.day.y === focusDay.y && today.day.m === m ? true : undefined}
                    onClick={() => {
                      setFocusDay((d) => addMonths({ ...d, m: 0 }, m));
                      setView("days");
                    }}
                  >
                    {MONTH_SHORT.format(UTC_DATE({ y: focusDay.y, m, d: 1 }))}
                  </button>
                ))}
              </div>
            )}

            {withTime && (
              <TimeField
                value={time || defaultTime}
                disabled={!selected}
                onChange={(next) => selected && commit(selected, next)}
              />
            )}

            <div className="th-datepicker-foot">
              {clearable ? (
                <button
                  type="button"
                  className="th-datepicker-link"
                  disabled={!value}
                  onClick={() => {
                    onChange("");
                    close();
                  }}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                  Clear
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="th-datepicker-link"
                  disabled={outOfRange(today.day)}
                  onClick={() => {
                    if (withTime) {
                      commit(today.day, today.time);
                      setFocusDay(today.day);
                    } else pick(today.day);
                  }}
                >
                  {withTime ? "Now" : "Today"}
                </button>
                {withTime && (
                  <Button size="sm" type="button" onClick={() => close()}>
                    Done
                  </Button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** HH : MM. Arrow keys step; typing two digits is enough. */
function TimeField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  const [h, m] = value.split(":").map(Number);
  const set = (hours: number, minutes: number) => onChange(`${pad((hours + 24) % 24)}:${pad((minutes + 60) % 60)}`);
  const part = (label: string, current: number, limit: number, apply: (n: number) => void) => (
    <input
      type="text"
      inputMode="numeric"
      maxLength={2}
      aria-label={label}
      className="th-datepicker-time-input"
      value={pad(current)}
      disabled={disabled}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          apply(current + (e.key === "ArrowUp" ? 1 : -1));
        }
      }}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, "");
        if (digits === "") return;
        apply(Math.min(Number(digits), limit));
      }}
    />
  );
  return (
    <div className="th-datepicker-time">
      <span>Time</span>
      <div className="th-datepicker-time-fields">
        {part("Hour", h, 23, (n) => set(n, m))}
        <span aria-hidden>:</span>
        {part("Minute", m, 59, (n) => set(h, n))}
      </div>
    </div>
  );
}
