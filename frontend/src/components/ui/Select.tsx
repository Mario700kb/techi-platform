import { Fragment, KeyboardEvent, ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import clsx from "clsx";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Short secondary text shown under the label in the list. */
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Heading rendered above this option (start of an <optgroup>). */
  group?: string;
}

interface SelectProps<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** Omit when a wrapping <label> or <label htmlFor> already names the control. */
  "aria-label"?: string;
  id?: string;
  className?: string;
  /** Shown in front of the selected label, e.g. "Show:" */
  prefix?: string;
  disabled?: boolean;
  placeholder?: string;
  required?: boolean;
  style?: React.CSSProperties;
  "aria-describedby"?: string;
}

/**
 * Themed single-select listbox. Replaces the native <select> popup (which the
 * OS draws and CSS cannot style) with a menu that matches the rest of the UI.
 * Keyboard: ↑/↓ move, Enter/Space choose, Esc closes, type to jump.
 */
export default function Select<T extends string>({ value, options, onChange, id, className, prefix, disabled, placeholder, required, style, ...aria }: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean }>({ top: 0, left: 0, width: 0, up: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();
  const matchIndex = options.findIndex((o) => o.value === value);
  const selectedIndex = Math.max(0, matchIndex);
  const selected = matchIndex >= 0 ? options[matchIndex] : undefined;
  const enabled = (i: number) => !!options[i] && !options[i].disabled;
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (enabled(i)) return i;
    return from;
  };

  const place = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const height = Math.min(320, options.length * 36 + options.filter((o) => o.group).length * 28 + 8);
    const up = r.bottom + 6 + height > window.innerHeight - 8 && r.top - 6 - height > 8;
    setPos({ top: up ? r.top - 6 - height : r.bottom + 6, left: r.left, width: Math.max(r.width, 180), up });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    setActive(enabled(selectedIndex) ? selectedIndex : step(-1, 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false);
    };
    const onMove = () => place();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    if (!open && ["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => step(i, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => step(i, -1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(step(-1, 1)); }
    else if (e.key === "End") { e.preventDefault(); setActive(step(options.length, -1)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(active); }
    else if (e.key === "Escape" || e.key === "Tab") { setOpen(false); }
    else if (e.key.length === 1) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const hit = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setActive(hit);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={aria["aria-label"]}
        aria-describedby={aria["aria-describedby"]}
        aria-required={required || undefined}
        style={style}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        disabled={disabled}
        className={clsx("th-select", className)}
        data-open={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        {selected?.icon}
        <span className="min-w-0 flex-1 truncate text-left">
          {prefix && <span style={{ color: "var(--th-text-muted)" }}>{prefix} </span>}
          {selected ? selected.label : <span style={{ color: "var(--th-text-faint)" }}>{placeholder ?? "Select…"}</span>}
        </span>
        <ChevronDown className={clsx("h-4 w-4 flex-none transition-transform", open && "rotate-180")} style={{ color: "var(--th-text-faint)" }} />
      </button>
      {open && createPortal(
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={aria["aria-label"]}
          className="th-menu th-select-list"
          data-up={pos.up}
          style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: pos.width }}
          onKeyDown={onKeyDown}
        >
          {options.map((option, index) => (
            <Fragment key={`${option.group ?? ""}:${option.value}:${index}`}>
              {option.group && (
                <li role="presentation" className="th-menu-label px-2.5 pb-1 pt-2">{option.group}</li>
              )}
              <li
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                data-value={option.value}
                data-index={index}
                data-active={index === active && !option.disabled}
                className="th-select-option"
                onMouseMove={() => { if (!option.disabled) setActive(index); }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(index)}
              >
                {option.icon}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.hint && <span className="block truncate text-[12px] font-normal" style={{ color: "var(--th-text-muted)" }}>{option.hint}</span>}
                </span>
                {option.value === value && <Check className="h-4 w-4 flex-none" style={{ color: "var(--th-accent-bright)" }} />}
              </li>
            </Fragment>
          ))}
        </ul>,
        document.body,
      )}
    </>
  );
}
