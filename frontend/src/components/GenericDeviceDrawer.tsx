import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";

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
import ResourceBar from "./ResourceBar";

const DeviceTerminal = lazy(() => import("./DeviceTerminal"));

// Registry-driven Device Drawer for devices that report capabilities (Linux and
// every future platform). It renders ENTIRELY from GET /devices/{id}/drawer
// (Platform + Capability + Action + Connect registries) — no per-platform code.
// Windows devices (no reported capabilities) never reach here; the render site
// selects the classic DeviceDrawer for them, so Windows stays byte-identical.
// Overview reuses the SAME building blocks as the classic Drawer (ResourceBar,
// assignDeviceClient/Group, the same telemetry hook) for enterprise parity.
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
        {/* Header */}
        <div className="flex flex-none items-start justify-between px-5 pb-3 pt-4" style={{ borderBottom: "1px solid var(--th-border-drawer-section)" }}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 flex-none rounded-full ${isOnline ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" : "bg-slate-600"}`} />
              <h2 className="truncate text-sm font-bold" style={{ color: "var(--th-text-primary)" }}>{device.display_name || device.hostname}</h2>
              <span className="rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ borderColor: "var(--th-border-card)", color: "var(--th-text-secondary)" }}>{meta?.platform ?? device.platform}</span>
            </div>
            <p className="mt-0.5 truncate text-xs" style={{ color: "var(--th-text-muted)" }}>{device.hostname}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="ml-2 rounded p-1 hover:bg-white/10"><X className="h-4 w-4" style={{ color: "var(--th-text-secondary)" }} /></button>
        </div>

        {/* Tab bar */}
        <div className="flex flex-none gap-1 overflow-x-auto px-3 py-2" style={{ borderBottom: "1px solid var(--th-border-drawer-section)" }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${tab === t.id ? "bg-techi-orange/15 text-techi-orange" : "hover:bg-white/5"}`}
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
                  healthScore={healthScore}
                  healthState={healthState}
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

function Row({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-3 py-0.5 text-[11px]">
      <span className="font-semibold" style={{ color: "var(--th-text-muted)" }}>{label}</span>
      <span className="max-w-[60%] truncate text-right font-medium" style={{ color: "var(--th-text-primary)" }}>{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border px-3 py-2" style={{ borderColor: "var(--th-border-card)", background: "var(--th-bg-drawer-section)" }}>
      <p className="mb-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>{title}</p>
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
    <span className="inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold" style={{ borderColor: "var(--th-border-card)", color: "var(--th-text-secondary)" }}>
      {label}
    </span>
  );
}

// Enterprise operational overview — identity (incl. Device ID, same style as
// the classic Windows Drawer), freshness/health, addresses, resource
// utilization (reusing ResourceBar — current usage only, no monitoring
// graphs), and Client/Group assignment (reusing the exact assignDeviceClient/
// assignDeviceGroup flow every other platform uses). Deeper detail either has
// its own capability tab or belongs to Connect (Winbox/WebFig/SSH).
function Overview({
  device, meta, healthScore, healthState, snapshot, clients, groups, canOperate, onDeviceUpdated,
}: {
  device: Device; meta: DrawerMeta; healthScore: number | null; healthState: string;
  snapshot: { cpu_percent: number | null; ram_percent: number | null; disk_percent: number | null } | null;
  clients: Client[]; groups: DeviceGroup[]; canOperate: boolean;
  onDeviceUpdated?: (device: Device) => void;
}) {
  const board = captionValue(device.os_caption, "Board");
  const availableGroups = groups.filter((g) => g.client_id === device.client_id);

  return (
    <div className="space-y-3">
      <div className="rounded-md border px-3 py-2" style={{ borderColor: "var(--th-border-card)", background: "var(--th-bg-drawer-section)" }}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>Connect</span>
          <ConnectMenu deviceId={device.id} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Section title="Identity">
        <Row label="Device ID" value={String(device.id)} />
        <Row label="Hostname" value={device.hostname} />
        <Row label="Platform" value={meta.platform} />
        <Row label="OS" value={device.os_name} />
        <Row label="OS version" value={device.os_version} />
        <Row label="Kernel" value={device.kernel_version} />
        <Row label="Architecture" value={device.architecture} />
        <Row label="Board" value={board} />
      </Section>
      <Section title="Status">
        <Row label="Last seen" value={device.last_seen ? timeAgo(device.last_seen) : undefined} />
        <Row label="Health" value={healthScore != null ? `${healthScore} (${healthState})` : undefined} />
        <Row label="Local IP" value={device.local_ip} />
        <Row label="Public IP" value={device.public_ip} />
        <Row label="Connector" value={device.agent_version ?? undefined} />
      </Section>
      <Section title="Resources">
        <div className="space-y-2 py-1">
          <ResourceBar label="CPU" percent={snapshot?.cpu_percent ?? null} />
          <ResourceBar label="Memory" percent={snapshot?.ram_percent ?? null} />
          <ResourceBar label="Storage" percent={snapshot?.disk_percent ?? null} />
        </div>
      </Section>
      <Section title="Assignment">
        <Row label="Client" value={device.resolved_client_name ?? undefined} />
        <Row label="Group" value={device.resolved_group ?? undefined} />
        <div className="flex items-center justify-between gap-3 py-0.5 text-[11px]">
          <span className="font-semibold" style={{ color: "var(--th-text-muted)" }}>Source</span>
          <AssignmentSourceBadge source={device.resolved_assignment_source || device.assignment_source} />
        </div>
        {canOperate && (
          <div className="mt-2 space-y-2">
            <label className="block">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>Assign Client</span>
              <select
                value={device.client_id ?? "none"}
                onChange={async (e) => {
                  const value = e.target.value === "none" ? null : Number(e.target.value);
                  const updated = await assignDeviceClient(device.id, value);
                  onDeviceUpdated?.(updated);
                }}
                className="w-full rounded-md border px-2 py-1 text-xs font-medium outline-none"
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
                className="w-full rounded-md border px-2 py-1 text-xs font-medium outline-none disabled:opacity-50"
                style={{ background: "var(--th-bg-input, var(--th-bg-shell))", borderColor: "var(--th-border-subtle)", color: "var(--th-text-primary)" }}
              >
                <option value="none">No group</option>
                {availableGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
          </div>
        )}
      </Section>
      <Section title="Capabilities">
        <div className="flex flex-wrap gap-1">
          {meta.capabilities.map((c) => (
            <span key={c} className="rounded border px-1.5 py-0.5 text-[10px] font-medium" style={{ borderColor: "var(--th-border-card)", color: "var(--th-text-secondary)" }}>{c}</span>
          ))}
        </div>
      </Section>
      </div>
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
        <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--th-border-card)" }}>
          <table className="min-w-full text-xs">
            <thead><tr>{head.map((h) => <th key={h} className="px-3 py-1.5 text-left font-semibold" style={{ color: "var(--th-text-muted)" }}>{h}</th>)}</tr></thead>
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
    <Section title="Actions">
      {!canOperate && <p className="mb-2 text-xs" style={{ color: "var(--th-text-muted)" }}>You have read-only access.</p>}
      <div className="flex flex-wrap gap-2">
        {meta.actions.map((a) => (
          <button
            key={a.id}
            disabled={!canOperate || busy === a.id}
            onClick={() => onAction(a)}
            className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${a.confirm === "confirm" ? "border-red-400/30 text-red-300 hover:bg-red-500/10" : "hover:bg-white/5"}`}
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
          <div className="mt-2 flex justify-end"><button onClick={onAdd} disabled={!noteText.trim()} className="rounded-md border px-3 py-1.5 text-xs font-semibold disabled:opacity-50" style={{ borderColor: "var(--th-border-card)", color: "var(--th-text-secondary)" }}>Add note</button></div>
        </div>
      )}
      <div className="space-y-2">
        {notes.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>No notes yet.</p>
        ) : notes.map((n) => (
          <div key={n.id} className="rounded-lg border p-3" style={{ borderColor: "var(--th-border-card)" }}>
            <p className="text-sm" style={{ color: "var(--th-text-primary)" }}>{n.note}</p>
            <p className="mt-1 text-[11px]" style={{ color: "var(--th-text-muted)" }}>{n.created_by ?? "system"} · {timeAgo(n.created_at)}</p>
          </div>
        ))}
      </div>
    </>
  );
}
