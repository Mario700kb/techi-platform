import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Building2, Check, CheckSquare, ChevronDown, ChevronRight,
  Cpu, Info, RefreshCcw, Save, Shield, Square, Users, UsersRound, X,
} from "lucide-react";
import {
  TeamDetail,
  getTeam,
  updateTeam,
  updateTeamMembers,
  updateTeamClientAccess,
  updateTeamGroupAccess,
  updateTeamDeviceAccess,
  updateTeamPermissions,
} from "../api/teams";
import { getOperators, OperatorRecord } from "../api/operators";
import { getClients, getGroups, Client, DeviceGroup } from "../api/clients";
import { getDevices, Device } from "../api/devices";
import { Button } from "../components/ui";
import { useAuth } from "../auth/AuthContext";

// ── Color presets ────────────────────────────────────────────────────────── //

const COLOR_PRESETS = [
  "#f97316", "#6366f1", "#ec4899", "#10b981",
  "#3b82f6", "#8b5cf6", "#ef4444", "#14b8a6",
  "#f59e0b", "#64748b",
];

// ── Team permission definitions ──────────────────────────────────────────── //

export const TEAM_PERMISSION_DEFS: { key: string; label: string; description: string; category: string }[] = [
  { key: "view_devices",             label: "View Devices",          description: "See devices in the fleet", category: "Visibility" },
  { key: "remote_support_connect",   label: "Connect",               description: "Open remote support sessions", category: "Remote Support" },
  { key: "remote_support_manage",    label: "Manage Sessions",       description: "End or transfer remote support sessions", category: "Remote Support" },
  { key: "restart_device",           label: "Restart Device",        description: "Send device restart command", category: "Device Actions" },
  { key: "restart_agent",            label: "Restart Agent",         description: "Restart the management agent", category: "Device Actions" },
  { key: "reinstall_remote_support", label: "Reinstall Remote",      description: "Reinstall remote support software", category: "Device Actions" },
  { key: "maintenance_mode",         label: "Maintenance Mode",      description: "Put devices in maintenance mode", category: "Device Actions" },
  { key: "view_notes",               label: "View Notes",            description: "Read device notes", category: "Content" },
  { key: "edit_notes",               label: "Edit Notes",            description: "Create and edit device notes", category: "Content" },
  { key: "view_inventory",           label: "View Inventory",        description: "View software inventory", category: "Content" },
  { key: "view_patch",               label: "View Patch Status",     description: "View patch compliance data", category: "Content" },
  { key: "deployment",               label: "Deploy Packages",       description: "Deploy software packages", category: "Admin" },
  { key: "manage_clients",           label: "Manage Clients",        description: "Add, edit, remove clients", category: "Admin" },
  { key: "manage_groups",            label: "Manage Groups",         description: "Add, edit, remove device groups", category: "Admin" },
  { key: "manage_operators",         label: "Manage Operators",      description: "Create and manage operator accounts", category: "Admin" },
  { key: "audit_log",                label: "View Audit Log",        description: "Read the system audit log", category: "Admin" },
  { key: "system_settings",          label: "System Settings",       description: "Access system-level settings", category: "Admin" },
];

const PERM_CATEGORIES = ["Visibility", "Remote Support", "Device Actions", "Content", "Admin"];

// ── Role permission matrix (mirrors backend permission_service.py) ────────── //

const ROLE_PERMS: Record<string, Set<string>> = {
  owner: new Set(TEAM_PERMISSION_DEFS.map((d) => d.key)),
  admin: new Set([
    "view_devices", "remote_support_connect", "remote_support_manage",
    "restart_device", "restart_agent", "reinstall_remote_support", "maintenance_mode",
    "view_notes", "edit_notes", "view_inventory", "view_patch",
    "deployment", "manage_clients", "manage_groups", "manage_operators", "audit_log",
  ]),
  operator: new Set([
    "view_devices", "remote_support_connect", "restart_device", "restart_agent",
    "reinstall_remote_support", "maintenance_mode", "view_notes", "edit_notes",
    "view_inventory", "view_patch",
  ]),
  readonly: new Set(["view_devices", "view_notes", "view_inventory", "view_patch"]),
};

// ── Shared helpers ───────────────────────────────────────────────────────── //

const INPUT_CLS =
  "th-input w-full rounded-lg border px-3 py-2.5 text-sm font-medium outline-none focus:border-techi-orange/60";
const LABEL_CLS = "block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1";

type Tab = "overview" | "members" | "access" | "permissions";

function SaveBanner({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-300">
      <Check className="h-3.5 w-3.5 shrink-0" />
      {message}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-2.5 text-xs font-medium text-red-100">
      {message}
    </div>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {COLOR_PRESETS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className="h-7 w-7 rounded-full border-2 transition hover:scale-110"
          style={{
            background: c,
            borderColor: value === c ? "white" : "transparent",
            boxShadow: value === c ? `0 0 0 1px ${c}` : undefined,
          }}
          title={c}
        />
      ))}
    </div>
  );
}

// ── Dashboard summary ────────────────────────────────────────────────────── //

function DashboardSummary({
  team,
  memberCount,
  effectiveDeviceCount,
}: {
  team: TeamDetail;
  memberCount: number;
  effectiveDeviceCount: number;
}) {
  const statBoxCls =
    "flex flex-col gap-1 rounded-lg border border-white/[0.07] bg-white/[0.03] px-4 py-3";

  const permLabels = TEAM_PERMISSION_DEFS.filter((d) => team.permissions.includes(d.key)).map((d) => d.label);

  return (
    <div className="space-y-4">
      {/* Stat grid — 2 columns on mobile, 5 on sm+ */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className={statBoxCls}>
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Members</span>
          <span className="text-2xl font-bold text-white">{memberCount}</span>
        </div>
        <div className={statBoxCls}>
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Clients</span>
          <span className="text-2xl font-bold text-white">{team.client_ids.length}</span>
        </div>
        <div className={statBoxCls}>
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Groups</span>
          <span className="text-2xl font-bold text-white">{team.group_ids.length}</span>
        </div>
        <div className={statBoxCls}>
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Explicit Devices</span>
          <span className="text-2xl font-bold text-white">{team.device_ids.length}</span>
          <span className="text-[10px] text-slate-600">direct only</span>
        </div>
        <div className={`${statBoxCls} border-techi-orange/15 bg-techi-orange/[0.04]`}>
          <span className="text-[10px] font-bold uppercase tracking-wide text-orange-400/70">Effective Devices</span>
          <span className="text-2xl font-bold text-orange-200">{effectiveDeviceCount}</span>
          <span className="text-[10px] text-slate-600">via clients + groups</span>
        </div>
      </div>

      {/* Assigned permissions summary */}
      <div className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-4 py-3">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">
          Permissions Assigned ({permLabels.length})
        </p>
        {permLabels.length === 0 ? (
          <p className="text-sm text-slate-500">No permissions set — operators use role defaults.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {permLabels.map((label) => (
              <span
                key={label}
                className="rounded-full border border-techi-orange/20 bg-techi-orange/10 px-2.5 py-0.5 text-[11px] font-semibold text-orange-200"
              >
                {label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Overview tab ─────────────────────────────────────────────────────────── //

function OverviewTab({
  team,
  canManage,
  onSaved,
}: {
  team: TeamDetail;
  canManage: boolean;
  onSaved: (updated: TeamDetail) => void;
}) {
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  const [color, setColor] = useState(team.color ?? "#f97316");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) { setError("Team name is required"); return; }
    try {
      setLoading(true); setError(null); setSaved(false);
      const updated = await updateTeam(team.id, { name: name.trim(), description: description.trim() || null, color });
      onSaved(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 max-w-lg">
      {error && <ErrorBanner message={error} />}
      {saved && <SaveBanner message="Team details saved." />}
      <div>
        <label className={LABEL_CLS}>Team name *</label>
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} className={INPUT_CLS} />
      </div>
      <div>
        <label className={LABEL_CLS}>Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canManage} rows={3} className={`${INPUT_CLS} resize-none`} />
      </div>
      <div>
        <label className={LABEL_CLS}>Color</label>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      {canManage && (
        <div className="pt-2">
          <Button onClick={() => void handleSave()} disabled={loading}>
            <Save className="h-3.5 w-3.5" />
            {loading ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Members tab ──────────────────────────────────────────────────────────── //

function MembersTab({
  team,
  operators,
  canManage,
  onSaved,
}: {
  team: TeamDetail;
  operators: OperatorRecord[];
  canManage: boolean;
  onSaved: (ids: number[]) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set(team.operator_ids));
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const filtered = operators.filter(
    (op) =>
      search === "" ||
      (op.display_name ?? op.username).toLowerCase().includes(search.toLowerCase()) ||
      op.email.toLowerCase().includes(search.toLowerCase())
  );

  const allSelected = filtered.length > 0 && filtered.every((op) => selected.has(op.id));

  const toggle = (id: number) =>
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const toggleAll = () => {
    const ids = filtered.map((op) => op.id);
    setSelected((prev) => {
      const n = new Set(prev);
      if (allSelected) { ids.forEach((id) => n.delete(id)); } else { ids.forEach((id) => n.add(id)); }
      return n;
    });
  };

  const handleSave = async () => {
    try {
      setLoading(true); setError(null); setSaved(false);
      await updateTeamMembers(team.id, Array.from(selected));
      onSaved(Array.from(selected));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save members");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} />}
      {saved && <SaveBanner message={`${selected.size} member${selected.size !== 1 ? "s" : ""} saved.`} />}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-400">Select which operators belong to this team.</p>
        {canManage && (
          <button type="button" onClick={toggleAll} className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-slate-400 transition hover:bg-white/[0.06] hover:text-white">
            {allSelected ? <><CheckSquare className="h-3.5 w-3.5" /> Deselect all</> : <><Square className="h-3.5 w-3.5" /> Select all</>}
          </button>
        )}
      </div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search operators…" className="th-input w-full rounded-lg border py-2 px-3 text-sm outline-none focus:border-techi-orange/60" />
      <div className="premium-card-soft overflow-hidden rounded-lg">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-slate-500">No operators found.</p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {filtered.map((op) => (
              <li key={op.id}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-3 transition hover:bg-white/[0.03]">
                  <input type="checkbox" checked={selected.has(op.id)} onChange={() => toggle(op.id)} disabled={!canManage} className="h-4 w-4 rounded border-white/15 accent-orange-500" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white truncate">{op.display_name ?? op.username}</p>
                    <p className="text-[11px] text-slate-500">{op.email}</p>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${op.role === "owner" ? "border-orange-300/25 bg-techi-orange/15 text-orange-200" : op.role === "admin" ? "border-red-300/25 bg-red-500/10 text-red-200" : "border-white/[0.10] bg-white/[0.05] text-slate-400"}`}>
                    {op.role}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      {canManage && (
        <Button onClick={() => void handleSave()} disabled={loading}>
          <Save className="h-3.5 w-3.5" />
          {loading ? "Saving…" : `Save Members (${selected.size})`}
        </Button>
      )}
    </div>
  );
}

// ── Device Access tab — 3-level hierarchy ────────────────────────────────── //

type CheckState = "checked" | "indeterminate" | "unchecked" | "inherited";

function TreeCheckbox({
  state,
  onChange,
  disabled,
  size = "md",
  inheritedFrom,
}: {
  state: CheckState;
  onChange?: () => void;
  disabled?: boolean;
  size?: "md" | "sm";
  inheritedFrom?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = state === "indeterminate";
    }
  }, [state]);

  if (state === "inherited") {
    return (
      <span
        className={`flex shrink-0 items-center justify-center ${size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"}`}
        title={inheritedFrom ?? "Access inherited from parent"}
      >
        <span className="h-2 w-2 rounded-sm bg-orange-400/50" />
      </span>
    );
  }

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === "checked"}
      onChange={onChange ?? (() => {})}
      disabled={disabled}
      className={`shrink-0 rounded border-white/15 accent-orange-500 ${size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"}`}
    />
  );
}

function DeviceStatusDot({ device }: { device: Device }) {
  const state = device.freshness_state ?? (device.status === "online" ? "online" : "offline");
  const cls =
    state === "online"  ? "bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.5)]"
    : state === "stale" ? "bg-amber-400"
    : "bg-slate-600";
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${cls}`}
      title={state}
    />
  );
}

function AccessTab({
  team,
  clients,
  groups,
  devices,
  canManage,
  onSaved,
}: {
  team: TeamDetail;
  clients: Client[];
  groups: DeviceGroup[];
  devices: Device[];
  canManage: boolean;
  onSaved: (clientIds: number[], groupIds: number[], deviceIds: number[]) => void;
}) {
  const [selClients, setSelClients] = useState<Set<number>>(new Set(team.client_ids));
  const [selGroups, setSelGroups]   = useState<Set<number>>(new Set(team.group_ids));
  const [selDevices, setSelDevices] = useState<Set<number>>(new Set(team.device_ids));
  const [exClients, setExClients]   = useState<Set<number>>(new Set());
  const [exGroups, setExGroups]     = useState<Set<number>>(new Set());
  const [search, setSearch]         = useState("");
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [saved, setSaved]           = useState(false);

  // Selecting a client auto-expands it; deselecting doesn't collapse
  const toggleC = (id: number) =>
    setSelClients((p) => {
      const n = new Set(p);
      if (n.has(id)) { n.delete(id); }
      else { n.add(id); setExClients((ex) => { const e = new Set(ex); e.add(id); return e; }); }
      return n;
    });

  // Selecting a group auto-expands it
  const toggleG = (id: number) =>
    setSelGroups((p) => {
      const n = new Set(p);
      if (n.has(id)) { n.delete(id); }
      else { n.add(id); setExGroups((ex) => { const e = new Set(ex); e.add(id); return e; }); }
      return n;
    });

  const toggleD = (id: number) =>
    setSelDevices((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleExC = (id: number) =>
    setExClients((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleExG = (id: number) =>
    setExGroups((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const expandAll = () => {
    setExClients(new Set(clients.map((c) => c.id)));
    setExGroups(new Set(groups.map((g) => g.id)));
  };
  const collapseAll = () => { setExClients(new Set()); setExGroups(new Set()); };

  const filteredClients = clients.filter(
    (c) => search === "" || c.name.toLowerCase().includes(search.toLowerCase())
  );

  const groupsFor = (clientId: number) =>
    groups.filter(
      (g) => g.client_id === clientId && (search === "" || g.name.toLowerCase().includes(search.toLowerCase()))
    );

  const devicesFor = (groupId: number) =>
    devices.filter(
      (d) => d.group_id === groupId && (search === "" || (d.hostname ?? "").toLowerCase().includes(search.toLowerCase()))
    );

  const ungroupedDevicesFor = (clientId: number) =>
    devices.filter(
      (d) => d.client_id === clientId && d.group_id == null &&
        (search === "" || (d.hostname ?? "").toLowerCase().includes(search.toLowerCase()))
    );

  // Count total devices that belong to a client (across all its groups + ungrouped)
  const clientDeviceCount = (clientId: number) =>
    devices.filter((d) => d.client_id === clientId).length;

  // ── Computed check states ──────────────────────────────────────────────── //

  const clientCheckState = (clientId: number): CheckState => {
    if (selClients.has(clientId)) return "checked";
    const clientGroups = groups.filter((g) => g.client_id === clientId);
    const anyDescendantSelected =
      clientGroups.some((g) => selGroups.has(g.id)) ||
      devices.some((d) => d.client_id === clientId && selDevices.has(d.id));
    return anyDescendantSelected ? "indeterminate" : "unchecked";
  };

  const groupCheckState = (group: DeviceGroup): CheckState => {
    if (selClients.has(group.client_id ?? -1)) return "inherited";
    if (selGroups.has(group.id)) return "checked";
    const anyDeviceSelected = devices.some(
      (d) => d.group_id === group.id && selDevices.has(d.id)
    );
    return anyDeviceSelected ? "indeterminate" : "unchecked";
  };

  const deviceCheckState = (device: Device): CheckState => {
    if (selClients.has(device.client_id ?? -1)) return "inherited";
    if (device.group_id != null && selGroups.has(device.group_id)) return "inherited";
    return selDevices.has(device.id) ? "checked" : "unchecked";
  };

  // ── Save ──────────────────────────────────────────────────────────────── //

  const handleSave = async () => {
    try {
      setLoading(true); setError(null); setSaved(false);
      await updateTeamClientAccess(team.id, Array.from(selClients));
      await updateTeamGroupAccess(team.id, Array.from(selGroups));
      await updateTeamDeviceAccess(team.id, Array.from(selDevices));
      onSaved(Array.from(selClients), Array.from(selGroups), Array.from(selDevices));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save access");
    } finally {
      setLoading(false);
    }
  };

  const selectedTotal = selClients.size + selGroups.size + selDevices.size;

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} />}
      {saved && <SaveBanner message="Device access saved." />}

      <div className="rounded-lg border border-blue-400/10 bg-blue-500/[0.05] px-4 py-3 text-xs leading-5 text-slate-400">
        <span className="font-semibold text-slate-300">Three levels of access:</span>{" "}
        <span className="font-semibold text-white">Client</span> grants all devices for that client.{" "}
        <span className="font-semibold text-white">Group</span> grants all devices in that group.{" "}
        <span className="font-semibold text-white">Device</span> grants specific individual devices.{" "}
        Access is the union of all selections.{" "}
        <span className="font-semibold text-orange-200/80">
          <span className="inline-block h-2 w-2 rounded-sm bg-orange-400/50 align-middle" />{" "}
          Orange squares indicate inherited access.
        </span>
      </div>

      {/* Selection summary */}
      <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
        {selClients.size > 0 && (
          <span className="rounded-full border border-white/[0.10] bg-white/[0.05] px-2.5 py-1 text-slate-300">
            <Building2 className="mr-1 inline h-3 w-3" />{selClients.size} client{selClients.size !== 1 ? "s" : ""}
          </span>
        )}
        {selGroups.size > 0 && (
          <span className="rounded-full border border-white/[0.10] bg-white/[0.05] px-2.5 py-1 text-slate-300">
            <Users className="mr-1 inline h-3 w-3" />{selGroups.size} group{selGroups.size !== 1 ? "s" : ""}
          </span>
        )}
        {selDevices.size > 0 && (
          <span className="rounded-full border border-white/[0.10] bg-white/[0.05] px-2.5 py-1 text-slate-300">
            <Cpu className="mr-1 inline h-3 w-3" />{selDevices.size} device{selDevices.size !== 1 ? "s" : ""}
          </span>
        )}
        {selectedTotal === 0 && (
          <span className="text-slate-600">No access assigned yet.</span>
        )}
      </div>

      {/* Search + Expand controls */}
      <div className="flex items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients, groups, or devices…"
          className="th-input flex-1 rounded-lg border py-2 px-3 text-sm outline-none focus:border-techi-orange/60"
        />
        <button
          type="button"
          onClick={expandAll}
          className="shrink-0 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 text-[11px] font-semibold text-slate-400 transition hover:border-white/15 hover:text-slate-200"
          title="Expand all"
        >
          Expand All
        </button>
        <button
          type="button"
          onClick={collapseAll}
          className="shrink-0 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 text-[11px] font-semibold text-slate-400 transition hover:border-white/15 hover:text-slate-200"
          title="Collapse all"
        >
          Collapse
        </button>
      </div>

      {/* Tree */}
      <div className="premium-card-soft overflow-hidden rounded-lg">
        {filteredClients.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">No clients found.</p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {filteredClients.map((client) => {
              const clientGroups = groupsFor(client.id);
              const isExC = exClients.has(client.id);
              const cState = clientCheckState(client.id);
              const devCount = clientDeviceCount(client.id);

              return (
                <li key={client.id}>
                  {/* Client row — click anywhere to expand/collapse */}
                  <div
                    className="flex cursor-pointer items-center gap-3 px-4 py-3 transition hover:bg-white/[0.03]"
                    onClick={() => toggleExC(client.id)}
                  >
                    <span onClick={(e) => e.stopPropagation()}>
                      <TreeCheckbox
                        state={cState}
                        onChange={() => canManage && toggleC(client.id)}
                        disabled={!canManage}
                      />
                    </span>
                    <Building2 className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    <div className="flex min-w-0 flex-1 items-baseline gap-2">
                      <p className={`text-sm font-semibold ${cState === "checked" ? "text-white" : "text-slate-200"}`}>
                        {client.name}
                      </p>
                      {devCount > 0 && (
                        <span className="shrink-0 text-[10px] text-slate-600">
                          {devCount} device{devCount !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    {clientGroups.length > 0 && (
                      isExC
                        ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                        : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    )}
                  </div>

                  {/* Groups under client */}
                  {isExC && clientGroups.length > 0 && (
                    <ul className="border-t border-white/[0.04] bg-white/[0.015]">
                      {clientGroups.map((group) => {
                        const groupDevices = devicesFor(group.id);
                        const isExG = exGroups.has(group.id);
                        const gState = groupCheckState(group);
                        const inherited = gState === "inherited";

                        return (
                          <li key={group.id}>
                            {/* Group row — click anywhere to expand/collapse */}
                            <div
                              className={`flex cursor-pointer items-center gap-3 py-2.5 pl-9 pr-4 transition hover:bg-white/[0.02] ${inherited ? "opacity-60" : ""}`}
                              onClick={() => groupDevices.length > 0 && toggleExG(group.id)}
                            >
                              <span onClick={(e) => e.stopPropagation()}>
                                <TreeCheckbox
                                  state={gState}
                                  onChange={() => canManage && !inherited && toggleG(group.id)}
                                  disabled={!canManage || inherited}
                                  size="sm"
                                  inheritedFrom="Inherited from client access"
                                />
                              </span>
                              <Users className="h-3 w-3 shrink-0 text-slate-600" />
                              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                                <span className={`text-[13px] ${inherited ? "text-orange-200/70" : "text-slate-300"}`}>
                                  {group.name}
                                </span>
                                <span className="shrink-0 text-[10px] text-slate-600">
                                  ({groupDevices.length})
                                </span>
                              </div>
                              {groupDevices.length > 0 && (
                                isExG
                                  ? <ChevronDown className="h-3 w-3 shrink-0 text-slate-600" />
                                  : <ChevronRight className="h-3 w-3 shrink-0 text-slate-600" />
                              )}
                            </div>

                            {/* Devices under group */}
                            {isExG && groupDevices.length > 0 && (
                              <ul className="border-t border-white/[0.03] bg-white/[0.01]">
                                {groupDevices.map((device) => {
                                  const dState = deviceCheckState(device);
                                  const dInherited = dState === "inherited";
                                  return (
                                    <li key={device.id}>
                                      <div
                                        className={`flex items-center gap-3 py-2 pl-14 pr-4 transition ${!dInherited && canManage ? "cursor-pointer hover:bg-white/[0.02]" : ""} ${dInherited ? "opacity-55" : ""}`}
                                        onClick={() => !dInherited && canManage && toggleD(device.id)}
                                      >
                                        <span onClick={(e) => e.stopPropagation()}>
                                          <TreeCheckbox
                                            state={dState}
                                            onChange={() => !dInherited && canManage && toggleD(device.id)}
                                            disabled={!canManage || dInherited}
                                            size="sm"
                                            inheritedFrom={
                                              selClients.has(device.client_id ?? -1)
                                                ? "Inherited from client access"
                                                : "Inherited from group access"
                                            }
                                          />
                                        </span>
                                        <DeviceStatusDot device={device} />
                                        <span className={`flex-1 font-mono text-[12px] ${dInherited ? "text-orange-200/60" : "text-slate-400"}`}>
                                          {device.hostname ?? device.rustdesk_id ?? `Device #${device.id}`}
                                        </span>
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </li>
                        );
                      })}

                      {/* Ungrouped devices under this client */}
                      {(() => {
                        const ung = ungroupedDevicesFor(client.id);
                        if (ung.length === 0) return null;
                        const clientInherited = selClients.has(client.id);
                        return (
                          <li>
                            <div className="flex items-center gap-3 py-2.5 pl-9 pr-4">
                              <span className="h-3.5 w-3.5 shrink-0" />
                              <span className="h-3 w-3 shrink-0 text-slate-700">·</span>
                              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                                <span className="text-[12px] italic text-slate-600">(Ungrouped)</span>
                                <span className="text-[10px] text-slate-700">{ung.length}</span>
                              </div>
                            </div>
                            <ul className="border-t border-white/[0.03] bg-white/[0.01]">
                              {ung.map((device) => {
                                const dState = clientInherited ? "inherited" : (selDevices.has(device.id) ? "checked" : "unchecked");
                                const dInherited = dState === "inherited";
                                return (
                                  <li key={device.id}>
                                    <div
                                      className={`flex items-center gap-3 py-2 pl-14 pr-4 transition ${!dInherited && canManage ? "cursor-pointer hover:bg-white/[0.02]" : ""} ${dInherited ? "opacity-55" : ""}`}
                                      onClick={() => !dInherited && canManage && toggleD(device.id)}
                                    >
                                      <span onClick={(e) => e.stopPropagation()}>
                                        <TreeCheckbox
                                          state={dState}
                                          onChange={() => !dInherited && canManage && toggleD(device.id)}
                                          disabled={!canManage || dInherited}
                                          size="sm"
                                        />
                                      </span>
                                      <DeviceStatusDot device={device} />
                                      <span className={`flex-1 font-mono text-[12px] ${dInherited ? "text-orange-200/60" : "text-slate-400"}`}>
                                        {device.hostname ?? device.rustdesk_id ?? `Device #${device.id}`}
                                      </span>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          </li>
                        );
                      })()}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {canManage && (
        <Button onClick={() => void handleSave()} disabled={loading}>
          <Save className="h-3.5 w-3.5" />
          {loading ? "Saving…" : "Save Access"}
        </Button>
      )}
    </div>
  );
}

// ── Permission templates & dependency helpers ────────────────────────────── //

const PERM_TEMPLATES: { name: string; perms: string[] }[] = [
  { name: "Read Only",           perms: ["view_devices", "view_notes", "view_inventory", "view_patch"] },
  { name: "Helpdesk L1",         perms: ["view_devices", "remote_support_connect", "view_notes", "view_inventory"] },
  { name: "Helpdesk L2",         perms: ["view_devices", "remote_support_connect", "restart_device", "restart_agent", "reinstall_remote_support", "view_notes", "edit_notes", "view_inventory", "view_patch"] },
  { name: "Server Admin",        perms: ["view_devices", "remote_support_connect", "remote_support_manage", "restart_device", "restart_agent", "reinstall_remote_support", "maintenance_mode", "view_notes", "edit_notes", "view_inventory", "view_patch", "deployment"] },
  { name: "Deployment Operator", perms: ["view_devices", "deployment", "view_inventory"] },
];

const ACTION_PERM_KEYS = new Set([
  "remote_support_connect", "remote_support_manage",
  "restart_device", "restart_agent", "reinstall_remote_support",
  "maintenance_mode", "deployment",
]);

function resolvePermDeps(perms: Set<string>): { resolved: Set<string>; autoAdded: string[] } {
  const resolved = new Set(perms);
  const autoAdded: string[] = [];
  if ([...resolved].some((p) => ACTION_PERM_KEYS.has(p)) && !resolved.has("view_devices")) {
    resolved.add("view_devices"); autoAdded.push("view_devices");
  }
  if (resolved.has("edit_notes") && !resolved.has("view_notes")) {
    resolved.add("view_notes"); autoAdded.push("view_notes");
  }
  if (resolved.has("remote_support_manage") && !resolved.has("remote_support_connect")) {
    resolved.add("remote_support_connect"); autoAdded.push("remote_support_connect");
  }
  return { resolved, autoAdded };
}

function catColor(cat: string): string {
  const map: Record<string, string> = {
    "Visibility":     "text-sky-400",
    "Remote Support": "text-indigo-400",
    "Device Actions": "text-amber-400",
    "Content":        "text-emerald-400",
    "Admin":          "text-red-400",
  };
  return map[cat] ?? "text-slate-400";
}

// ── Team Permissions editor ──────────────────────────────────────────────── //

function PermissionsTab({
  team,
  canManage,
  onSaved,
}: {
  team: TeamDetail;
  canManage: boolean;
  onSaved: (updated: TeamDetail) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(team.permissions));
  const [autoAdded, setAutoAdded] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const originalPerms = useMemo(() => new Set(team.permissions), [team.permissions]);
  const isDirty = useMemo(() => {
    if (selected.size !== originalPerms.size) return true;
    return [...selected].some((p) => !originalPerms.has(p));
  }, [selected, originalPerms]);

  const toggle = (key: string) => {
    const n = new Set(selected);
    n.has(key) ? n.delete(key) : n.add(key);
    const { resolved, autoAdded: added } = resolvePermDeps(n);
    setSelected(resolved);
    setAutoAdded(added);
  };

  const applyTemplate = (perms: string[]) => {
    const { resolved, autoAdded: added } = resolvePermDeps(new Set(perms));
    setSelected(resolved);
    setAutoAdded(added);
  };

  const handleSave = async () => {
    try {
      setLoading(true); setError(null); setSaved(false);
      const updated = await updateTeamPermissions(team.id, Array.from(selected));
      onSaved(updated);
      setAutoAdded([]);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save permissions");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} />}
      {saved && <SaveBanner message="Team permissions saved." />}

      {/* Enforcement callout */}
      <div className="rounded-lg border border-amber-400/15 bg-amber-500/[0.06] px-4 py-3 text-xs leading-5 text-slate-400">
        <span className="font-semibold text-amber-300">Enforcement:</span>{" "}
        These permissions are enforced server-side for{" "}
        <span className="font-semibold text-white">operator</span> and{" "}
        <span className="font-semibold text-white">readonly</span> users.{" "}
        <span className="font-semibold text-orange-200">Owner and Admin bypass all team permission restrictions.</span>
      </div>

      {/* Quick templates */}
      {canManage && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Quick Templates</p>
          <div className="flex flex-wrap gap-2">
            {PERM_TEMPLATES.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() => applyTemplate(t.perms)}
                className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-semibold text-slate-300 transition hover:border-white/15 hover:bg-white/[0.07] hover:text-white"
              >
                {t.name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => { setSelected(new Set()); setAutoAdded([]); }}
              className="rounded-md border border-red-400/15 bg-red-500/[0.05] px-2.5 py-1.5 text-[11px] font-semibold text-red-400/80 transition hover:border-red-400/25 hover:text-red-300"
            >
              Clear All
            </button>
          </div>
        </div>
      )}

      {/* Auto-dependency note */}
      {autoAdded.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-sky-400/15 bg-sky-500/[0.05] px-3 py-2 text-[11px] font-semibold text-sky-300">
          <Info className="h-3.5 w-3.5 shrink-0" />
          Some required permissions were automatically selected:{" "}
          {autoAdded.map((k) => TEAM_PERMISSION_DEFS.find((d) => d.key === k)?.label ?? k).join(", ")}
        </div>
      )}

      {/* Two-panel layout */}
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">

        {/* LEFT: Permission groups */}
        <div className="space-y-3">
          {PERM_CATEGORIES.map((cat) => {
            const rows = TEAM_PERMISSION_DEFS.filter((d) => d.category === cat);
            const selectedCount = rows.filter((r) => selected.has(r.key)).length;
            const color = catColor(cat);
            return (
              <div key={cat} className="overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.02]">
                <div className={`flex items-center gap-2 border-b border-white/[0.06] px-3 py-2 ${color}`}>
                  <span className="text-[11px] font-bold uppercase tracking-wide">{cat}</span>
                  <span className="ml-auto text-[10px] font-semibold text-slate-600">
                    {selectedCount}/{rows.length}
                  </span>
                </div>
                <ul className="divide-y divide-white/[0.04]">
                  {rows.map((row) => {
                    const isSelected = selected.has(row.key);
                    const wasAutoAdded = autoAdded.includes(row.key);
                    return (
                      <li key={row.key}>
                        <label className={`flex items-center gap-3 px-3 py-2.5 transition ${canManage ? "cursor-pointer hover:bg-white/[0.03]" : ""}`}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => canManage && toggle(row.key)}
                            disabled={!canManage}
                            className="h-3.5 w-3.5 shrink-0 rounded border-white/15 accent-orange-500"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`text-[13px] font-semibold ${isSelected ? "text-white" : "text-slate-400"}`}>
                                {row.label}
                              </span>
                              {wasAutoAdded && (
                                <span className="rounded-full bg-sky-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase text-sky-400">
                                  auto
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-600">{row.description}</p>
                          </div>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        {/* RIGHT: Effective Preview */}
        <div className="space-y-3">
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 space-y-4">
            <div>
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                Selected Permissions ({selected.size})
              </p>
              {selected.size === 0 ? (
                <p className="text-xs text-slate-600">No permissions selected. Operators rely on role defaults.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {TEAM_PERMISSION_DEFS.filter((d) => selected.has(d.key)).map((d) => (
                    <span
                      key={d.key}
                      className="rounded-full border border-techi-orange/20 bg-techi-orange/10 px-2 py-0.5 text-[10px] font-semibold text-orange-200"
                    >
                      {d.label}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-white/[0.06] pt-3">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                Operator Capabilities
              </p>
              {selected.size === 0 ? (
                <p className="text-xs text-slate-600">Operators in this team will use their role defaults.</p>
              ) : (
                <ul className="space-y-1">
                  {(
                    [
                      selected.has("view_devices")             && "Can see devices in the fleet",
                      selected.has("remote_support_connect")   && "Can open remote support sessions",
                      selected.has("remote_support_manage")    && "Can manage and end remote sessions",
                      (selected.has("restart_device") || selected.has("restart_agent")) && "Can restart devices and agents",
                      selected.has("reinstall_remote_support") && "Can reinstall remote support",
                      selected.has("maintenance_mode")         && "Can set devices to maintenance mode",
                      selected.has("view_notes")               && "Can read device notes",
                      selected.has("edit_notes")               && "Can create and edit notes",
                      selected.has("view_inventory")           && "Can view software inventory",
                      selected.has("view_patch")               && "Can view patch compliance",
                      selected.has("deployment")               && "Can deploy software packages",
                      (selected.has("manage_clients") || selected.has("manage_groups")) && "Can manage clients and groups",
                      selected.has("manage_operators")         && "Can manage operator accounts",
                      selected.has("audit_log")                && "Can view the audit log",
                      selected.has("system_settings")          && "Can access system settings",
                    ] as (string | false)[]
                  ).filter(Boolean).map((line, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-xs text-slate-400">
                      <Check className="h-3 w-3 shrink-0 text-emerald-500/70" />
                      {line}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-md border border-orange-400/10 bg-orange-500/[0.05] px-3 py-2 text-[11px] leading-4 text-orange-200/70">
              <span className="font-bold text-orange-300">Note:</span> Owner and Admin bypass all team permission restrictions regardless of this setting.
            </div>
          </div>
        </div>
      </div>

      {/* Footer: unsaved indicator + save */}
      {canManage && (
        <div className="flex items-center gap-3 pt-1">
          {isDirty && (
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              Unsaved changes
            </span>
          )}
          <Button onClick={() => void handleSave()} disabled={loading || !isDirty}>
            <Save className="h-3.5 w-3.5" />
            {loading ? "Saving…" : `Save Permissions (${selected.size})`}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────── //

export default function TeamDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canManage = can("admin");

  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [operators, setOperators] = useState<OperatorRecord[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  const teamId = id ? parseInt(id, 10) : NaN;

  const loadAll = async () => {
    if (isNaN(teamId)) { setError("Invalid team ID"); setLoading(false); return; }
    try {
      setLoading(true); setError(null);
      const [t, ops, cls, grps, devs] = await Promise.all([
        getTeam(teamId),
        getOperators(),
        getClients(),
        getGroups(),
        getDevices(),
      ]);
      setTeam(t);
      setOperators(ops);
      setClients(cls);
      setGroups(grps);
      setDevices(devs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load team");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadAll(); }, [teamId]);

  // Effective device count: all non-archived devices reachable via client, group, or explicit assignment
  const effectiveDeviceCount = (() => {
    if (!team) return 0;
    const cIds = new Set(team.client_ids);
    const gIds = new Set(team.group_ids);
    const dIds = new Set(team.device_ids);
    return devices.filter(
      (d) =>
        (d.client_id != null && cIds.has(d.client_id)) ||
        (d.group_id != null && gIds.has(d.group_id)) ||
        dIds.has(d.id)
    ).length;
  })();

  const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "overview",     label: "Overview",       icon: <Shield className="h-3.5 w-3.5" /> },
    { key: "members",      label: "Members",        icon: <Users className="h-3.5 w-3.5" /> },
    { key: "access",       label: "Device Access",  icon: <Building2 className="h-3.5 w-3.5" /> },
    { key: "permissions",  label: "Permissions",    icon: <UsersRound className="h-3.5 w-3.5" /> },
  ];

  if (loading) {
    return <section className="premium-page"><p className="text-sm font-medium text-slate-400">Loading team…</p></section>;
  }

  if (error || !team) {
    return (
      <section className="premium-page space-y-4">
        <button type="button" onClick={() => navigate("/teams")} className="flex items-center gap-1.5 text-sm font-medium text-slate-400 transition hover:text-white">
          <ArrowLeft className="h-4 w-4" /> Back to Teams
        </button>
        <ErrorBanner message={error ?? "Team not found."} />
      </section>
    );
  }

  return (
    <section className="premium-page space-y-5">
      {/* Header card */}
      <div className="premium-card overflow-hidden p-5 md:p-6">
        <div className="mb-4">
          <button type="button" onClick={() => navigate("/teams")} className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 transition hover:text-slate-300">
            <ArrowLeft className="h-3.5 w-3.5" /> Teams
          </button>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="h-9 w-9 shrink-0 rounded-lg" style={{ background: team.color ?? "#f97316" }} />
            <div>
              <p className="premium-kicker">Team</p>
              <h1 className="text-2xl font-semibold text-white">{team.name}</h1>
              {team.description && <p className="mt-0.5 text-sm text-slate-400">{team.description}</p>}
            </div>
          </div>
          <Button size="sm" onClick={() => void loadAll()}>
            <RefreshCcw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>

        {/* Dashboard summary */}
        <div className="mt-5">
          <DashboardSummary team={team} memberCount={team.operator_ids.length} effectiveDeviceCount={effectiveDeviceCount} />
        </div>

        {/* Tab bar */}
        <div className="mt-5 flex gap-1 border-b border-white/[0.06]">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 rounded-t-md px-3.5 py-2 text-[13px] font-semibold transition-all ${tab === t.key ? "border-b-2 border-techi-orange text-white" : "text-slate-500 hover:text-slate-300"}`}
              style={tab === t.key ? { marginBottom: "-1px" } : undefined}
            >
              {t.icon}{t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="premium-card-soft overflow-hidden p-5 md:p-6">
        {tab === "overview" && (
          <OverviewTab team={team} canManage={canManage} onSaved={(u) => setTeam(u)} />
        )}
        {tab === "members" && (
          <MembersTab team={team} operators={operators} canManage={canManage} onSaved={(ids) => setTeam((p) => p ? { ...p, operator_ids: ids } : p)} />
        )}
        {tab === "access" && (
          <AccessTab
            team={team}
            clients={clients}
            groups={groups}
            devices={devices}
            canManage={canManage}
            onSaved={(c, g, d) => setTeam((p) => p ? { ...p, client_ids: c, group_ids: g, device_ids: d } : p)}
          />
        )}
        {tab === "permissions" && (
          <PermissionsTab team={team} canManage={canManage} onSaved={(u) => setTeam(u)} />
        )}
      </div>
    </section>
  );
}
