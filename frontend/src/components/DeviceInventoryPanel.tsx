import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  AppWindow,
  Cpu,
  Download,
  Loader2,
  Package,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Settings2,
  Square,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { isProtectedSoftware, PROTECTED_PROCESSES, PROTECTED_SERVICES } from "../api/deviceManage";
import { DeviceInventory, PatchState } from "../api/inventory";
import {
  type InventoryManage,
  type ManageRequest,
  ManageDialog,
  requestKey,
  RowActionButton,
  type RowOutcome,
  useManageOutcomes,
} from "./InventoryManage";
import { DISPLAY_LOCALE, formatDateTime, timeAgo } from "../utils/time";
import { humanize, TONE } from "../utils/deviceStatus";
import { Button, EmptyState } from "./ui";

type InventoryView = "software" | "services" | "processes";

const VIEWS: { id: InventoryView; label: string; icon: typeof Package }[] = [
  { id: "software", label: "Software", icon: AppWindow },
  { id: "services", label: "Services", icon: Settings2 },
  { id: "processes", label: "Processes", icon: Cpu },
];

const SEARCH_PLACEHOLDER: Record<InventoryView, string> = {
  software: "Search name, version or publisher…",
  services: "Search name or status…",
  processes: "Search name or PID…",
};

const NOUN: Record<InventoryView, [string, string]> = {
  software: ["app", "apps"],
  services: ["service", "services"],
  processes: ["process", "processes"],
};

const PATCH_STATE: Record<PatchState, { label: string; tone: string; hint: string }> = {
  up_to_date: { label: "Up to date", tone: TONE.online, hint: "All updates installed" },
  updates_available: { label: "Updates available", tone: TONE.warning, hint: "Updates are waiting" },
  reboot_required: { label: "Reboot required", tone: TONE.critical, hint: "Restart to finish updates" },
  unknown: { label: "Unknown", tone: TONE.neutral, hint: "Not reported by the agent" },
};

const COUNT_FORMAT = new Intl.NumberFormat(DISPLAY_LOCALE);
const MEMORY_FORMAT = new Intl.NumberFormat(DISPLAY_LOCALE, { maximumFractionDigits: 1 });

/** Process memory arrives in MB; show it the way Task Manager would ("312 MB", "1.5 GB"). */
function formatMemoryMb(mb: number | null | undefined): string {
  if (mb == null || !Number.isFinite(mb)) return "—";
  if (mb >= 1024) return `${MEMORY_FORMAT.format(mb / 1024)} GB`;
  if (mb >= 1) return `${MEMORY_FORMAT.format(Math.round(mb))} MB`;
  return `${MEMORY_FORMAT.format(Math.round(mb * 1024))} KB`;
}

function serviceTone(status: string): string {
  if (status === "running") return TONE.online;
  if (status === "stopped") return TONE.neutral;
  return TONE.warning;
}

/** One summary tile; a tone draws a status dot before the value. */
function Stat({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: string }) {
  return (
    <div className="th-inv-stat" style={tone ? ({ "--stat-tone": tone } as React.CSSProperties) : undefined}>
      <span className="th-inv-stat-label">{label}</span>
      <span className="th-inv-stat-value">
        {tone && <i aria-hidden />}
        {value}
      </span>
      <span className="th-inv-stat-hint">{hint}</span>
    </div>
  );
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** Under a row's name: its action under way, done, or why it failed. */
function OutcomeNote({ outcome }: { outcome?: RowOutcome }) {
  if (!outcome) return null;
  return (
    <p className="th-inv-outcome" data-state={outcome.state} title={outcome.message} role="status">
      {outcome.message}
    </p>
  );
}

function RunningCell({ outcome }: { outcome: RowOutcome }) {
  return (
    <span className="th-inv-running" aria-label={outcome.message}>
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
    </span>
  );
}

interface DeviceInventoryPanelProps {
  inventory: DeviceInventory | null;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
  /** End processes, control services, uninstall apps (Windows agents from 2.1.41). */
  manage?: InventoryManage;
}

/**
 * The drawer's Software tab: patch status on top, then one list at a time
 * (installed software, services, processes) behind a segmented control.
 * Mount it with `key={device.id}` so the view and search reset per device.
 */
export default function DeviceInventoryPanel({ inventory, loading, error, onLoad, manage }: DeviceInventoryPanelProps) {
  const [view, setView] = useState<InventoryView>("software");
  const [query, setQuery] = useState("");
  const [request, setRequest] = useState<ManageRequest | null>(null);
  const { track, outcomeFor } = useManageOutcomes(manage?.actions, onLoad);

  // Why a row's action cannot be used now; null when it can.
  const operateBlock = !manage ? "" : manage.blockedReason ?? (manage.canOperate ? null : "Your role cannot do this");
  const processBlock = (name: string) =>
    operateBlock ??
    (PROTECTED_PROCESSES.has(name.toLowerCase()) ? "Protected: Windows, the agent or Remote Support needs it" : null);
  const serviceStopBlock = (name: string) =>
    operateBlock ??
    (PROTECTED_SERVICES.has(name.toLowerCase()) ? "Protected: Windows or the agent needs it running" : null);
  const uninstallBlock = (name: string, method?: string | null) => {
    if (!manage) return "";
    if (manage.blockedReason) return manage.blockedReason;
    if (isProtectedSoftware(name)) return "Part of TECHI; it cannot be uninstalled from here";
    if (method !== "msi" && method !== "quiet") return "No silent uninstall; remove it over Remote Support";
    return manage.canUninstall ? null : "Administrators only";
  };

  // Software and services read best alphabetically; processes by memory, the
  // heaviest first, because that is what an operator looks for.
  const lists = useMemo(
    () => ({
      software: [...(inventory?.software ?? [])].sort((a, b) => byName(a.name, b.name)),
      services: [...(inventory?.services ?? [])].sort((a, b) =>
        byName(a.display_name || a.name, b.display_name || b.name),
      ),
      processes: [...(inventory?.processes ?? [])].sort(
        (a, b) => (b.memory_mb ?? -1) - (a.memory_mb ?? -1) || byName(a.name, b.name),
      ),
    }),
    [inventory],
  );

  const q = query.trim().toLowerCase();
  const software = useMemo(
    () =>
      q
        ? lists.software.filter(
            (s) =>
              s.name.toLowerCase().includes(q) ||
              (s.version ?? "").toLowerCase().includes(q) ||
              (s.publisher ?? "").toLowerCase().includes(q),
          )
        : lists.software,
    [lists, q],
  );
  const services = useMemo(
    () =>
      q
        ? lists.services.filter(
            (s) =>
              s.name.toLowerCase().includes(q) ||
              (s.display_name ?? "").toLowerCase().includes(q) ||
              s.status.toLowerCase().includes(q),
          )
        : lists.services,
    [lists, q],
  );
  const processes = useMemo(
    () =>
      q
        ? lists.processes.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid).includes(q))
        : lists.processes,
    [lists, q],
  );

  const total = lists[view].length;
  const shown = { software: software.length, services: services.length, processes: processes.length }[view];
  const patch = PATCH_STATE[inventory?.patch_state ?? "unknown"] ?? PATCH_STATE.unknown;
  const viewIndex = VIEWS.findIndex((v) => v.id === view);
  const ViewIcon = VIEWS[viewIndex].icon;

  return (
    <>
      <section className="mb-4">
        <div className="mb-2 flex min-h-8 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="premium-kicker">Inventory</p>
            {inventory?.collected_at && (
              <p className="mt-0.5 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                <span title={formatDateTime(inventory.collected_at)}>Collected {timeAgo(inventory.collected_at)}</span>
              </p>
            )}
          </div>
          {inventory && (
            <Button size="sm" variant="secondary" className="flex-none" onClick={onLoad} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          )}
        </div>

        {error && (
          <div className="th-drawer-callout mb-3 flex items-start gap-2 text-[13px]" data-tone="warning" role="alert">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Inventory could not be loaded</p>
              <p className="mt-0.5 text-[12px]" style={{ color: "var(--th-text-secondary)" }}>
                {error}
              </p>
            </div>
            <Button size="sm" variant="secondary" className="flex-none" onClick={onLoad} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Retry
            </Button>
          </div>
        )}

        {!inventory && !error && (
          <div className="th-drawer-card">
            <EmptyState
              className="!py-6"
              icon={<Package className="h-5 w-5" />}
              title="Inventory not loaded"
              description="Patch status, installed software, services and processes for this device. Loaded on request to keep the drawer fast."
              action={
                <Button size="sm" onClick={onLoad} disabled={loading}>
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  {loading ? "Loading…" : "Load inventory"}
                </Button>
              }
            />
          </div>
        )}

        {inventory && (
          <div className="th-inv-stats" aria-label="Patch status">
            <Stat label="Patch status" tone={patch.tone} value={patch.label} hint={patch.hint} />
            <Stat
              label="Pending updates"
              value={inventory.pending_updates != null ? COUNT_FORMAT.format(inventory.pending_updates) : "—"}
              hint={
                inventory.pending_updates == null
                  ? "Not reported"
                  : inventory.pending_updates > 0
                    ? "Waiting to install"
                    : "Nothing to install"
              }
            />
            <Stat
              label="Reboot"
              tone={inventory.reboot_required ? TONE.critical : TONE.online}
              value={inventory.reboot_required ? "Required" : "Not required"}
              hint={inventory.reboot_required ? "Restart to finish updates" : "No restart pending"}
            />
            <Stat
              label="Last update"
              value={formatDateTime(inventory.last_update_at)}
              hint={inventory.last_update_at ? timeAgo(inventory.last_update_at) : "Not reported"}
            />
          </div>
        )}
      </section>

      {inventory && (
        <section className="mb-4">
          <div className="th-inv-card">
            <div className="th-inv-toolbar">
              <div
                className="th-segmented"
                role="radiogroup"
                aria-label="Inventory list"
                data-thumb
                style={{ "--seg-n": VIEWS.length, "--seg-i": viewIndex } as React.CSSProperties}
              >
                {VIEWS.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    role="radio"
                    aria-checked={view === v.id}
                    onClick={() => setView(v.id)}
                  >
                    <v.icon className="h-3.5 w-3.5" aria-hidden />
                    {v.label}
                    <span className="th-inv-seg-count">{COUNT_FORMAT.format(lists[v.id].length)}</span>
                  </button>
                ))}
              </div>
              {total > 0 && (
                <div className="flex items-center gap-3">
                  <label className="th-search flex-1">
                    <Search className="h-3.5 w-3.5 flex-none" aria-hidden />
                    <input
                      type="text"
                      aria-label={`Search ${view}`}
                      placeholder={SEARCH_PLACEHOLDER[view]}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                      <button
                        type="button"
                        className="th-inv-clear"
                        aria-label="Clear search"
                        onClick={() => setQuery("")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </label>
                  <span className="th-inv-count" aria-live="polite">
                    {q && `${COUNT_FORMAT.format(shown)} of `}
                    {COUNT_FORMAT.format(total)} {NOUN[view][total === 1 ? 0 : 1]}
                  </span>
                </div>
              )}
            </div>

            {total === 0 ? (
              <EmptyState
                className="!py-8"
                icon={<ViewIcon className="h-5 w-5" />}
                title={`No ${view} reported`}
                description={`The agent's last inventory did not include ${view}. Refresh to collect it again.`}
              />
            ) : shown === 0 ? (
              <EmptyState
                className="!py-8"
                icon={<Search className="h-5 w-5" />}
                title="No matches"
                description={`Nothing in ${view} matches “${query.trim()}”.`}
                action={
                  <Button size="sm" variant="secondary" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                }
              />
            ) : (
              <div className="th-inv-scroll">
                {view === "software" && (
                  <table className="th-inv-table">
                    <colgroup>
                      <col />
                      <col style={{ width: "34%" }} />
                      {manage && <col style={{ width: 52 }} />}
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col">Application</th>
                        <th scope="col" className="th-inv-end">
                          Version
                        </th>
                        {manage && (
                          <th scope="col">
                            <span className="sr-only">Actions</span>
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {software.map((s, idx) => {
                        const req: ManageRequest | null =
                          s.uninstall_key && (s.uninstall === "msi" || s.uninstall === "quiet")
                            ? { kind: "uninstall", name: s.name, uninstallKey: s.uninstall_key, method: s.uninstall }
                            : null;
                        const outcome = req ? outcomeFor(requestKey(req)) : undefined;
                        return (
                          <tr key={`${s.name}-${s.version ?? ""}-${idx}`} data-gone={outcome?.state === "done" || undefined}>
                            <td>
                              <p className="th-inv-primary" title={s.name}>
                                {s.name}
                              </p>
                              <p className="th-inv-secondary" title={s.publisher ?? undefined}>
                                {s.publisher || "Unknown publisher"}
                              </p>
                              <OutcomeNote outcome={outcome} />
                            </td>
                            <td className="th-inv-end">
                              <span className="th-inv-mono" title={s.version ?? undefined}>
                                {s.version || "—"}
                              </span>
                            </td>
                            {manage && (
                              <td className="th-inv-actions">
                                {outcome?.state === "running" ? (
                                  <RunningCell outcome={outcome} />
                                ) : outcome?.state === "done" ? null : (
                                  <RowActionButton
                                    icon={Trash2}
                                    label={`Uninstall ${s.name}`}
                                    danger
                                    blockedReason={uninstallBlock(s.name, s.uninstall)}
                                    onClick={() => req && setRequest(req)}
                                  />
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {view === "services" && (
                  <table className="th-inv-table">
                    <colgroup>
                      <col />
                      <col style={{ width: "24%" }} />
                      <col style={{ width: "22%" }} />
                      {manage && <col style={{ width: 84 }} />}
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col">Service</th>
                        <th scope="col">Status</th>
                        <th scope="col" className="th-inv-end">
                          Startup
                        </th>
                        {manage && (
                          <th scope="col">
                            <span className="sr-only">Actions</span>
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {services.map((s) => {
                        const label = s.display_name || s.name;
                        const outcome = outcomeFor(`service:${s.name.toLowerCase()}`);
                        // Until the next inventory, a service shows what was just done to it.
                        const done = outcome?.state === "done" && outcome.request.kind === "service" ? outcome.request : null;
                        const status = done ? (done.operation === "stop" ? "stopped" : "running") : s.status;
                        const ask = (operation: "start" | "stop" | "restart") =>
                          setRequest({ kind: "service", name: s.name, label, operation });
                        return (
                          <tr key={s.name}>
                            <td>
                              <p className="th-inv-primary" title={label}>
                                {label}
                              </p>
                              <p className="th-inv-secondary th-inv-mono" title={s.name}>
                                {s.name}
                              </p>
                              <OutcomeNote outcome={outcome} />
                            </td>
                            <td>
                              <span
                                className="th-status-chip"
                                style={{ "--chip-tone": serviceTone(status) } as React.CSSProperties}
                              >
                                <i />
                                {humanize(status)}
                              </span>
                            </td>
                            <td className="th-inv-end th-inv-muted">{s.startup_type ? humanize(s.startup_type) : "—"}</td>
                            {manage && (
                              <td className="th-inv-actions">
                                {outcome?.state === "running" ? (
                                  <RunningCell outcome={outcome} />
                                ) : status === "running" ? (
                                  <>
                                    <RowActionButton
                                      icon={RotateCw}
                                      label={`Restart ${label}`}
                                      blockedReason={serviceStopBlock(s.name)}
                                      onClick={() => ask("restart")}
                                    />
                                    <RowActionButton
                                      icon={Square}
                                      label={`Stop ${label}`}
                                      danger
                                      blockedReason={serviceStopBlock(s.name)}
                                      onClick={() => ask("stop")}
                                    />
                                  </>
                                ) : (
                                  <RowActionButton
                                    icon={Play}
                                    label={`Start ${label}`}
                                    blockedReason={operateBlock}
                                    onClick={() => ask("start")}
                                  />
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {view === "processes" && (
                  <table className="th-inv-table">
                    <colgroup>
                      <col />
                      <col style={{ width: "20%" }} />
                      <col style={{ width: "24%" }} />
                      {manage && <col style={{ width: 52 }} />}
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col">Process</th>
                        <th scope="col" className="th-inv-end">
                          PID
                        </th>
                        <th scope="col" className="th-inv-end">
                          Memory
                        </th>
                        {manage && (
                          <th scope="col">
                            <span className="sr-only">Actions</span>
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {processes.map((p) => {
                        const outcome = outcomeFor(`process:${p.pid}`);
                        return (
                          <tr key={p.pid} data-gone={outcome?.state === "done" || undefined}>
                            <td>
                              <p className="th-inv-primary" title={p.name}>
                                {p.name}
                              </p>
                              <OutcomeNote outcome={outcome} />
                            </td>
                            <td className="th-inv-end th-inv-mono th-inv-muted">{p.pid}</td>
                            <td className="th-inv-end th-inv-num">{formatMemoryMb(p.memory_mb)}</td>
                            {manage && (
                              <td className="th-inv-actions">
                                {outcome?.state === "running" ? (
                                  <RunningCell outcome={outcome} />
                                ) : outcome?.state === "done" ? null : (
                                  <RowActionButton
                                    icon={XCircle}
                                    label={`End ${p.name}`}
                                    danger
                                    blockedReason={processBlock(p.name)}
                                    onClick={() => setRequest({ kind: "kill", pid: p.pid, name: p.name })}
                                  />
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {manage && request && (
        <ManageDialog
          request={request}
          manage={manage}
          onClose={() => setRequest(null)}
          onQueued={(req, action) => {
            manage.onQueued(action);
            track(req, action);
            setRequest(null);
          }}
        />
      )}
    </>
  );
}
