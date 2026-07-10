import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity, Building2, Cpu, Fingerprint, HardDrive, Link2, Loader2,
  MemoryStick, Wrench, X,
} from "lucide-react";

import { Client, DeviceGroup } from "../api/clients";
import { assignDeviceClient, assignDeviceGroup, Device } from "../api/devices";
import { queueDeviceAction, ActionType } from "../api/actions";
import { DeviceInventory, getDeviceInventory } from "../api/inventory";
import { createDeviceNote, DeviceNote, getDeviceNotes } from "../api/notes";
import { DrawerAction, DrawerMeta, getDrawerMeta } from "../api/platform";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";
import { useDeviceActivity } from "../hooks/useDeviceActivity";
import { useDeviceTelemetry } from "../hooks/useDeviceTelemetry";
import { usePlatformFeatures } from "../hooks/usePlatformFeatures";
import { timeAgo } from "../utils/time";
import ActivityTimeline from "./ActivityTimeline";
import ConfirmationModal from "./ConfirmationModal";
import ConnectMenu from "./ConnectMenu";
import HealthBadge from "./HealthBadge";
import PlatformIcon from "./PlatformIcon";
import VersionBadge from "./VersionBadge";

const DeviceTerminal = lazy(() => import("./DeviceTerminal"));

// Registry-driven Device Drawer for devices that report capabilities (Linux and
// every future platform). It renders ENTIRELY from GET /devices/{id}/drawer
// (Platform + Capability + Action + Connect registries) — no per-platform code.
// Windows devices (no reported capabilities) never reach here; the render site
// selects the classic DeviceDrawer for them, so Windows stays byte-identical.
// This IS the enterprise standard drawer for Linux/MikroTik/Synology/QNAP/
// VMware/Proxmox/… — one polished layout, not a per-platform prototype.
interface Props {
  device: Device;
  isOpen: boolean;
  onClose: () => void;
  clients?: Client[];
  groups?: DeviceGroup[];
  latestEvent?: DeviceRealtimeEvent | null;
  canOperate?: boolean;
  onDeviceUpdated?: (device: Device) => void;
}

const CAP_TAB_LABELS: Record<string, string> = {
  services: "Services", processes: "Processes", packages: "Packages",
  docker: "Docker", logs: "Logs", network: "Network", storage: "Storage",
};

export default function GenericDeviceDrawer({ device, isOpen, onClose, latestEvent, clients, groups, canOperate, onDeviceUpdated }: Props) {
  const features = usePlatformFeatures();
  const [meta, setMeta] = useState<DrawerMeta | null>(null);
  const [tab, setTab] = useState<string>("overview");
  const [inventory, setInventory] = useState<DeviceInventory | null>(null);
  const [notes, setNotes] = useState<DeviceNote[]>([]);
  const [noteText, setNoteText] = useState("");
  const [confirm, setConfirm] = useState<DrawerAction | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { events, loading: tlLoading, reload: reloadTimeline } = useDeviceActivity({
    deviceId: device.id, latestEvent, enabled: isOpen && tab === "timeline",
  });
  const { snapshot, healthScore, healthState } = useDeviceTelemetry({
    deviceId: isOpen ? device.id : null, latestEvent,
  });

  useEffect(() => {
    if (!isOpen) return;
    setTab("overview");
    getDrawerMeta(device.id).then(setMeta).catch(() => setMeta(null));
    getDeviceInventory(device.id).then(setInventory).catch(() => setInventory(null));
  }, [isOpen, device.id]);

  useEffect(() => {
    if (isOpen && tab === "notes") getDeviceNotes(device.id).then(setNotes).catch(() => setNotes([]));
  }, [isOpen, tab, device.id]);

  const tabs = useMemo(() => {
    const t: Array<{ id: string; label: string }> = [{ id: "overview", label: "Overview" }];
    if (meta?.remote_support) t.push({ id: "remote_support", label: "Remote Support" });
    if (meta?.terminal && features.FEATURE_TERMINAL) t.push({ id: "terminal", label: "Terminal" });
    (meta?.capability_tabs ?? []).forEach((c) => t.push({ id: c, label: CAP_TAB_LABELS[c] ?? c }));
    if (meta?.actions?.length) t.push({ id: "management", label: "Management" });
    t.push({ id: "notes", label: "Notes" });
    t.push({ id: "timeline", label: "Timeline" });
    return t;
  }, [meta, features.FEATURE_TERMINAL]);

  const flash = (msg: string) => { setToast(msg); window.setTimeout(() => setToast(null), 2600); };

  const runAction = async (a: DrawerAction) => {
    setBusy(a.id);
    try {
      await queueDeviceAction(device.id, { action_type: a.id as ActionType });
      flash(`Queued: ${a.label}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const onAction = (a: DrawerAction) => {
    if (a.confirm === "confirm") setConfirm(a);
    else void runAction(a);
  };

  const addNote = async () => {
    const text = noteText.trim();
    if (!text) return;
    try {
      await createDeviceNote(device.id, text);
      setNoteText("");
      setNotes(await getDeviceNotes(device.id));
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to add note");
    }
  };

  const isOnline = device.status === "online";

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] transition-opacity duration-300 ${isOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-[480px] flex-col shadow-2xl transition-transform duration-300 ease-out ${isOpen ? "translate-x-0" : "translate-x-full"}`}
        style={{ borderLeft: "1px solid var(--th-border-drawer)", background: "var(--th-bg-drawer)" }}
      >
        {/* Header — device identity + health at a glance, before anything else */}
        <div className="flex flex-none items-start gap-3 px-5 pb-4 pt-4" style={{ borderBottom: "1px solid var(--th-border-drawer-section)" }}>
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg" style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}>
            <PlatformIcon platform={meta?.platform ?? device.platform} size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[15px] font-bold leading-tight" style={{ color: "var(--th-text-primary)" }}>{device.display_name || device.hostname}</h2>
              <span className="flex-none rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide" style={{ borderColor: "var(--th-border-card)", color: "var(--th-text-secondary)" }}>{meta?.platform ?? device.platform}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]" style={{ color: "var(--th-text-muted)" }}>
              <span className="flex items-center gap-1.5 font-semibold" style={{ color: isOnline ? "#34d399" : "var(--th-text-muted)" }}>
                <span className={`h-1.5 w-1.5 flex-none rounded-full ${isOnline ? "bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.6)]" : "bg-slate-600"}`} />
                {isOnline ? "Online" : "Offline"}
              </span>
              <span style={{ opacity: 0.35 }}>•</span>
              <HealthBadge state={healthState} score={healthScore} showLabel size="xs" />
              <span style={{ opacity: 0.35 }}>•</span>
              <span className="truncate font-mono">{device.hostname}</span>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="ml-1 flex-none rounded p-1 hover:bg-white/10"><X className="h-4 w-4" style={{ color: "var(--th-text-secondary)" }} /></button>
        </div>

        {/* Tab bar */}
        <div className="flex flex-none gap-1 overflow-x-auto px-3 py-2" style={{ borderBottom: "1px solid var(--th-border-drawer-section)" }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${tab === t.id ? "bg-techi-orange/15 text-techi-orange" : "hover:bg-white/5"}`}
              style={tab === t.id ? undefined : { color: "var(--th-text-secondary)" }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {!meta ? (
            <div className="flex items-center gap-2 text-sm" style={{ color: "var(--th-text-muted)" }}><Loader2 className="h-4 w-4 animate-spin" />Loading device…</div>
          ) : (
            <>
              {tab === "overview" && (
                <Overview
                  device={device}
                  meta={meta}
                  snapshot={snapshot}
                  clients={clients ?? []}
                  groups={groups ?? []}
                  canOperate={canOperate !== false}
                  onDeviceUpdated={onDeviceUpdated}
                />
              )}
              {tab === "remote_support" && (
                <div className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
                  <p className="mb-3">Connect using this platform's native methods:</p>
                  <ConnectMenu deviceId={device.id} />
                </div>
              )}
              {tab === "terminal" && (
                <Suspense fallback={<div className="flex items-center gap-2 text-sm" style={{ color: "var(--th-text-muted)" }}><Loader2 className="h-4 w-4 animate-spin" />Loading terminal…</div>}>
                  <DeviceTerminal deviceId={device.id} />
                </Suspense>
              )}
              {["services", "processes", "packages", "docker", "logs", "network", "storage"].includes(tab) && (
                <CapabilityPanel tab={tab} inventory={inventory} />
              )}
              {tab === "management" && (
                <ManagementPanel meta={meta} busy={busy} canOperate={canOperate !== false} onAction={onAction} />
              )}
              {tab === "notes" && (
                <NotesPanel notes={notes} noteText={noteText} setNoteText={setNoteText} onAdd={addNote} canOperate={canOperate !== false} />
              )}
              {tab === "timeline" && <ActivityTimeline events={events} loading={tlLoading} onReload={() => void reloadTimeline()} />}
            </>
          )}
        </div>

        {toast && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg border px-3 py-2 text-xs font-semibold shadow-lg" style={{ borderColor: "var(--th-border-card)", background: "var(--th-bg-card)", color: "var(--th-text-primary)" }}>{toast}</div>
        )}
      </div>

      {confirm && (
        <ConfirmationModal
          title={`${confirm.label}?`}
          confirmLabel={confirm.label}
          destructive
          onConfirm={() => void runAction(confirm)}
          onClose={() => setConfirm(null)}
        >
          This will {confirm.label.toLowerCase()} on {device.hostname}.
        </ConfirmationModal>
      )}
    </>
  );
}

function Row({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-[12.5px]">
      <span className="flex-none font-medium" style={{ color: "var(--th-text-muted)" }}>{label}</span>
      <span className={`max-w-[62%] truncate text-right font-semibold ${mono ? "font-mono text-[11.5px]" : ""}`} style={{ color: "var(--th-text-primary)" }}>{value}</span>
    </div>
  );
}

// Per-section accent — a quiet visual cue (icon chip only, never a filled
// background) so the 5 Overview sections read as distinct at a glance
// without turning the interface colorful. Connect uses the brand accent
// (the primary action, not a "5th color").
type Accent = "identity" | "status" | "resources" | "assignment" | "connect" | "neutral";
const ACCENTS: Record<Accent, { icon: string; bg: string; border: string }> = {
  identity:   { icon: "#60A5FA", bg: "rgba(96,165,250,0.12)",  border: "rgba(96,165,250,0.28)" },
  status:     { icon: "#34D399", bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.28)" },
  resources:  { icon: "#A78BFA", bg: "rgba(167,139,250,0.12)", border: "rgba(167,139,250,0.28)" },
  assignment: { icon: "#FB923C", bg: "rgba(251,146,60,0.12)",  border: "rgba(251,146,60,0.28)" },
  connect:    { icon: "var(--th-accent-bright)", bg: "var(--th-accent-dim-bg)", border: "var(--th-accent-border)" },
  neutral:    { icon: "var(--th-text-muted)", bg: "var(--th-bg-card)", border: "var(--th-border-card)" },
};

function SectionIcon({ icon: Icon, accent }: { icon: LucideIcon; accent: Accent }) {
  const theme = ACCENTS[accent];
  return (
    <span className="flex h-5 w-5 flex-none items-center justify-center rounded" style={{ background: theme.bg, border: `1px solid ${theme.border}` }}>
      <Icon className="h-3 w-3" style={{ color: theme.icon }} />
    </span>
  );
}

function Section({ title, icon, accent = "neutral", action, children }: {
  title: string; icon?: LucideIcon; accent?: Accent; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border px-3.5 py-3" style={{ borderColor: "var(--th-border-card)", background: "var(--th-bg-drawer-section)" }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {icon && <SectionIcon icon={icon} accent={accent} />}
          <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--th-text-secondary)" }}>{title}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// os_caption packs connector inventory as "Key=value; Key=value" (e.g. the
// MikroTik "Board=..."); Overview reads only the keys it displays.
function captionValue(caption: string | null | undefined, key: string): string | null {
  if (!caption) return null;
  const part = caption.split(";").map((p) => p.trim()).find((p) => p.toLowerCase().startsWith(`${key.toLowerCase()}=`));
  return part ? part.slice(key.length + 1).trim() : null;
}

function AssignmentSourceBadge({ source }: { source?: string | null }) {
  const normalized = (source || "unassigned").toLowerCase();
  const label =
    normalized === "manual" || normalized === "legacy_manual" ? "manual" :
    normalized === "trusted_domain" ? "domain" :
    normalized === "enrollment_token" ? "token" :
    normalized === "auto_os" || normalized === "system_auto" ? "auto" :
    "unassigned";
  return (
    <span className="inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold" style={{ borderColor: "var(--th-border-card)", color: "var(--th-text-secondary)" }}>
      {label}
    </span>
  );
}

// Richer resource meter than the shared ResourceBar (which Windows also
// uses) — icon + bold percentage + colored fill. Kept local to the Generic
// Drawer so Windows' own Overview is never touched by this polish pass.
function ResourceMeter({ icon: Icon, label, percent }: { icon: LucideIcon; label: string; percent: number | null }) {
  const has = percent != null;
  const clamped = has ? Math.min(100, Math.max(0, percent as number)) : 0;
  const fill = !has ? "var(--th-border-card)" : clamped >= 90 ? "#f87171" : clamped >= 75 ? "#fbbf24" : ACCENTS.resources.icon;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--th-text-secondary)" }}>
          <Icon className="h-3.5 w-3.5 flex-none" style={{ color: "var(--th-text-muted)" }} />
          {label}
        </span>
        <span className="text-[13px] font-bold tabular-nums" style={{ color: has ? "var(--th-text-primary)" : "var(--th-text-faint)" }}>
          {has ? `${clamped.toFixed(0)}%` : "—"}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--th-bg-card)" }}>
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${clamped}%`, background: fill }} />
      </div>
    </div>
  );
}

// Enterprise operational overview — the standard for every non-Windows
// platform drawer (Linux, MikroTik, Synology, QNAP, VMware, Proxmox, …).
// Ordered by what an operator needs to know first: is it healthy (header,
// above) → how do I reach it (Connect) → what is it (Identity/Status) →
// how loaded is it (Resources) → who owns it (Assignment). Exactly 5
// sections, nothing more — deeper detail either has its own capability tab
// or belongs to Connect (Winbox/WebFig/SSH), never a config dump here.
function Overview({
  device, meta, snapshot, clients, groups, canOperate, onDeviceUpdated,
}: {
  device: Device; meta: DrawerMeta;
  snapshot: { cpu_percent: number | null; ram_percent: number | null; disk_percent: number | null } | null;
  clients: Client[]; groups: DeviceGroup[]; canOperate: boolean;
  onDeviceUpdated?: (device: Device) => void;
}) {
  const board = captionValue(device.os_caption, "Board");
  const availableGroups = groups.filter((g) => g.client_id === device.client_id);
  const versionStatus = meta.version_status ?? (meta.reported_version ? "current" : "unknown");
  const versionTitle = meta.latest_version ? `Latest: ${meta.latest_version}` : undefined;

  return (
    <div className="space-y-2.5">
      {/* Connect — the primary entry point for managing this device */}
      <div className="rounded-lg border px-4 py-3" style={{ borderColor: "var(--th-accent-border)", background: "var(--th-accent-glow)" }}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg" style={{ background: "var(--th-accent-dim-bg)", border: "1px solid var(--th-accent-border)" }}>
              <Link2 className="h-4 w-4" style={{ color: "var(--th-accent-bright)" }} />
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-bold" style={{ color: "var(--th-text-primary)" }}>Connect</p>
              <p className="truncate text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                {meta.connect_methods.length} method{meta.connect_methods.length === 1 ? "" : "s"} available
              </p>
            </div>
          </div>
          <ConnectMenu deviceId={device.id} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <Section title="Identity" icon={Fingerprint} accent="identity">
          <Row label="Device ID" value={String(device.id)} mono />
          <Row label="Hostname" value={device.hostname} />
          <Row label="OS" value={device.os_name} />
          <Row label="OS version" value={device.os_version} />
          <Row label="Kernel" value={device.kernel_version} />
          <Row label="Architecture" value={device.architecture} />
          <Row label="Board" value={board} />
        </Section>
        <Section title="Status" icon={Activity} accent="status">
          <Row label="Last seen" value={device.last_seen ? timeAgo(device.last_seen) : undefined} />
          <Row label="Local IP" value={device.local_ip} mono />
          <Row label="Public IP" value={device.public_ip} mono />
          <Row label="Current user" value={device.current_user ?? undefined} />
          <div className="flex items-center justify-between gap-3 py-[3px] text-[12.5px]">
            <span className="font-medium" style={{ color: "var(--th-text-muted)" }}>Connector</span>
            <VersionBadge version={meta.reported_version} status={versionStatus} title={versionTitle} />
          </div>
        </Section>
      </div>

      <Section title="Resources" icon={Cpu} accent="resources">
        <div className="grid grid-cols-3 gap-4 py-1">
          <ResourceMeter icon={Cpu} label="CPU" percent={snapshot?.cpu_percent ?? null} />
          <ResourceMeter icon={MemoryStick} label="Memory" percent={snapshot?.ram_percent ?? null} />
          <ResourceMeter icon={HardDrive} label="Storage" percent={snapshot?.disk_percent ?? null} />
        </div>
      </Section>

      <Section title="Assignment" icon={Building2} accent="assignment">
        <div className="grid grid-cols-2 gap-x-3">
          <Row label="Client" value={device.resolved_client_name ?? undefined} />
          <Row label="Group" value={device.resolved_group ?? undefined} />
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-3 py-[3px] text-[12.5px]">
          <span className="font-medium" style={{ color: "var(--th-text-muted)" }}>Source</span>
          <AssignmentSourceBadge source={device.resolved_assignment_source || device.assignment_source} />
        </div>
        {canOperate && (
          <div className="mt-2.5 grid grid-cols-2 gap-2 border-t pt-2.5" style={{ borderColor: "var(--th-border-card)" }}>
            <label className="block">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>Assign Client</span>
              <select
                value={device.client_id ?? "none"}
                onChange={async (e) => {
                  const value = e.target.value === "none" ? null : Number(e.target.value);
                  const updated = await assignDeviceClient(device.id, value);
                  onDeviceUpdated?.(updated);
                }}
                className="w-full rounded-md border px-2 py-1.5 text-[12.5px] font-medium outline-none"
                style={{ background: "var(--th-bg-input, var(--th-bg-shell))", borderColor: "var(--th-border-subtle)", color: "var(--th-text-primary)" }}
              >
                <option value="none">No client</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>Assign Group</span>
              <select
                value={device.group_id ?? "none"}
                disabled={!device.client_id}
                onChange={async (e) => {
                  const value = e.target.value === "none" ? null : Number(e.target.value);
                  const updated = await assignDeviceGroup(device.id, value);
                  onDeviceUpdated?.(updated);
                }}
                className="w-full rounded-md border px-2 py-1.5 text-[12.5px] font-medium outline-none disabled:opacity-50"
                style={{ background: "var(--th-bg-input, var(--th-bg-shell))", borderColor: "var(--th-border-subtle)", color: "var(--th-text-primary)" }}
              >
                <option value="none">No group</option>
                {availableGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
          </div>
        )}
      </Section>
    </div>
  );
}

function CapabilityPanel({ tab, inventory }: { tab: string; inventory: DeviceInventory | null }) {
  if (tab === "services") {
    const rows = inventory?.services ?? [];
    return <SimpleTable title="Services" empty="No services reported." head={["Name", "Status"]} rows={rows.map((s) => [s.display_name || s.name, s.status])} />;
  }
  if (tab === "processes") {
    const rows = inventory?.processes ?? [];
    return <SimpleTable title="Processes" empty="No processes reported." head={["Name", "PID"]} rows={rows.map((p) => [p.name, String(p.pid)])} />;
  }
  if (tab === "packages") {
    const rows = inventory?.software ?? [];
    return <SimpleTable title="Packages" empty="No packages reported." head={["Name", "Version"]} rows={rows.map((s) => [s.name, s.version ?? "-"])} />;
  }
  // docker / logs / network / storage — capability reported; detailed renderer optional/future.
  return (
    <div className="rounded-lg border border-dashed p-4 text-sm" style={{ borderColor: "var(--th-border-card)", color: "var(--th-text-muted)" }}>
      This device reports the <span className="font-semibold" style={{ color: "var(--th-text-secondary)" }}>{CAP_TAB_LABELS[tab] ?? tab}</span> capability. A detailed {tab} view is an optional capability renderer (coming); the tab is registry-driven and appears automatically for any platform that reports this capability.
    </div>
  );
}

function SimpleTable({ title, head, rows, empty }: { title: string; head: string[]; rows: string[][]; empty: string }) {
  return (
    <Section title={title}>
      {rows.length === 0 ? (
        <p className="py-1 text-[12.5px]" style={{ color: "var(--th-text-muted)" }}>{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--th-border-card)" }}>
          <table className="min-w-full text-[12.5px]">
            <thead><tr>{head.map((h) => <th key={h} className="px-3 py-1.5 text-left text-[10.5px] font-bold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.slice(0, 200).map((r, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--th-border-card)" }}>{r.map((c, j) => <td key={j} className="px-3 py-1.5 font-medium" style={{ color: "var(--th-text-primary)" }}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function ManagementPanel({ meta, busy, canOperate, onAction }: { meta: DrawerMeta; busy: string | null; canOperate: boolean; onAction: (a: DrawerAction) => void }) {
  return (
    <Section title="Actions" icon={Wrench}>
      {!canOperate && <p className="mb-2 text-[12.5px]" style={{ color: "var(--th-text-muted)" }}>You have read-only access.</p>}
      <div className="flex flex-wrap gap-2">
        {meta.actions.map((a) => (
          <button
            key={a.id}
            disabled={!canOperate || busy === a.id}
            onClick={() => onAction(a)}
            className={`rounded-md border px-3 py-1.5 text-[12.5px] font-semibold transition-colors disabled:opacity-50 ${a.confirm === "confirm" ? "border-red-400/30 text-red-300 hover:bg-red-500/10" : "hover:bg-white/5"}`}
            style={a.confirm === "confirm" ? undefined : { borderColor: "var(--th-border-card)", color: "var(--th-text-secondary)" }}
          >
            {busy === a.id ? "…" : a.label}
          </button>
        ))}
      </div>
    </Section>
  );
}

function NotesPanel({ notes, noteText, setNoteText, onAdd, canOperate }: { notes: DeviceNote[]; noteText: string; setNoteText: (v: string) => void; onAdd: () => void; canOperate: boolean }) {
  return (
    <>
      {canOperate && (
        <div className="mb-4">
          <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={3} placeholder="Add a note…" className="th-input w-full rounded-lg border px-3 py-2 text-sm" />
          <div className="mt-2 flex justify-end"><button onClick={onAdd} disabled={!noteText.trim()} className="rounded-md border px-3 py-1.5 text-[12.5px] font-semibold disabled:opacity-50" style={{ borderColor: "var(--th-border-card)", color: "var(--th-text-secondary)" }}>Add note</button></div>
        </div>
      )}
      <div className="space-y-2">
        {notes.length === 0 ? (
          <p className="text-[12.5px]" style={{ color: "var(--th-text-muted)" }}>No notes yet.</p>
        ) : notes.map((n) => (
          <div key={n.id} className="rounded-lg border p-3" style={{ borderColor: "var(--th-border-card)" }}>
            <p className="text-[13px]" style={{ color: "var(--th-text-primary)" }}>{n.note}</p>
            <p className="mt-1 text-[11px]" style={{ color: "var(--th-text-muted)" }}>{n.created_by ?? "system"} · {timeAgo(n.created_at)}</p>
          </div>
        ))}
      </div>
    </>
  );
}
