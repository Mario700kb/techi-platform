import { useCallback, useEffect, useRef, useState } from "react";
import { getSystemStatus, ServiceTile, TileState } from "../api/system";
import { useAppData } from "../contexts/AppDataContext";
import { APP_TIME_ZONE, parseUTC } from "../utils/time";

const POLL_MS = 30_000;
const SAMPLES = 30;
const SLOW_API_MS = 1500;

const clock = new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIME_ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const hourMinute = new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayMonth = new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIME_ZONE, day: "numeric", month: "short" });

const TITLES: Record<string, string> = {
  api: "API ↔ Web",
  realtime: "Realtime",
  database: "Database",
  agents: "Agents",
  agent_versions: "Agent versions",
  workers: "Workers",
  cleanup: "Nightly cleanup",
  backup: "Nightly backup",
};
const ORDER = Object.keys(TITLES);

/** "03:00" today, "4 Oct, 03:00" otherwise (Tirana time). */
function when(iso?: string | null): string | null {
  if (!iso) return null;
  const d = parseUTC(iso);
  const sameDay = dayMonth.format(d) === dayMonth.format(new Date());
  return sameDay ? hourMinute.format(d) : `${dayMonth.format(d)}, ${hourMinute.format(d)}`;
}

function StateIcon({ state }: { state: TileState }) {
  if (state === "ok") return <span className="sys-ico"><span className="sys-dot" /></span>;
  if (state === "running") return <span className="sys-ico"><span className="sys-spin" /></span>;
  if (state === "warn") return <span className="sys-ico"><span className="sys-blink" /></span>;
  if (state === "down") return <span className="sys-ico"><span className="sys-down" /></span>;
  if (state === "unknown") return <span className="sys-ico"><span className="sys-unknown" /></span>;
  return (
    <span className="sys-ico">
      <svg className="sys-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg>
    </span>
  );
}

function Sparkline({ samples }: { samples: number[] }) {
  if (samples.length < 2) return null;
  const max = Math.max(...samples, 50);
  const step = 120 / (SAMPLES - 1);
  const offset = (SAMPLES - samples.length) * step;
  const pts = samples.map((v, i) => [offset + i * step, 24 - (v / max) * 20] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className="sys-spark" viewBox="0 0 120 26" preserveAspectRatio="none" role="img" aria-label="Response time, last checks">
      <path className="area" d={`${line} L${lx.toFixed(1)},26 L${pts[0][0].toFixed(1)},26 Z`} />
      <path className="line" d={line} />
      <circle className="end" cx={Math.min(lx, 118.5)} cy={ly} r="2" />
    </svg>
  );
}

function Tile({ tile, extra }: { tile: ServiceTile; extra?: React.ReactNode }) {
  const at = when(tile.at);
  const ratio = tile.total ? Math.min(1, (tile.value ?? 0) / tile.total) : null;
  return (
    <article className="sys-tile" data-state={tile.state}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5 text-[14px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
          <StateIcon state={tile.state} />
          <span className="min-w-0 leading-tight">{TITLES[tile.key] ?? tile.key}</span>
        </div>
        <span className="sys-pill" data-state={tile.state}>{tile.label}</span>
      </div>
      <div className="sys-detail">{at ? `${at} · ${tile.detail}` : tile.detail}</div>
      {tile.items && (
        <div className="flex flex-wrap gap-1.5">
          {tile.items.map((item) => (
            <span key={item.name} className="sys-chip" data-state={item.state}><b />{item.name}</span>
          ))}
        </div>
      )}
      {ratio !== null && tile.key !== "workers" && (
        <div className="sys-bar" aria-hidden="true"><i style={{ width: `${Math.round(ratio * 100)}%` }} /></div>
      )}
      {extra}
      {tile.sub && <div className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>{tile.sub}</div>}
    </article>
  );
}

/** Live state of TECHI's own services (owner/admin). Replaces "Recent deployments". */
export default function SystemStatusCard({ compact = false }: { compact?: boolean }) {
  const { realtimeStatus } = useAppData();
  const [server, setServer] = useState<ServiceTile[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [latency, setLatency] = useState<number[]>([]);
  const [apiError, setApiError] = useState<string | null>(null);
  const connectedSince = useRef<number | null>(null);

  useEffect(() => {
    connectedSince.current = realtimeStatus === "connected" ? Date.now() : null;
  }, [realtimeStatus]);

  const check = useCallback(async () => {
    const started = performance.now();
    try {
      const status = await getSystemStatus();
      const ms = Math.round(performance.now() - started);
      setServer(status.services);
      setLatency((prev) => [...prev, ms].slice(-SAMPLES));
      setCheckedAt(new Date());
      setApiError(null);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "No response");
    }
  }, []);

  useEffect(() => {
    void check();
    const id = window.setInterval(() => void check(), POLL_MS);
    return () => window.clearInterval(id);
  }, [check]);

  const lastMs = latency[latency.length - 1];
  const apiTile: ServiceTile = apiError
    ? { key: "api", state: "down", label: "Down", detail: "Backend not responding", sub: apiError }
    : lastMs === undefined
      ? { key: "api", state: "unknown", label: "Checking", detail: "Measuring…" }
      : {
          key: "api",
          state: lastMs >= SLOW_API_MS ? "warn" : "ok",
          label: lastMs >= SLOW_API_MS ? "Slow" : "Live",
          detail: `${lastMs} ms · round trip`,
          sub: "Browser ↔ backend, every 30 s",
        };

  const minutes = connectedSince.current ? Math.floor((Date.now() - connectedSince.current) / 60000) : 0;
  const realtimeTile: ServiceTile =
    realtimeStatus === "connected"
      ? { key: "realtime", state: "ok", label: "Live", detail: "WebSocket connected",
          sub: minutes < 1 ? "Connected just now" : `Stable for ${minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`}` }
      : realtimeStatus === "connecting"
        ? { key: "realtime", state: "running", label: "Connecting", detail: "Opening WebSocket…" }
        : realtimeStatus === "fallback"
          ? { key: "realtime", state: "warn", label: "Polling", detail: "WebSocket unavailable", sub: "Data refreshes by polling instead" }
          : { key: "realtime", state: "down", label: "Offline", detail: "WebSocket disconnected", sub: "Reconnecting automatically" };

  const tiles = [apiTile, realtimeTile, ...(server ?? [])].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  const down = tiles.filter((t) => t.state === "down").length;
  const warn = tiles.filter((t) => t.state === "warn").length;
  const overall: TileState = down ? "down" : warn ? "warn" : "ok";
  const overallText = down
    ? `${down} service${down > 1 ? "s" : ""} down`
    : warn
      ? `${warn} service${warn > 1 ? "s" : ""} need${warn > 1 ? "" : "s"} attention`
      : "All systems operational";

  if (compact) {
    return (
      <section className="premium-card flex h-full flex-col p-0" aria-labelledby="system-status-title">
        <div className="th-panel-head">
          <h2 id="system-status-title">System status</h2>
          <span className="sys-overall" data-state={overall} role="status">
            <StateIcon state={overall} />
            {server === null && !apiError ? "Checking…" : overallText}
          </span>
        </div>
        <ul className="flex-1 px-2 pb-1">
          {tiles.map((tile) => (
            <li key={tile.key} className="th-status-row" title={tile.sub ?? undefined}>
              <StateIcon state={tile.state} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>{TITLES[tile.key] ?? tile.key}</span>
                <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>{tile.detail}</span>
              </span>
              <span className="sys-pill" data-state={tile.state}>{tile.label}</span>
            </li>
          ))}
        </ul>
        <p className="th-panel-foot tabular-nums">
          {checkedAt ? `Updated ${clock.format(checkedAt)}` : "Updating…"} · refreshes every 30 s
        </p>
      </section>
    );
  }

  return (
    <section className="premium-card p-4" aria-labelledby="system-status-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="system-status-title">System status</h2>
          <p className="mt-0.5 text-[12px]" style={{ color: "var(--th-text-muted)" }}>Platform services, agents and nightly jobs.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="sys-overall" data-state={overall} role="status">
            <StateIcon state={overall} />
            {server === null && !apiError ? "Checking…" : overallText}
          </span>
          <span className="text-[12px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
            {checkedAt ? `Updated ${clock.format(checkedAt)}` : "Updating…"} · auto 30s
          </span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((tile) => (
          <Tile key={tile.key} tile={tile} extra={tile.key === "api" ? <Sparkline samples={latency} /> : undefined} />
        ))}
      </div>
    </section>
  );
}
