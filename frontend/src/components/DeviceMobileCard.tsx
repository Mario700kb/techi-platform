import { ExternalLink, Star } from "lucide-react";
import { Device } from "../api/devices";
import { PatchStatus } from "../api/inventory";
import { DeviceHealthSummary } from "../types/telemetry";
import { parseUTC } from "../utils/time";
import { ActiveActionEntry } from "./DevicesTable";
import { deviceDisplayName, deviceHostnameSubtitle } from "../utils/deviceLabel";
import { MBadge, MBadgeVariant, StatusDot, FreshnessState } from "./mobile/primitives";

/**
 * Mobile UI 2.0 device card (docs/reference/MOBILE-DESIGN-SPEC.md — Devices,
 * "Rregulli i kartës LOCKED"): the device name is the dominant element on
 * its own line; health + type/state badges sit below it; client/meta follow.
 */

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
  activePackageVersion?: string | null;
  activePackageSha256?: string | null;
  onSelect: () => void;
  onToggleFavorite?: () => void;
  onConnect: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAgentOutdated(device: Device, activeVersion?: string | null, activeSha256?: string | null) {
  if (!activeVersion) return false;
  if (!device.agent_version || device.agent_version !== activeVersion) return true;
  if (activeSha256) return (device.agent_sha256 ?? "").toLowerCase() !== activeSha256.toLowerCase();
  return false;
}

function agentVersionTitle(device: Device, activeVersion?: string | null, activeSha256?: string | null) {
  if (!activeVersion) return undefined;
  const active = activeSha256 ? `${activeVersion} | ${activeSha256.slice(0, 8)}` : activeVersion;
  const current = device.agent_sha256
    ? `${device.agent_version ?? "unknown"} | ${device.agent_sha256.slice(0, 8)}`
    : (device.agent_version ?? "unknown");
  return `Installed: ${current} | Active: ${active}`;
}

function freshnessOf(device: Device): FreshnessState {
  const state = device.freshness_state ?? device.status;
  if (state === "online") return "online";
  if (state === "stale") return "stale";
  return "offline";
}

function healthBadgeVariant(health?: DeviceHealthSummary): MBadgeVariant {
  const state = health?.health_state ?? "healthy";
  if (state === "critical") return "critical";
  if (state === "warning") return "warning";
  return "online";
}

function getDeviceTypeBadge(device: Device) {
  const cat = device.resolved_device_category;
  const dt = device.device_type;
  if (cat === "servers" || dt === "server") return <MBadge variant="server">SERVER</MBadge>;
  if (cat === "clientpc" || dt === "client") return <MBadge variant="ws">WS</MBadge>;
  return null;
}

function getPatchBadge(patch?: PatchStatus) {
  const state = patch?.patch_state ?? "unknown";
  if (state === "up_to_date")
    return (
      <span
        className="inline-flex items-center rounded-md px-[7px] py-[2.5px] text-[10.5px] font-bold"
        style={{ color: "var(--th-text-muted)", background: "var(--th-chip-bg)", border: "1px solid var(--th-border-subtle)" }}
      >
        patched
      </span>
    );
  if (state === "reboot_required") return <MBadge variant="critical">reboot</MBadge>;
  if (state === "updates_available") {
    const count = patch?.pending_updates ?? 0;
    return <MBadge variant="warning">{count > 0 ? `${count} upd` : "updates"}</MBadge>;
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
    <MBadge variant="maint" title={title}>
      maint.
    </MBadge>
  );
}

function getOfflineReasonBadge(device: Device, clientSummary?: ClientOfflineSummary) {
  const freshness = device.freshness_state ?? device.status;
  if (freshness === "online") return null;
  if (!device.last_seen) return null;

  const rsStatus = (device.rustdesk_status ?? "").toLowerCase();
  const rsInstall = (device.rustdesk_install_status ?? "").toLowerCase();
  if (["stopped", "not_running", "offline"].includes(rsStatus) && !["not_installed", "unknown", ""].includes(rsInstall))
    return { label: "RS stopped", variant: "agent" as MBadgeVariant };

  if (device.client_id && device.last_seen) {
    const t = new Date(device.last_seen).getTime();
    const nearbyPeers = clientSummary?.inactiveLastSeen.filter(
      (ls) => ls !== t && Math.abs(ls - t) < 10 * 60 * 1000
    ).length ?? 0;
    if (nearbyPeers >= 2) return { label: "Site?", variant: "critical" as MBadgeVariant };
  }

  if (freshness === "offline" && device.client_id && (clientSummary?.offlineCount ?? 0) <= 1)
    return { label: "Power?", variant: "offline" as MBadgeVariant };

  if (device.public_ip || device.local_ip) return { label: "Network", variant: "info" as MBadgeVariant };

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

function getLastSeenDisplay(lastSeen?: string): { text: string; color: string } {
  if (!lastSeen) return { text: "Never", color: "var(--th-text-faint)" };
  const diffMs = Date.now() - parseUTC(lastSeen).getTime();
  const mins = diffMs / 60_000;
  const hours = diffMs / 3_600_000;
  const days = diffMs / 86_400_000;
  if (mins < 5) return { text: "Just now", color: "var(--th-status-online)" };
  if (hours < 1) return { text: `${Math.floor(mins)}m ago`, color: "var(--th-status-online)" };
  if (hours < 24) return { text: `${Math.floor(hours)}h ago`, color: "var(--th-text-secondary)" };
  if (days < 7) return { text: `${Math.floor(days)}d ago`, color: "var(--th-status-stale)" };
  return { text: `${Math.floor(days)}d ago`, color: "var(--th-status-critical)" };
}

function ActionDot({ entry }: { entry: ActiveActionEntry }) {
  const isRunning = entry.status === "running";
  const isQueued = ["queued", "sent", "acknowledged"].includes(entry.status);
  const title = `${entry.action_type.replace(/_/g, " ")} — ${entry.status}`;
  if (isRunning)
    return (
      <span
        className="h-2 w-2 flex-none animate-spin rounded-full border border-t-transparent"
        style={{ borderColor: "var(--th-status-info)" }}
        title={title}
      />
    );
  if (isQueued)
    return <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: "var(--th-status-warning)" }} title={title} />;
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
  activePackageVersion,
  activePackageSha256,
  onSelect,
  onToggleFavorite,
  onConnect,
}: DeviceMobileCardProps) {
  const ls = getLastSeenDisplay(device.last_seen);
  const osShort = getOsShort(device.os_name);
  const offlineBadge = getOfflineReasonBadge(device, offlineSummary);
  const healthScore = health?.health_score;
  const displayName = deviceDisplayName(device);
  const hostnameSubtitle = deviceHostnameSubtitle(device);
  const outdated = isAgentOutdated(device, activePackageVersion, activePackageSha256);
  const rsIssue =
    device.rustdesk_install_status !== "not_installed" &&
    (device.rustdesk_status ?? "") !== "running";

  return (
    <div
      onClick={onSelect}
      className="cursor-pointer px-4 py-[13px] transition-colors active:bg-white/[0.04]"
      style={{ borderBottom: "1px solid var(--th-border-subtle)" }}
    >
      <div className="flex items-start gap-[11px]">
        <div className="mt-[5px] flex-none">
          <StatusDot state={freshnessOf(device)} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
          {/* L1: device name (dominant) + hostname when it differs */}
          <div className="flex min-w-0 items-baseline gap-2">
            <span
              className="min-w-0 truncate text-[16.5px] font-extrabold tracking-[-0.015em]"
              style={{ color: "var(--th-text-primary)" }}
              title={displayName}
            >
              {displayName}
            </span>
            {hostnameSubtitle && (
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11px]"
                style={{ color: "var(--th-text-muted)" }}
                title={device.hostname}
              >
                {hostnameSubtitle}
              </span>
            )}
          </div>

          {/* L2: health chip + type/state badges */}
          <div className="flex flex-wrap items-center gap-[5px]">
            {healthScore != null && (
              <MBadge variant={healthBadgeVariant(health)}>{healthScore}</MBadge>
            )}
            {getDeviceTypeBadge(device)}
            {getPatchBadge(patch)}
            {getMaintenanceBadge(device)}
            {activeAction && <ActionDot entry={activeAction} />}
            {alerts?.critical ? <MBadge variant="critical">{alerts.critical} crit</MBadge> : null}
            {alerts?.warning ? <MBadge variant="warning">{alerts.warning} warn</MBadge> : null}
            {offlineBadge && <MBadge variant={offlineBadge.variant}>{offlineBadge.label}</MBadge>}
            {rsIssue && !offlineBadge && (
              <span
                className="inline-flex items-center rounded-md px-[7px] py-[2.5px] text-[10.5px] font-bold"
                style={{
                  color: "var(--th-accent)",
                  background: "var(--th-accent-glow)",
                  border: "1px solid var(--th-accent-border)",
                }}
                title={`RS: ${device.rustdesk_status}`}
              >
                RS
              </span>
            )}
          </div>

          {/* L3: Client · Group · Domain */}
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[12px] font-bold" style={{ color: "var(--th-text-secondary)" }}>
              {device.client_name || <span style={{ color: "var(--th-text-muted)" }}>No client</span>}
              {device.group_name && <span style={{ color: "var(--th-text-muted)" }}> · {device.group_name}</span>}
            </span>
            {device.domain && (
              <span className="flex-none text-[11px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                {device.domain}
              </span>
            )}
          </div>

          {/* L4: User · IP · OS · Agent version · Last seen */}
          <div className="flex flex-wrap items-center gap-x-3 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
            {device.current_user && <span>{device.current_user}</span>}
            {(device.public_ip || device.local_ip) && (
              <span className="font-mono">{device.public_ip || device.local_ip}</span>
            )}
            {osShort && <span>{osShort}</span>}
            {device.agent_version ? (
              <span
                style={{ color: outdated ? "var(--th-status-warning)" : "var(--th-status-online)" }}
                title={agentVersionTitle(device, activePackageVersion, activePackageSha256)}
              >
                v{device.agent_version}
                {outdated && " !"}
              </span>
            ) : null}
            <span className="ml-auto font-bold" style={{ color: ls.color, fontVariantNumeric: "tabular-nums" }}>
              {ls.text}
            </span>
          </div>
        </div>

        {/* Actions cluster — favorites is existing functionality kept in the
            top-right cluster for continuity (Implementation Note: the
            mockup's device card does not depict the star; parity with
            pre-2.0 behavior is preserved here). */}
        <div className="flex flex-none items-center gap-1 self-center" onClick={(e) => e.stopPropagation()}>
          {onToggleFavorite && (
            <button
              type="button"
              onClick={onToggleFavorite}
              className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors active:bg-white/10"
              style={{ color: isFavorite ? "var(--th-status-stale)" : "var(--th-text-muted)" }}
              title={isFavorite ? "Remove from favorites" : "Add to favorites"}
            >
              <Star className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
            </button>
          )}
          <button
            type="button"
            disabled={!canConnect}
            onClick={onConnect}
            className="inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-bold transition-colors"
            style={{
              background: canConnect ? "var(--th-accent)" : "var(--th-chip-bg)",
              color: canConnect ? "#fff" : "var(--th-text-muted)",
              opacity: canConnect ? 1 : 0.5,
              cursor: canConnect ? "pointer" : "not-allowed",
              minWidth: 92,
            }}
            title={canConnect ? "Open TECHI Remote Support" : "Remote ID not resolved yet"}
          >
            <ExternalLink className="h-3.5 w-3.5 flex-none" />
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
