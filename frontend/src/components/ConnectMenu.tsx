import { useEffect, useRef, useState } from "react";
import { ChevronDown, Link2, Monitor, Globe } from "lucide-react";

import { fetchJson } from "../api/client";
import { clickProtocolUrl } from "../services/rustdeskLaunch";
import { detectOperatorOS } from "../utils/operatorOs";

// Connect Framework UI (Platform Expansion Phase 7). The dropdown is built
// ENTIRELY from GET /devices/{id}/connect-methods — no hardcoded per-platform
// menus. Methods whose desktop app doesn't exist on the OPERATOR's own OS
// (`requires_client_os`, e.g. Winbox.exe is Windows-only) are filtered out
// client-side — never shown as a dead click. Selecting a method calls the
// generic launcher (`/connect-methods/{id}/launch`) which returns a
// scheme:// or http(s):// URL; desktop methods navigate via a protocol link,
// browser methods open a new tab. `remote_support`/`web_terminal` keep their
// own existing dedicated flows (Remote Support tab / Terminal tab) and are
// not launched from here.

interface ConnectMethod {
  id: string;
  label: string;
  surface: "desktop" | "browser";
  capability: string | null;
  priority: number;
  scheme: string | null;
  requires_client_os: string | null;
}

interface Props {
  deviceId: number;
}

const DEDICATED_METHOD_IDS = new Set(["remote_support", "web_terminal"]);

export default function ConnectMenu({ deviceId }: Props) {
  const [methods, setMethods] = useState<ConnectMethod[] | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    fetchJson<{ platform: string; methods: ConnectMethod[] }>(
      `/api/v1/devices/${deviceId}/connect-methods`,
    )
      .then((r) => {
        if (!active) return;
        // Don't show a launcher that can't work on this operator's machine
        // (e.g. Winbox.exe has no macOS/Linux build).
        const operatorOS = detectOperatorOS();
        const usable = r.methods.filter((m) => !m.requires_client_os || m.requires_client_os === operatorOS);
        setMethods(usable);
      })
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

  const launch = async (m: ConnectMethod) => {
    setOpen(false);
    if (DEDICATED_METHOD_IDS.has(m.id)) {
      setNote(`${m.label} has its own Connect flow (see the ${m.id === "remote_support" ? "Remote Support" : "Terminal"} tab).`);
      return;
    }
    setLaunching(m.id);
    try {
      const res = await fetchJson<{ url: string; surface: "desktop" | "browser" }>(
        `/api/v1/devices/${deviceId}/connect-methods/${m.id}/launch`,
      );
      if (res.surface === "desktop") {
        clickProtocolUrl(res.url);
      } else {
        window.open(res.url, "_blank", "noopener,noreferrer");
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : `Could not launch ${m.label}`);
    } finally {
      setLaunching(null);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={methods === null}
        className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: "var(--th-accent-dim-bg)", border: "1px solid var(--th-accent-border)", color: "var(--th-accent-bright)" }}
      >
        <Link2 className="h-3.5 w-3.5" />
        Connect
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && methods && (
        <div
          className="absolute right-0 z-50 mt-1.5 min-w-[220px] overflow-hidden rounded-lg shadow-2xl"
          style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
        >
          {methods.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={launching === m.id}
              onClick={() => void launch(m)}
              className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] font-medium transition hover:bg-[var(--th-bg-card-hover)] disabled:opacity-50"
              style={{ color: "var(--th-text-primary)" }}
            >
              {m.surface === "browser"
                ? <Globe className="h-4 w-4 flex-none" style={{ color: "var(--th-text-muted)" }} />
                : <Monitor className="h-4 w-4 flex-none" style={{ color: "var(--th-text-muted)" }} />}
              <span className="flex-1">{launching === m.id ? "Opening…" : m.label}</span>
              <span className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-faint)" }}>{m.surface}</span>
            </button>
          ))}
        </div>
      )}

      {note && (
        <div className="absolute right-0 z-40 mt-1.5 min-w-[220px] cursor-pointer rounded-md px-3 py-2 text-xs leading-snug"
          style={{ background: "var(--th-bg-drawer-section)", border: "1px solid var(--th-border-drawer-section)", color: "var(--th-text-secondary)" }}
          onClick={() => setNote(null)}>
          {note}
        </div>
      )}
    </div>
  );
}
