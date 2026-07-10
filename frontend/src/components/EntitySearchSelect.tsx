import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";

// Generic searchable combobox used by the Vault form's Client/Group/Device
// pickers (and reusable anywhere else a searchable single-select is needed).
// Two modes:
//  - `options`: static list, filtered client-side as the operator types.
//  - `loadOptions`: async server search (debounced), for lists too large to
//    load upfront (e.g. devices across a ~700-device fleet).

export interface EntityOption {
  value: string;
  label: string;
  sublabel?: string;
}

interface Props {
  value: string;
  // `label` is passed when the operator picks an option from the dropdown
  // (undefined for the X-clear button) — lets callers cache a display label
  // for `selectedLabel` without a second lookup.
  onChange: (value: string, label?: string) => void;
  placeholder?: string;
  disabled?: boolean;
  options?: EntityOption[];
  loadOptions?: (query: string) => Promise<EntityOption[]>;
  selectedLabel?: string; // override display when the selected option isn't in the current options/results (e.g. edit mode)
}

const DEBOUNCE_MS = 250;

export default function EntitySearchSelect({
  value, onChange, placeholder = "Search…", disabled, options, loadOptions, selectedLabel,
}: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<EntityOption[]>(options ?? []);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (options) {
      const needle = query.trim().toLowerCase();
      setResults(
        needle
          ? options.filter((o) => o.label.toLowerCase().includes(needle) || o.sublabel?.toLowerCase().includes(needle))
          : options,
      );
      return;
    }
    if (!loadOptions) return;
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      loadOptions(query)
        .then((r) => { if (active) setResults(r); })
        .finally(() => { if (active) setLoading(false); });
    }, DEBOUNCE_MS);
    return () => { active = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, options === undefined ? null : options.length]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const selected = useMemo(() => (options ?? results).find((o) => o.value === value), [options, results, value]);
  const displayLabel = selected?.label ?? (value && selectedLabel) ?? "";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="th-input flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Search className="h-3.5 w-3.5 flex-none" style={{ color: "var(--th-text-faint)" }} />
        <span className={`flex-1 truncate ${displayLabel ? "" : "opacity-60"}`}>
          {displayLabel || placeholder}
        </span>
        {value && !disabled && (
          <X
            className="h-3.5 w-3.5 flex-none"
            style={{ color: "var(--th-text-faint)" }}
            onClick={(e) => { e.stopPropagation(); onChange(""); setQuery(""); }}
          />
        )}
        <ChevronDown className={`h-3.5 w-3.5 flex-none transition-transform ${open ? "rotate-180" : ""}`} style={{ color: "var(--th-text-faint)" }} />
      </button>

      {open && !disabled && (
        <div
          role="listbox"
          aria-label={placeholder}
          className="absolute left-0 right-0 z-50 mt-1 max-h-64 overflow-y-auto rounded-lg shadow-2xl"
          style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
        >
          <input
            autoFocus
            className="th-input w-full border-0 border-b px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--th-border-drawer-section)" }}
            placeholder="Type to search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading && (
            <div className="px-3 py-2 text-xs" style={{ color: "var(--th-text-faint)" }}>Searching…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-xs" style={{ color: "var(--th-text-faint)" }}>No matches</div>
          )}
          {!loading && results.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onClick={() => { onChange(o.value, o.label); setOpen(false); setQuery(""); }}
              className="flex w-full flex-col items-start px-3 py-2 text-left text-sm transition hover:bg-[var(--th-bg-card-hover)]"
              style={{ color: "var(--th-text-primary)" }}
            >
              <span className="font-medium">{o.label}</span>
              {o.sublabel && <span className="text-xs" style={{ color: "var(--th-text-faint)" }}>{o.sublabel}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
