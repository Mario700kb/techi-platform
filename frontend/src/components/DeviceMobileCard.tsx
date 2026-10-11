import type { ReactNode } from "react";
import { Star } from "lucide-react";
import { Device } from "../api/devices";
import { PatchStatus } from "../api/inventory";
import { DeviceHealthSummary } from "../types/telemetry";
import { deviceDisplayName, deviceHostnameSubtitle } from "../utils/deviceLabel";
import { TERMS, TONE } from "../utils/deviceStatus";
import {
  ActionIndicator,
  ActiveActionEntry,
  BadgeView,
  ClientOfflineSummary,
  HEALTH_TONE_COLOR,
  healthTone,
  lastSeenView,
  maintenanceBadge,
  offlineReasonBadge,
  patchBadge,
  remoteSupportIssue,
} from "../utils/deviceBadges";
import type { VersionStatus } from "../utils/version";
import { MBadge, StatusDot, FreshnessState } from "./mobile/primitives";
import { ConnectButton } from "./ui";

/**
 * Mobile UI 2.0 device card (docs/reference/MOBILE-DESIGN-SPEC.md — Devices,
 * "Rregulli i kartës LOCKED"): the device name is the dominant element on
 * its own line; health + type/state badges sit below it; client/meta follow.
 */

export interface DeviceMobileCardProps {
  device: Device;
  health?: DeviceHealthSummary;
  patch?: PatchStatus;
  activeAction?: ActiveActionEntry;
  alerts?: { critical: number; warning: number };
  offlineSummary?: ClientOfflineSummary;
  canConnect: boolean;
  isFavorite: boolean;
  // Resolved by the table against the device's own platform, so a MikroTik
  // or Linux device is never measured against the Windows package.
  agentVersion: { status: VersionStatus; title?: string };
  onSelect: () => void;
  onToggleFavorite?: () => void;
  onConnect: () => void;
  // Non-Windows devices open the Drawer's Connect menu instead of Remote
  // Support — the tooltip must say so, not the Windows-specific default.
  connectTitle?: string;
}

function freshnessOf(device: Device): FreshnessState {
  const state = device.freshness_state ?? device.status;
  if (state === "online") return "online";
  if (state === "stale") return "stale";
  return "offline";
}

function ToneBadge({ view, children }: { view?: BadgeView; children?: ReactNode }) {
  const tone = view?.tone ?? TONE.neutral;
  const neutral = tone === TONE.neutral;
  return (
    <span
      title={view?.title}
      className="inline-flex items-center rounded-md px-[7px] py-[2.5px] text-[11px] font-bold"
      style={
        neutral
          ? { color: "var(--th-text-muted)", background: "var(--th-chip-bg)", border: "1px solid var(--th-border-subtle)" }
          : {
              color: tone,
              background: `color-mix(in srgb, ${tone} 13%, transparent)`,
              border: `1px solid color-mix(in srgb, ${tone} 26%, transparent)`,
            }
      }
    >
      {children ?? view?.label}
    </span>
  );
}

function DeviceTypeBadge({ device }: { device: Device }) {
  const cat = device.resolved_device_category;
  const dt = device.device_type;
  if (cat === "servers" || dt === "server") return <MBadge variant="server">{TERMS.server}</MBadge>;
  if (cat === "clientpc" || dt === "client") return <MBadge variant="ws">{TERMS.clientPc}</MBadge>;
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

const AGENT_VERSION_TONE: Record<VersionStatus, string> = {
  current: TONE.online,
  outdated: TONE.warning,
  ahead: TONE.info,
  unknown: "var(--th-text-muted)",
};

export function DeviceMobileCard({
  device,
  health,
  patch,
  activeAction,
  alerts,
  offlineSummary,
  canConnect,
  isFavorite,
  agentVersion,
  onSelect,
  onToggleFavorite,
  onConnect,
  connectTitle,
}: DeviceMobileCardProps) {
  const lastSeen = lastSeenView(device.last_seen);
  const osShort = getOsShort(device.os_name);
  const offlineBadge = offlineReasonBadge(device, offlineSummary);
  const healthScore = health?.health_score;
  const displayName = deviceDisplayName(device);
  const hostnameSubtitle = deviceHostnameSubtitle(device);
  const outdated = agentVersion.status === "outdated";
  const rsIssue = remoteSupportIssue(device);
  const patchView = patchBadge(patch);
  const maintenanceView = maintenanceBadge(device);
  const groupLine = device.group_name ? ` · ${device.group_name}` : "";

  return (
    <div
      onClick={onSelect}
      className="th-device-card cursor-pointer px-4 py-[13px] transition-colors active:bg-[var(--th-sidebar-nav-hover)]"
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
              className="min-w-0 truncate text-[16px] font-extrabold tracking-[-0.015em]"
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
              <ToneBadge view={{ label: String(healthScore), tone: HEALTH_TONE_COLOR[healthTone(health)], title: `Health score ${healthScore} of 100` }} />
            )}
            <DeviceTypeBadge device={device} />
            {patchView && <ToneBadge view={patchView} />}
            {maintenanceView && <ToneBadge view={maintenanceView} />}
            {activeAction && <ActionIndicator entry={activeAction} />}
            {alerts?.critical ? <ToneBadge view={{ label: `${alerts.critical} critical`, tone: TONE.critical }} /> : null}
            {alerts?.warning ? <ToneBadge view={{ label: `${alerts.warning} ${alerts.warning === 1 ? "warning" : "warnings"}`, tone: TONE.warning }} /> : null}
            {offlineBadge && <ToneBadge view={{ ...offlineBadge, title: offlineBadge.title ?? "Likely cause (inferred)" }} />}
            {rsIssue && !offlineBadge && <ToneBadge view={rsIssue}>{TERMS.remoteSupport}</ToneBadge>}
          </div>

          {/* L3: Client · Group · Domain */}
          <div className="flex items-center justify-between gap-2">
            <span
              className="min-w-0 truncate text-[12px] font-bold"
              style={{ color: "var(--th-text-secondary)" }}
              title={`${device.client_name || TERMS.noClient}${groupLine}`}
            >
              {device.client_name || <span style={{ color: "var(--th-text-muted)" }}>{TERMS.noClient}</span>}
              {groupLine && <span style={{ color: "var(--th-text-muted)" }}>{groupLine}</span>}
            </span>
            {device.domain && (
              <span className="flex-none text-[11px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                {device.domain}
              </span>
            )}
          </div>

          {/* L4: User · IP · OS · Agent version · Last seen */}
          <div className="flex flex-wrap items-center gap-x-3 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
            {device.current_user && <span className="max-w-[140px] truncate" title={device.current_user}>{device.current_user}</span>}
            {(device.public_ip || device.local_ip) && (
              <span className="font-mono">{device.public_ip || device.local_ip}</span>
            )}
            {osShort && <span>{osShort}</span>}
            {device.agent_version ? (
              <span style={{ color: AGENT_VERSION_TONE[agentVersion.status] }} title={agentVersion.title}>
                v{device.agent_version}
                {outdated && " · update"}
              </span>
            ) : null}
            <span className="ml-auto font-bold" style={{ color: lastSeen.tone, fontVariantNumeric: "tabular-nums" }}>
              {lastSeen.text}
            </span>
          </div>
        </div>

        {/* Favorites stay in the top-right cluster for continuity with the
            pre-2.0 card (the mockup does not depict the star). */}
        <div className="flex flex-none items-center gap-1 self-center" onClick={(e) => e.stopPropagation()}>
          {onToggleFavorite && (
            <button
              type="button"
              onClick={onToggleFavorite}
              className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors active:bg-[var(--th-sidebar-nav-hover)]"
              style={{ color: isFavorite ? "var(--th-status-stale)" : "var(--th-text-muted)" }}
              title={isFavorite ? "Remove from favorites" : "Add to favorites"}
              aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={isFavorite}
            >
              <Star className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
            </button>
          )}
          <ConnectButton
            size="lg"
            disabled={!canConnect}
            onClick={onConnect}
            title={connectTitle ?? (canConnect ? "Open TECHI Remote Support" : "Remote Support ID not resolved yet")}
          />
        </div>
      </div>
    </div>
  );
}
