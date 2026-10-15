import type { CSSProperties, ReactNode } from "react";
import { Star } from "lucide-react";
import { Device } from "../api/devices";
import { PatchStatus } from "../api/inventory";
import { DeviceHealthSummary } from "../types/telemetry";
import { deviceSite } from "../utils/location";
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
import { StatusDot, FreshnessState } from "./mobile/primitives";
import { ConnectButton } from "./ui";

/**
 * Mobile device card (docs/reference/MOBILE-DESIGN-SPEC.md — Devices,
 * "Rregulli i kartës LOCKED"): the device name is the dominant element on
 * its own line with client and group under it; health and state badges
 * follow, then user, IP, OS, agent and last seen in the footer.
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
  return (
    <span
      title={view?.title}
      className="th-tag"
      data-size="md"
      style={{ "--chip-tone": tone } as CSSProperties}
      data-neutral={tone === TONE.neutral || undefined}
    >
      {children ?? view?.label}
    </span>
  );
}

function DeviceTypeBadge({ device }: { device: Device }) {
  const cat = device.resolved_device_category;
  const dt = device.device_type;
  if (cat === "servers" || dt === "server")
    return <ToneBadge view={{ label: TERMS.server, tone: "var(--th-status-agent)" }} />;
  if (cat === "clientpc" || dt === "client") return <ToneBadge view={{ label: TERMS.clientPc, tone: TONE.info }} />;
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
  // The client's site where it has sites ("AL Durrës · Magazina"), the group otherwise.
  const place = deviceSite(device)?.text || device.group_name;
  const groupLine = place ? ` · ${place}` : "";

  const freshness = freshnessOf(device);
  const meta = [
    device.current_user
      ? {
          key: "user",
          node: (
            <span className="max-w-[110px] truncate" title={device.current_user}>
              {device.current_user}
            </span>
          ),
        }
      : null,
    osShort ? { key: "os", node: <span className="truncate">{osShort}</span> } : null,
    device.public_ip || device.local_ip
      ? { key: "ip", node: <span className="font-mono">{device.public_ip || device.local_ip}</span> }
      : null,
    device.agent_version
      ? {
          key: "agent",
          node: (
            <span style={{ color: AGENT_VERSION_TONE[agentVersion.status] }} title={agentVersion.title}>
              v{device.agent_version}
              {outdated && " · update"}
            </span>
          ),
        }
      : null,
  ].filter(Boolean) as { key: string; node: ReactNode }[];

  return (
    <div className="th-onb-card th-mdev-card th-device-card" data-state={freshness}>
      <div className="flex items-start gap-3">
        <span className="th-mdev-status" role="img" aria-label={freshness} title={freshness}>
          <StatusDot state={freshness} size={9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            {/* The whole card opens the device: this button's hit area is stretched
                over the card (th-stretched-button), while Favorite and Connect sit
                above it. A card that was itself a button could not contain them. */}
            <button
              type="button"
              onClick={onSelect}
              className="th-stretched-button min-w-0 truncate text-left text-[15px] font-semibold leading-5"
              style={{ color: "var(--th-text-primary)" }}
              title={displayName}
            >
              {displayName}
            </button>
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
          <p
            className="mt-0.5 truncate text-[12px]"
            style={{ color: "var(--th-text-secondary)" }}
            title={`${device.client_name || TERMS.noClient}${groupLine}`}
          >
            {device.client_name || <span style={{ color: "var(--th-text-muted)" }}>{TERMS.noClient}</span>}
            {groupLine && <span style={{ color: "var(--th-text-muted)" }}>{groupLine}</span>}
            {device.domain && <span style={{ color: "var(--th-text-faint)" }}> · {device.domain}</span>}
          </p>
        </div>
        <div className="relative z-[1] -mr-1 -mt-1 flex flex-none items-center gap-0.5">
          {onToggleFavorite && (
            <button
              type="button"
              onClick={onToggleFavorite}
              className="th-onb-action !h-9 !w-9"
              style={{ color: isFavorite ? "var(--th-status-stale)" : undefined }}
              title={isFavorite ? "Remove from favorites" : "Add to favorites"}
              aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={isFavorite}
            >
              <Star className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
            </button>
          )}
          <ConnectButton
            size="md"
            disabled={!canConnect}
            onClick={onConnect}
            title={connectTitle ?? (canConnect ? "Open TECHI Remote Support" : "Remote Support ID not resolved yet")}
          />
        </div>
      </div>

      {(healthScore != null ||
        device.resolved_device_category ||
        device.device_type ||
        patchView ||
        maintenanceView ||
        activeAction ||
        alerts?.critical ||
        alerts?.warning ||
        offlineBadge ||
        rsIssue) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1 pl-[21px]">
          {healthScore != null && (
            <ToneBadge
              view={{
                label: `Health ${healthScore}`,
                tone: HEALTH_TONE_COLOR[healthTone(health)],
                title: `Health score ${healthScore} of 100`,
              }}
            />
          )}
          <DeviceTypeBadge device={device} />
          {patchView && <ToneBadge view={patchView} />}
          {maintenanceView && <ToneBadge view={maintenanceView} />}
          {activeAction && <ActionIndicator entry={activeAction} />}
          {alerts?.critical ? <ToneBadge view={{ label: `${alerts.critical} critical`, tone: TONE.critical }} /> : null}
          {alerts?.warning ? (
            <ToneBadge
              view={{ label: `${alerts.warning} ${alerts.warning === 1 ? "warning" : "warnings"}`, tone: TONE.warning }}
            />
          ) : null}
          {offlineBadge && (
            <ToneBadge view={{ ...offlineBadge, title: offlineBadge.title ?? "Likely cause (inferred)" }} />
          )}
          {rsIssue && !offlineBadge && <ToneBadge view={rsIssue}>{TERMS.remoteSupport}</ToneBadge>}
        </div>
      )}

      <div className="th-mdev-meta">
        <span className="flex min-w-0 flex-1 items-center gap-x-2.5 overflow-hidden whitespace-nowrap">
          {meta.map((m, i) => (
            <span key={m.key} className={`flex items-center gap-x-2.5 ${m.key === "agent" ? "flex-none" : "min-w-0"}`}>
              {i > 0 && (
                <span aria-hidden="true" style={{ color: "var(--th-text-faint)" }}>
                  ·
                </span>
              )}
              {m.node}
            </span>
          ))}
        </span>
        <span className="flex-none font-medium tabular-nums" style={{ color: lastSeen.tone }}>
          {lastSeen.text}
        </span>
      </div>
    </div>
  );
}
