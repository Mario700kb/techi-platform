import { useEffect, useRef, useState } from "react";
import { ChevronDown, Monitor, Globe } from "lucide-react";

import { fetchJson } from "../api/client";

// Connect Framework UI (Platform Expansion Phase 7). The dropdown is built
// ENTIRELY from GET /devices/{id}/connect-methods — no hardcoded per-platform
// menus. Launchers are the NEXT phase: selecting a method surfaces its metadata
// (a clearly-labelled stub), so the framework is proven without a fake action.

interface ConnectMethod {
  id: string;
  label: string;
  surface: "desktop" | "browser";
  capability: string | null;
  priority: number;
  scheme: string | null;
}

interface Props {
  deviceId: number;
}

export default function ConnectMenu({ deviceId }: Props) {
  const [methods, setMethods] = useState<ConnectMethod[] | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    fetchJson<{ platform: string; methods: ConnectMethod[] }>(
      `/api/v1/devices/${deviceId}/connect-methods`,
    )
      .then((r) => { if (active) setMethods(r.methods); })
      .catch(() => { if (active) setMethods([]); });
    return () => { active = false; };
  }, [deviceId]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // No methods available (e.g. device reports no relevant capability) → nothing
  // to connect with; render nothing rather than an empty menu.
  if (methods !== null && methods.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={methods === null}
        className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.06] disabled:opacity-50"
      >
        Connect
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {open && methods && (
        <div
          className="absolute right-0 z-50 mt-1 min-w-[200px] overflow-hidden rounded-lg shadow-2xl"
          style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
        >
          {methods.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                setOpen(false);
                setNote(`${m.label}: launcher arrives in the next phase (${m.surface}${m.scheme ? `, ${m.scheme}` : ""}).`);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-slate-200 transition hover:bg-white/[0.05]"
            >
              {m.surface === "browser" ? <Globe className="h-3.5 w-3.5 text-slate-400" /> : <Monitor className="h-3.5 w-3.5 text-slate-400" />}
              <span className="flex-1">{m.label}</span>
              <span className="text-[9px] uppercase tracking-wide text-slate-500">{m.surface}</span>
            </button>
          ))}
        </div>
      )}

      {note && (
        <div className="absolute right-0 z-40 mt-1 min-w-[220px] rounded-md px-3 py-2 text-[11px]"
          style={{ background: "var(--th-bg-drawer-section)", border: "1px solid var(--th-border-drawer-section)", color: "var(--th-text-secondary)" }}
          onClick={() => setNote(null)}>
          {note}
        </div>
      )}
    </div>
  );
}
