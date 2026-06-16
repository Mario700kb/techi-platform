import React from "react";
import { ExternalLink, Star } from "lucide-react";
import { Device } from "../api/devices";
import { PatchStatus } from "../api/inventory";
import { DeviceHealthSummary } from "../types/telemetry";
import { Badge } from "./ui";
import { parseUTC } from "../utils/time";
import { ActiveActionEntry } from "./DevicesTable";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClientOfflineSummary {
  offlineCount: number;
  inactiveLastSeen: number[];
}

export interface DeviceMobileCardProps {
  device: Device;
  health?: DeviceHealthSummary;
  patch?: PatchStatus;
  activeAction?: ActiveActionEntry;
  alerts?: { critical: number; warning: number };
  offlineSummary?: ClientOfflineSummary;
  canConnect: boolean;
  isFavorite: boolean;
  onSelect: () => void;
  onToggleFavorite?: () => void;
  onConnect: () => void;
}

// ─── Visual constants (mirrors DevicesTable) ─────────────────────────────────

const compactBadgeClass = "!min-h-[1.35rem] !px-1.5 !py-0.5 !text-[10px] !leading-3";
const subtleBadgeClass = `border-white/10 bg-white/[0.025] text-slate-400 ${compactBadgeClass}`;

// ─── Cell helpers (duplicated from DevicesTable so the file stays importable
//     without pulling in the full 1700-line component) ──────────────────────

function renderStatusDot(device: Device, health?: DeviceHealthSummary) {
  const state = device.freshness_state ?? device.status;
  const isOnline = state === "online";
  const isStale = state === "stale";
  const score = health?.health_score ?? null;
  const healthState = health?.health_state ?? "healthy";
  const scoreColor =
    score === null
      ? "text-slate-700"
      : healthState === "critical"
      ? "text-red-400"
      : healthState === "warning"
      ? "text-amber-400"
      : "text-emerald-400/80";

  return (
    <div
      className="flex flex-col items-center gap-0.5"
      title={`${state}${score != null ? ` · health ${score}` : ""}`}
    >
      <span
        className={`inline-block h-2.5 w-2.5 flex-none rounded-full ${
          isOnline
            ? "bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.7)]"
            : isStale
            ? "bg-amber-300 shadow-[0_0_4px_rgba(251,191,36,0.6)]"
            : "bg-slate-600"
        }`}
      />
      <span className={`text-[9px] font-bold tabular-nums leading-none ${scoreColor}`}>
        {score != null ? score : "—"}
      </span>
    </div>
  );
}

function getDeviceTypeBadge(device: Device) {
  const cat = device.resolved_device_category;
  const dt = device.device_type;
  if (cat === "servers" || dt === "server")
    return (
      <span className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide"
        style={{ color: "#a78bfa", background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.22)" }}>
        Server
      </span>
    );
  if (cat === "clientpc" || dt === "client")
    return (
      <span className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide"
        style={{ color: "#60a5fa", background: "rgba(96,165,250,0.1)", border: "1px solid rgba(96,165,250,0.2)" }}>
        WS
      </span>
    );
  return null;
}

function getPatchBadge(patch?: PatchStatus) {
  const state = patch?.patch_state ?? "unknown";
  if (state === "up_to_date")
    return <Badge variant="ghost" className={subtleBadgeClass}>patched</Badge>;
  if (state === "reboot_required")
    return (
      <Badge variant="ghost" className={`border-red-400/20 bg-red-400/[0.06] text-red-300 ${compactBadgeClass}`}>
        reboot
      </Badge>
    );
  if (state === "updates_available") {
    const count = patch?.pending_updates ?? 0;
    return (
      <Badge variant="ghost" className={`border-amber-400/20 bg-amber-400/[0.06] text-amber-300 ${compactBadgeClass}`}>
        {count > 0 ? `${count} upd` : "updates"}
      </Badge>
    );
  }
  return null;
}

function getMaintenanceBadge(device: Device) {
  if (!device.is_in_maintenance) return null;
  const title = device.maintenance_ends_at
    ? `In maintenance until ${parseUTC(device.maintenance_ends_at).toLocaleString()}`
    : device.maintenance_note
    ? `In maintenance: ${device.maintenance_note}`
    : "In maintenance";
  return (
    <Badge variant="ghost" className={`border-sky-400/30 bg-sky-400/10 text-sky-200 ${compactBadgeClass}`} title={title}>
      maint.
    </Badge>
  );
}

function getOfflineReasonBadge(device: Device, clientSummary?: ClientOfflineSummary) {
  const freshness = device.freshness_state ?? device.status;
  if (freshness === "online") return null;
  if (!device.last_seen) return null;

  const rsStatus = (device.rustdesk_status ?? "").toLowerCase();
  const rsInstall = (device.rustdesk_install_status ?? "").toLowerCase();
  if (["stopped", "not_running", "offline"].includes(rsStatus) && !["not_installed", "unknown", ""].includes(rsInstall))
    return { label: "RS stopped", color: "#f97316", bg: "rgba(249,115,22,0.12)", border: "rgba(249,115,22,0.25)" };

  if (device.client_id && device.last_seen) {
    const t = new Date(device.last_seen).getTime();
    const nearbyPeers = clientSummary?.inactiveLastSeen.filter(
      (ls) => ls !== t && Math.abs(ls - t) < 10 * 60 * 1000
    ).length ?? 0;
    if (nearbyPeers >= 2)
      return { label: "Site?", color: "#f87171", bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.3)" };
  }

  if (freshness === "offline" && device.client_id && (clientSummary?.offlineCount ?? 0) <= 1)
    return { label: "Power?", color: "#94a3b8", bg: "rgba(148,163,184,0.08)", border: "rgba(148,163,184,0.2)" };

  if (device.public_ip || device.local_ip)
    return { label: "Network", color: "#60a5fa", bg: "rgba(96,165,250,0.1)", border: "rgba(96,165,250,0.22)" };

  return null;
}

function getOsShort(osName?: string): string | null {
  if (!osName) return null;
  const s = osName.toLowerCase();
  if (s.includes("windows server")) {
    const year = osName.match(/20\d{2}/)?.[0];
    return year ? `Server ${year}` : "Server";
  }
  if (s.includes("windows 11")) return "Win 11";
  if (s.includes("windows 10")) return "Win 10";
  if (s.includes("windows")) return "Windows";
  return null;
}

function getLastSeenDisplay(lastSeen?: string): { text: string; cls: string } {
  if (!lastSeen) return { text: "Never", cls: "text-slate-600" };
  const diffMs = Date.now() - parseUTC(lastSeen).getTime();
  const mins = diffMs / 60_000;
  const hours = diffMs / 3_600_000;
  const days = diffMs / 86_400_000;
  if (mins < 5) return { text: "Just now", cls: "text-emerald-400" };
  if (hours < 1) return { text: `${Math.floor(mins)}m ago`, cls: "text-emerald-400" };
  if (hours < 24) return { text: `${Math.floor(hours)}h ago`, cls: "text-slate-300" };
  if (days < 7) return { text: `${Math.floor(days)}d ago`, cls: "text-amber-400" };
  return { text: `${Math.floor(days)}d ago`, cls: "text-red-400" };
}

function ActionDot({ entry }: { entry: ActiveActionEntry }) {
  const isRunning = entry.status === "running";
  const isQueued = ["queued", "sent", "acknowledged"].includes(entry.status);
  const title = `${entry.action_type.replace(/_/g, " ")} — ${entry.status}`;
  if (isRunning)
    return <span className="h-2 w-2 flex-none animate-spin rounded-full border border-sky-400 border-t-transparent" title={title} />;
  if (isQueued)
    return <span className="h-1.5 w-1.5 flex-none rounded-full bg-amber-400/80" title={title} />;
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DeviceMobileCard({
  device,
  health,
  patch,
  activeAction,
  alerts,
  offlineSummary,
  canConnect,
  isFavorite,
  onSelect,
  onToggleFavorite,
  onConnect,
}: DeviceMobileCardProps) {
  const ls = getLastSeenDisplay(device.last_seen);
  const osShort = getOsShort(device.os_name);
  const offlineBadge = getOfflineReasonBadge(device, offlineSummary);
  const healthScore = health?.health_score;
  const isLowHealth = healthScore != null && healthScore < 60;
  const rsIssue =
    device.rustdesk_install_status !== "not_installed" &&
    (device.rustdesk_status ?? "") !== "running";

  return (
    <div
      onClick={onSelect}
      className="cursor-pointer px-4 py-3 transition-colors active:bg-white/[0.04]"
      style={{ borderBottom: "1px solid var(--th-border-subtle)" }}
    >
      <div className="flex items-start gap-2.5">
        {/* Status dot */}
        <div className="mt-0.5 flex-none">{renderStatusDot(device, health)}</div>

        <div className="min-w-0 flex-1">
          {/* Row 1: hostname + action buttons */}
          <div className="flex items-center justify-between gap-2">
            <span
              className="min-w-0 truncate text-[13px] font-bold leading-tight"
              style={{ color: "var(--th-text-primary)" }}
              title={device.hostname || "Unknown"}
            >
              {device.hostname || "Unknown"}
            </span>
            {/* Taps stop propagation so they don't open the drawer */}
            <div
              className="flex flex-none items-center gap-1"
              onClick={(e) => e.stopPropagation()}
            >
              {onToggleFavorite && (
                <button
                  type="button"
                  onClick={onToggleFavorite}
                  className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors active:bg-white/10"
                  style={{ color: isFavorite ? "#fbbf24" : "var(--th-text-muted)" }}
                  title={isFavorite ? "Remove from favorites" : "Add to favorites"}
                >
                  <Star className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
                </button>
              )}
              <button
                type="button"
                disabled={!canConnect}
                onClick={onConnect}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold transition-colors"
                style={{
                  background: canConnect ? "rgba(249,115,22,0.15)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${canConnect ? "rgba(249,115,22,0.3)" : "var(--th-border-subtle)"}`,
                  color: canConnect ? "#f97316" : "var(--th-text-muted)",
                  opacity: canConnect ? 1 : 0.45,
                  cursor: canConnect ? "pointer" : "not-allowed",
                  minWidth: 88,
                }}
                title={canConnect ? "Open TECHI Remote Support" : "Remote ID not resolved yet"}
              >
                <ExternalLink className="h-3.5 w-3.5 flex-none" />
                Connect
              </button>
            </div>
          </div>

          {/* Row 2: badges */}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {getDeviceTypeBadge(device)}
            {getPatchBadge(patch)}
            {getMaintenanceBadge(device)}
            {activeAction && <ActionDot entry={activeAction} />}
            {alerts?.critical ? (
              <span className="inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-bold"
                style={{ color: "#f87171", background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.22)" }}>
                <span className="h-1.5 w-1.5 rounded-full bg-red-400" style={{ boxShadow: "0 0 3px rgba(248,113,113,0.7)" }} />
                {alerts.critical}
              </span>
            ) : null}
            {alerts?.warning ? (
              <span className="inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-bold"
                style={{ color: "#fbbf24", background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.22)" }}>
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                {alerts.warning}
              </span>
            ) : null}
            {offlineBadge && (
              <span className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-semibold"
                style={{ color: offlineBadge.color, background: offlineBadge.bg, border: `1px solid ${offlineBadge.border}` }}>
                {offlineBadge.label}
              </span>
            )}
            {isLowHealth && (
              <span className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-bold"
                style={{ color: "#f87171", background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.22)" }}
                title={`Health score: ${healthScore}`}>
                H:{healthScore}
              </span>
            )}
            {rsIssue && !offlineBadge && (
              <span className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-semibold"
                style={{ color: "#f97316", background: "rgba(249,115,22,0.1)", border: "1px solid rgba(249,115,22,0.22)" }}
                title={`RS: ${device.rustdesk_status}`}>
                RS
              </span>
            )}
          </div>

          {/* Row 3: Client · Group · Domain */}
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] font-semibold" style={{ color: "var(--th-text-secondary)" }}>
              {device.client_name || <span style={{ color: "var(--th-text-muted)" }}>No client</span>}
              {device.group_name && (
                <span style={{ color: "var(--th-text-muted)" }}> · {device.group_name}</span>
              )}
            </span>
            {device.domain && (
              <span className="flex-none text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                {device.domain}
              </span>
            )}
          </div>

          {/* Row 4: User · IP · OS · Last seen */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[10px]" style={{ color: "var(--th-text-muted)" }}>
            {device.current_user && <span>{device.current_user}</span>}
            {(device.public_ip || device.local_ip) && (
              <span className="font-mono">{device.public_ip || device.local_ip}</span>
            )}
            {osShort && <span>{osShort}</span>}
            <span className={`ml-auto font-semibold tabular-nums ${ls.cls}`}>{ls.text}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
