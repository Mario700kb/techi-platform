// Badge and label rules shared by the desktop device table and the mobile
// device cards, so a device reads the same on both.
import { Loader2 } from "lucide-react";
import type { Device } from "../api/devices";
import type { ActionStatus } from "../api/actions";
import type { PatchStatus } from "../api/inventory";
import type { DeviceHealthSummary } from "../types/telemetry";
import { TERMS, TONE, humanize, remoteSupportStatus } from "./deviceStatus";
import { formatDateTime, parseUTC } from "./time";
import { compareVersions, type VersionStatus } from "./version";

export interface ActiveActionEntry {
  action_type: string;
  status: ActionStatus;
}

export interface ClientOfflineSummary {
  offlineCount: number;
  inactiveLastSeen: number[];
}

export interface BadgeView {
  label: string;
  tone: string;
  title?: string;
}

// ─── Agent version ───────────────────────────────────────────────────────────

export interface AgentVersionSources {
  activePackageVersion?: string | null;
  activePackageSha256?: string | null;
  activeConnectorVersions?: Record<string, string>;
  activeAgentVersions?: Record<string, string>;
}

function devicePlatform(device: Device): string {
  return (device.platform || "windows").toLowerCase();
}

function isAgentOutdated(device: Device, activeVersion?: string | null, activeSha256?: string | null) {
  if (!activeVersion) return false;
  if (!device.agent_version || device.agent_version !== activeVersion) return true;
  if (activeSha256) return (device.agent_sha256 ?? "").toLowerCase() !== activeSha256.toLowerCase();
  return false;
}

function windowsAgentVersionTitle(device: Device, activeVersion?: string | null, activeSha256?: string | null) {
  if (!activeVersion) return undefined;
  const active = activeSha256 ? `${activeVersion} | ${activeSha256.slice(0, 8)}` : activeVersion;
  const current = device.agent_sha256
    ? `${device.agent_version ?? "unknown"} | ${device.agent_sha256.slice(0, 8)}`
    : (device.agent_version ?? "unknown");
  return `Installed: ${current} | Active: ${active}`;
}

// Windows rows resolve against the Windows package. Non-Windows rows resolve
// against their own platform: architecture-specific agent builds (Linux) via
// active_agent_versions keyed "<platform>:<uname -m>" (the arch->package
// mapping lives only in version_service.py), connectors (MikroTik) via
// active_connector_versions.
export function resolveActiveVersion(device: Device, sources: AgentVersionSources) {
  const platform = devicePlatform(device);
  if (platform === "windows") return sources.activePackageVersion;
  const architecture = (device.architecture || "").trim().toLowerCase();
  if (architecture) {
    const byArchitecture = sources.activeAgentVersions?.[`${platform}:${architecture}`];
    if (byArchitecture) return byArchitecture;
  }
  return sources.activeConnectorVersions?.[platform] ?? null;
}

/**
 * The agent version state of this device against the latest build for its
 * own platform. Windows keeps the two-state version + SHA check; a platform
 * with no known latest version is "unknown", never outdated.
 */
export function agentVersionView(
  device: Device,
  sources: AgentVersionSources,
): { status: VersionStatus; title?: string } {
  if (devicePlatform(device) === "windows") {
    return {
      status: isAgentOutdated(device, sources.activePackageVersion, sources.activePackageSha256)
        ? "outdated"
        : "current",
      title: windowsAgentVersionTitle(device, sources.activePackageVersion, sources.activePackageSha256),
    };
  }
  const active = resolveActiveVersion(device, sources);
  return { status: compareVersions(device.agent_version, active), title: active ? `Latest: ${active}` : undefined };
}

// ─── Device type, health, last seen ──────────────────────────────────────────

// The six standard groups (GroupPicker); naming one after the device's type
// says the same thing twice.
const STANDARD_GROUPS = new Set(["servers", "client pc", "network", "storage", "hypervisors", "other"]);

/** The device's group for a one-line summary: left out when it is a standard group. */
export function headerGroup(device: Device): string | null {
  const group = device.resolved_group || device.group_name || null;
  return group && STANDARD_GROUPS.has(group.trim().toLowerCase()) ? null : group;
}

export function deviceTypeLabel(device: Device): string {
  const cat = device.resolved_device_category;
  if (cat === "servers" || device.device_type === "server") return TERMS.server;
  if (cat === "clientpc" || device.device_type === "client") return TERMS.clientPc;
  if (cat === "network") return "Network device";
  if (cat === "storage") return "Storage";
  if (cat === "hypervisors") return "Hypervisor";
  return "Unclassified";
}

export type HealthTone = "good" | "warning" | "critical" | "none";

/** Coloured by the server's health_state; the score itself is only the text. */
export function healthTone(health?: DeviceHealthSummary): HealthTone {
  if (!health || health.health_score == null) return "none";
  if (health.health_state === "critical") return "critical";
  if (health.health_state === "warning") return "warning";
  return "good";
}

export const HEALTH_TONE_COLOR: Record<HealthTone, string> = {
  good: TONE.online,
  warning: TONE.warning,
  critical: TONE.critical,
  none: TONE.neutral,
};

export function lastSeenView(lastSeen?: string | null): { text: string; tone: string } {
  if (!lastSeen) return { text: "Never", tone: TONE.neutral };
  const diffMs = Date.now() - parseUTC(lastSeen).getTime();
  const mins = diffMs / 60_000;
  const hours = diffMs / 3_600_000;
  const days = diffMs / 86_400_000;
  if (mins < 5) return { text: "Just now", tone: TONE.online };
  if (hours < 1) return { text: `${Math.floor(mins)}m ago`, tone: TONE.online };
  if (hours < 24) return { text: `${Math.floor(hours)}h ago`, tone: "var(--th-text-secondary)" };
  if (days < 7) return { text: `${Math.floor(days)}d ago`, tone: TONE.stale };
  return { text: `${Math.floor(days)}d ago`, tone: TONE.critical };
}

// ─── Remote Support ──────────────────────────────────────────────────────────

/** Remote Support is installed but not running; null when there is nothing to flag. */
export function remoteSupportIssue(device: Device): BadgeView | null {
  const rs = remoteSupportStatus(device);
  // Only a service that is reported down is worth a row badge; an unknown
  // state is the normal case for devices that do not report it.
  if (["Running", "Not installed", "Unknown"].includes(rs.label)) return null;
  return {
    // A row tag, so the label stays short; the service's own state is in the tooltip.
    label: rs.label === "Stopped" ? "Remote off" : "Remote issue",
    tone: rs.tone,
    title: `${TERMS.remoteSupport}: ${rs.label}`,
  };
}

/** Likely cause of a device being offline or stale, inferred client-side. */
export function offlineReasonBadge(device: Device, clientSummary?: ClientOfflineSummary): BadgeView | null {
  const freshness = device.freshness_state ?? device.status;
  if (freshness === "online") return null;
  if (!device.last_seen) return null;

  const rs = remoteSupportStatus(device);
  const rsInstall = (device.rustdesk_install_status ?? "").toLowerCase();
  if (rs.label === "Stopped" && !["not_installed", "unknown", ""].includes(rsInstall)) {
    return { label: `${TERMS.remoteSupport} stopped`, tone: rs.tone };
  }

  if (device.client_id) {
    const t = parseUTC(device.last_seen).getTime();
    const nearbyPeers =
      clientSummary?.inactiveLastSeen.filter((lastSeen) => lastSeen !== t && Math.abs(lastSeen - t) < 10 * 60 * 1000)
        .length ?? 0;
    if (nearbyPeers >= 2)
      return {
        label: "Site?",
        tone: TONE.critical,
        title: "Other devices at this client went offline at the same time",
      };
  }

  if (freshness === "offline" && device.client_id && (clientSummary?.offlineCount ?? 0) <= 1) {
    return { label: "Power?", tone: TONE.offline, title: "The only offline device at this client" };
  }

  if (device.public_ip || device.local_ip) return { label: "Network", tone: TONE.info };

  if (freshness === "stale") return { label: "Stale", tone: TONE.stale };

  return null;
}

// ─── Patch, maintenance, lifecycle ───────────────────────────────────────────

export function patchBadge(patch?: PatchStatus): BadgeView | null {
  const state = patch?.patch_state ?? "unknown";
  if (state === "up_to_date") return { label: "Patched", tone: TONE.neutral };
  if (state === "reboot_required")
    return { label: "Reboot", tone: TONE.critical, title: "Reboot required to finish updates" };
  if (state === "updates_available") {
    const count = patch?.pending_updates ?? 0;
    return {
      label: count > 0 ? `${count} ${count === 1 ? "update" : "updates"}` : "Updates",
      tone: TONE.warning,
      title: "Updates available",
    };
  }
  return null;
}

export function maintenanceBadge(device: Device): BadgeView | null {
  if (!device.is_in_maintenance) return null;
  const title = device.maintenance_ends_at
    ? `In maintenance until ${formatDateTime(device.maintenance_ends_at)}`
    : device.maintenance_note
      ? `In maintenance: ${device.maintenance_note}`
      : "In maintenance";
  return { label: "Maintenance", tone: TONE.maintenance, title };
}

export function duplicateBadge(device: Device): BadgeView | null {
  if (!device.duplicate_candidate) return null;
  const scoreLabel = device.duplicate_score != null ? ` ${Math.round(device.duplicate_score * 100)}%` : "";
  return {
    label: "Duplicate",
    tone: TONE.warning,
    title: device.duplicate_of_device_id
      ? `Possible duplicate of device #${device.duplicate_of_device_id} (similarity${scoreLabel})`
      : "Possible duplicate detected",
  };
}

function isSuggestedArchive(device: Device) {
  if (device.is_archived || device.freshness_state !== "offline" || !device.last_seen) return false;
  return (Date.now() - parseUTC(device.last_seen).getTime()) / 86_400_000 > 30;
}

export function lifecycleBadges(device: Device): BadgeView[] {
  const badges: BadgeView[] = [];
  if (device.is_archived) {
    badges.push({
      label: "Archived",
      tone: TONE.neutral,
      title: device.archived_at ? `Archived ${formatDateTime(device.archived_at)}` : "Archived device",
    });
    if (device.freshness_state !== "offline") {
      badges.push({
        label: "Checked in",
        tone: TONE.warning,
        title: "This archived device is still sending heartbeats",
      });
    }
  }
  if (isSuggestedArchive(device)) {
    badges.push({ label: "Archive suggested", tone: TONE.stale, title: "Offline for more than 30 days" });
  }
  return badges;
}

// Console sign-in is the norm, so only a Remote Desktop session gets a tag.
export function userSourceBadge(device: Device): BadgeView | null {
  if (device.user_source !== "rdp_session") return null;
  const state =
    device.user_session_state && device.user_session_state !== "unknown"
      ? ` · ${humanize(device.user_session_state)}`
      : "";
  return { label: "RDP", tone: "var(--th-status-agent)", title: `Signed in over Remote Desktop${state}` };
}

// ─── Queued / running action ─────────────────────────────────────────────────

export function ActionIndicator({ entry }: { entry: ActiveActionEntry }) {
  const title = `${humanize(entry.action_type)}: ${humanize(entry.status).toLowerCase()}`;
  if (entry.status === "running") {
    return (
      <span title={title} className="inline-flex flex-none">
        <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: TONE.info }} aria-label={title} />
      </span>
    );
  }
  if (["queued", "sent", "acknowledged"].includes(entry.status)) {
    return (
      <span
        className="h-1.5 w-1.5 flex-none rounded-full"
        style={{ background: TONE.warning }}
        title={title}
        aria-label={title}
      />
    );
  }
  return null;
}
