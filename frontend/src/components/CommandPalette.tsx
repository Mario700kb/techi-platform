import { ComponentType, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Building2, CornerDownLeft, CornerDownRight, KeyRound, LogOut, Monitor, Moon, Search, Sun, User, UsersRound } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../contexts/ThemeContext";
import { useVisibleNav } from "../hooks/useNavigation";
import { ALL_NAV_ITEMS, locateNav, SEARCH_DESTINATIONS } from "./navigation";
import { Device, getDevices } from "../api/devices";
import { Client, getClients } from "../api/clients";
import { getOperators, OperatorRecord } from "../api/operators";
import { listTeams, TeamWithStats } from "../api/teams";
import { deviceDisplayName } from "../utils/deviceLabel";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

type Group = "Devices" | "Pages" | "Go to" | "Clients" | "Teams" | "Operators" | "Actions";

interface Result {
  id: string;
  group: Group;
  title: string;
  subtitle?: string;
  icon: ComponentType<{ className?: string }>;
  tone?: string;
  run: () => void;
}

const GROUP_ORDER: Group[] = ["Devices", "Pages", "Go to", "Clients", "Teams", "Operators", "Actions"];

/** All query words must appear somewhere; a hit in the title ranks higher. */
function score(query: string, title: string, extra = ""): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const t = title.toLowerCase();
  const hay = `${t} ${extra.toLowerCase()}`;
  if (!words.every((w) => hay.includes(w))) return 0;
  if (t.startsWith(words[0])) return 3;
  if (words.every((w) => t.includes(w))) return 2;
  return 1;
}

function freshnessTone(device: Device): string {
  const state = device.freshness_state ?? device.status;
  if (state === "online") return "var(--th-status-online)";
  if (state === "stale") return "var(--th-status-stale)";
  return "var(--th-status-offline)";
}

/**
 * Global search (⌘K): devices, clients, teams and operators from the API, plus
 * every page, in-page destination and app action the operator may use.
 */
export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { hasPermission, logout } = useAuth();
  const { theme, setThemeMode } = useTheme();
  const { canSee } = useVisibleNav();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const canSearchDevices = hasPermission("view_devices");
  const [directory, setDirectory] = useState<{ clients: Client[]; teams: TeamWithStats[]; operators: OperatorRecord[] } | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setDevices([]);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    if (directory) return;
    const settle = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[]);
    void Promise.all([
      hasPermission("manage_clients") || hasPermission("view_devices") ? settle(getClients()) : Promise.resolve([]),
      hasPermission("manage_teams") ? settle(listTeams()) : Promise.resolve([]),
      hasPermission("manage_operators") ? settle(getOperators()) : Promise.resolve([]),
    ]).then(([clients, teams, operators]) => setDirectory({ clients, teams, operators }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2 || !canSearchDevices) {
      setDevices([]);
      setDevicesLoading(false);
      return;
    }
    const controller = new AbortController();
    setDevicesLoading(true);
    const timer = window.setTimeout(() => {
      getDevices({ search: q, lifecycle_state: "active" }, 0, 6, controller.signal)
        .then((res) => setDevices(res.devices))
        .catch(() => undefined)
        .finally(() => setDevicesLoading(false));
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, open, canSearchDevices]);

  const go = (to: string) => { onClose(); navigate(to); };

  const results = useMemo<Result[]>(() => {
    const q = query.trim();
    const out: (Result & { rank: number })[] = [];
    const push = (r: Result, rank: number) => { if (rank > 0) out.push({ ...r, rank }); };

    for (const device of devices) {
      push({
        id: `device-${device.id}`,
        group: "Devices",
        title: deviceDisplayName(device),
        subtitle: [device.client_name ?? "No client", device.current_user, device.public_ip || device.local_ip, device.rustdesk_id && `ID ${device.rustdesk_id}`].filter(Boolean).join(" · "),
        icon: Monitor,
        tone: freshnessTone(device),
        run: () => go(`/devices?device=${device.id}`),
      }, 4);
    }

    for (const item of ALL_NAV_ITEMS) {
      if (!canSee(item)) continue;
      push({ id: `page-${item.to}`, group: "Pages", title: item.label, subtitle: locateNav(item.to).section || undefined, icon: item.icon, run: () => go(item.to) },
        score(q, item.label, item.keywords));
    }

    if (q) {
      for (const dest of SEARCH_DESTINATIONS) {
        const base = "/" + dest.to.split(/[/?]/)[1];
        const owner = ALL_NAV_ITEMS.find((i) => i.to === base);
        if (owner && !canSee(owner)) continue;
        push({ id: `dest-${dest.context}-${dest.label}`, group: "Go to", title: dest.label, subtitle: dest.context, icon: CornerDownRight, run: () => go(dest.to) },
          score(q, dest.label, `${dest.context} ${dest.keywords ?? ""}`));
      }
      for (const client of directory?.clients ?? []) {
        push({ id: `client-${client.id}`, group: "Clients", title: client.name, subtitle: client.description || client.slug, icon: Building2, run: () => go("/clients") },
          score(q, client.name, `${client.slug} ${client.description ?? ""}`));
      }
      for (const team of directory?.teams ?? []) {
        push({ id: `team-${team.id}`, group: "Teams", title: team.name, subtitle: team.description || "Team", icon: UsersRound, run: () => go(`/teams/${team.id}`) },
          score(q, team.name, team.description ?? ""));
      }
      for (const op of directory?.operators ?? []) {
        const name = op.display_name || op.username;
        push({ id: `operator-${op.id}`, group: "Operators", title: name, subtitle: `${op.email} · ${op.role}`, icon: User, run: () => go("/operators") },
          score(q, name, `${op.username} ${op.email} ${op.role}`));
      }
    }

    const actions: (Result & { keywords: string })[] = [
      { id: "action-theme", group: "Actions", title: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", icon: theme === "dark" ? Sun : Moon, keywords: "theme appearance mode dark light", run: () => { setThemeMode(theme === "dark" ? "light" : "dark"); onClose(); } },
      { id: "action-password", group: "Actions", title: "Change password", icon: KeyRound, keywords: "password account security", run: () => go("/settings") },
      { id: "action-signout", group: "Actions", title: "Sign out", icon: LogOut, keywords: "logout log out exit", run: () => { onClose(); logout(); } },
    ];
    for (const a of actions) push(a, score(q, a.title, a.keywords));

    return out
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || b.rank - a.rank)
      .map(({ rank: _rank, ...r }) => r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, devices, directory, canSee, theme]);

  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); results[active]?.run(); }
    else if (event.key === "Escape") { event.preventDefault(); onClose(); }
  };

  let index = -1;
  const grouped = GROUP_ORDER.map((group) => ({ group, items: results.filter((r) => r.group === group) })).filter((g) => g.items.length > 0);
  const q = query.trim();

  return createPortal(
    <div className="th-palette-scrim" onMouseDown={onClose}>
      <div className="th-palette" role="dialog" aria-modal="true" aria-label="Search" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="th-palette-input">
          <Search className="h-4 w-4 flex-none" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search devices, clients, pages and settings…"
            aria-label="Search"
            aria-controls="th-palette-results"
            aria-activedescendant={results[active] ? `th-palette-${results[active].id}` : undefined}
            role="combobox"
            aria-expanded="true"
          />
          {devicesLoading && <span className="th-spinner" aria-label="Searching" />}
          <kbd className="th-kbd">Esc</kbd>
        </div>

        <div ref={listRef} id="th-palette-results" role="listbox" className="th-palette-list">
          {grouped.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                {devicesLoading ? "Searching…" : `No results for “${q}”`}
              </p>
              {!devicesLoading && (
                <p className="mt-1 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                  Try a hostname, user, IP address, Remote Support ID, client or page name.
                </p>
              )}
            </div>
          ) : (
            grouped.map(({ group, items }) => (
              <div key={group} role="group" aria-label={group} className="pb-1">
                <p className="th-menu-label px-4 pt-2">{q ? group : group === "Pages" ? "Jump to" : group}</p>
                {items.map((r) => {
                  index += 1;
                  const i = index;
                  const Icon = r.icon;
                  return (
                    <div
                      key={r.id}
                      id={`th-palette-${r.id}`}
                      role="option"
                      aria-selected={i === active}
                      data-index={i}
                      className="th-palette-item"
                      onMouseMove={() => setActive(i)}
                      onClick={() => r.run()}
                    >
                      <span className="th-palette-icon">
                        <Icon className="h-4 w-4" />
                        {r.tone && <i style={{ background: r.tone }} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>{r.title}</span>
                        {r.subtitle && <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>{r.subtitle}</span>}
                      </span>
                      {i === active && <CornerDownLeft className="h-3.5 w-3.5 flex-none" style={{ color: "var(--th-text-faint)" }} />}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="th-palette-footer">
          <span><kbd className="th-kbd">↑</kbd><kbd className="th-kbd">↓</kbd> navigate</span>
          <span><kbd className="th-kbd">↵</kbd> open</span>
          <span><kbd className="th-kbd">esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
