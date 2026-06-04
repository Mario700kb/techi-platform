import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Building2, Check, CheckSquare, ChevronDown, ChevronRight,
  Cpu, RefreshCcw, Save, Shield, Square, Users, UsersRound, X,
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
  { key: "view_devices",             label: "View Devices",       description: "See devices in the fleet", category: "Visibility" },
  { key: "remote_support_connect",   label: "Remote Support",     description: "Open remote support sessions", category: "Actions" },
  { key: "restart_device",           label: "Restart Device",     description: "Send device restart command", category: "Actions" },
  { key: "restart_agent",            label: "Restart Agent",      description: "Restart the management agent", category: "Actions" },
  { key: "reinstall_remote_support", label: "Reinstall Remote",   description: "Reinstall remote support software", category: "Actions" },
  { key: "maintenance_mode",         label: "Maintenance Mode",   description: "Put devices in maintenance mode", category: "Actions" },
  { key: "view_notes",               label: "View Notes",         description: "Read device notes", category: "Content" },
  { key: "edit_notes",               label: "Edit Notes",         description: "Create and edit device notes", category: "Content" },
  { key: "view_inventory",           label: "View Inventory",     description: "View software inventory", category: "Content" },
  { key: "view_patch",               label: "View Patch Status",  description: "View patch compliance data", category: "Content" },
  { key: "deployment",               label: "Deploy Packages",    description: "Deploy software packages", category: "Admin" },
  { key: "manage_clients",           label: "Manage Clients",     description: "Add, edit, remove clients", category: "Admin" },
  { key: "manage_groups",            label: "Manage Groups",      description: "Add, edit, remove device groups", category: "Admin" },
  { key: "manage_operators",         label: "Manage Operators",   description: "Create and manage operator accounts", category: "Admin" },
  { key: "audit_log",                label: "View Audit Log",     description: "Read the system audit log", category: "Admin" },
  { key: "system_settings",          label: "System Settings",    description: "Access system-level settings", category: "Admin" },
];

const PERM_CATEGORIES = ["Visibility", "Actions", "Content", "Admin"];

// ── Role permission matrix (mirrors backend permission_service.py) ────────── //

const ROLE_PERMS: Record<string, Set<string>> = {
  owner: new Set(TEAM_PERMISSION_DEFS.map((d) => d.key)),
  admin: new Set([
    "view_devices", "remote_support_connect", "restart_device", "restart_agent",
    "reinstall_remote_support", "maintenance_mode", "view_notes", "edit_notes",
    "view_inventory", "view_patch", "deployment", "manage_clients", "manage_groups",
    "manage_operators", "audit_log",
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
}: {
  team: TeamDetail;
  memberCount: number;
}) {
  const statBoxCls =
    "flex flex-col gap-1 rounded-lg border border-white/[0.07] bg-white/[0.03] px-4 py-3";

  const permLabels = TEAM_PERMISSION_DEFS.filter((d) => team.permissions.includes(d.key)).map((d) => d.label);

  return (
    <div className="space-y-4">
      {/* Stat grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Devices</span>
          <span className="text-2xl font-bold text-white">{team.device_ids.length}</span>
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

  const toggleC = (id: number) =>
    setSelClients((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleG = (id: number) =>
    setSelGroups((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleD = (id: number) =>
    setSelDevices((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleExC = (id: number) =>
    setExClients((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleExG = (id: number) =>
    setExGroups((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

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
        <span className="font-semibold text-white">Client</span> — all devices for that client.{" "}
        <span className="font-semibold text-white">Group</span> — all devices in that group.{" "}
        <span className="font-semibold text-white">Device</span> — specific individual devices.
        Access is the union of all selections.
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

      {/* Search */}
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search clients, groups, or devices…"
        className="th-input w-full rounded-lg border py-2 px-3 text-sm outline-none focus:border-techi-orange/60"
      />

      {/* Tree */}
      <div className="premium-card-soft overflow-hidden rounded-lg">
        {filteredClients.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">No clients found.</p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {filteredClients.map((client) => {
              const clientGroups = groupsFor(client.id);
              const isExC = exClients.has(client.id);
              return (
                <li key={client.id}>
                  {/* Client row — click anywhere on row to expand */}
                  <div
                    className="flex cursor-pointer items-center gap-3 px-4 py-3 transition hover:bg-white/[0.03]"
                    onClick={() => toggleExC(client.id)}
                  >
                    <span onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selClients.has(client.id)}
                        onChange={() => canManage && toggleC(client.id)}
                        disabled={!canManage}
                        className="h-4 w-4 rounded border-white/15 accent-orange-500"
                      />
                    </span>
                    <Building2 className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-white">{client.name}</p>
                      {client.description && (
                        <p className="text-[11px] text-slate-500 truncate">{client.description}</p>
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
                        return (
                          <li key={group.id}>
                            {/* Group row */}
                            <div
                              className="flex cursor-pointer items-center gap-3 py-2.5 pl-9 pr-4 transition hover:bg-white/[0.02]"
                              onClick={() => groupDevices.length > 0 && toggleExG(group.id)}
                            >
                              <span onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={selGroups.has(group.id)}
                                  onChange={() => canManage && toggleG(group.id)}
                                  disabled={!canManage}
                                  className="h-3.5 w-3.5 rounded border-white/15 accent-orange-500"
                                />
                              </span>
                              <Users className="h-3 w-3 shrink-0 text-slate-600" />
                              <span className="flex-1 text-[13px] text-slate-300">{group.name}</span>
                              {groupDevices.length > 0 && (
                                <>
                                  <span className="text-[10px] text-slate-600">{groupDevices.length}</span>
                                  {isExG
                                    ? <ChevronDown className="h-3 w-3 shrink-0 text-slate-600" />
                                    : <ChevronRight className="h-3 w-3 shrink-0 text-slate-600" />
                                  }
                                </>
                              )}
                            </div>

                            {/* Devices under group */}
                            {isExG && groupDevices.length > 0 && (
                              <ul className="border-t border-white/[0.03] bg-white/[0.01]">
                                {groupDevices.map((device) => (
                                  <li key={device.id}>
                                    <label className="flex cursor-pointer items-center gap-3 py-2 pl-14 pr-4 transition hover:bg-white/[0.02]">
                                      <input
                                        type="checkbox"
                                        checked={selDevices.has(device.id)}
                                        onChange={() => canManage && toggleD(device.id)}
                                        disabled={!canManage}
                                        className="h-3 w-3 rounded border-white/15 accent-orange-500"
                                      />
                                      <Cpu className="h-2.5 w-2.5 shrink-0 text-slate-700" />
                                      <span className="flex-1 font-mono text-[12px] text-slate-400">
                                        {device.hostname ?? device.rustdesk_id}
                                      </span>
                                      <span className={`text-[10px] font-semibold ${device.status === "online" ? "text-emerald-500" : "text-slate-600"}`}>
                                        {device.status}
                                      </span>
                                    </label>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
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

// ── Team Permissions editor ──────────────────────────────────────────────── //

const ROLE_COLUMNS = [
  { key: "owner",    label: "Owner",    cls: "text-orange-300" },
  { key: "admin",    label: "Admin",    cls: "text-red-300" },
  { key: "operator", label: "Operator", cls: "text-slate-300" },
  { key: "readonly", label: "Readonly", cls: "text-slate-500" },
];

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const toggle = (key: string) =>
    setSelected((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const selectAll = () => setSelected(new Set(TEAM_PERMISSION_DEFS.map((d) => d.key)));
  const clearAll  = () => setSelected(new Set());

  const handleSave = async () => {
    try {
      setLoading(true); setError(null); setSaved(false);
      const updated = await updateTeamPermissions(team.id, Array.from(selected));
      onSaved(updated);
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

      <div className="rounded-lg border border-indigo-400/10 bg-indigo-500/[0.05] px-4 py-3 text-xs leading-5 text-slate-400">
        <span className="font-semibold text-slate-300">Team permissions vs role permissions:</span>{" "}
        A user's <span className="font-semibold text-white">role</span> determines their base capabilities.
        Permissions set here are granted <em>additionally</em> to team members, or serve as a
        reference for what this team is expected to do.{" "}
        <span className="font-semibold text-orange-200">Admin and Owner bypass all team restrictions.</span>
      </div>

      {canManage && (
        <div className="flex gap-2">
          <button type="button" onClick={selectAll} className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-slate-400 transition hover:bg-white/[0.06] hover:text-white">
            <CheckSquare className="h-3.5 w-3.5" /> Select all
          </button>
          <button type="button" onClick={clearAll} className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-slate-400 transition hover:bg-white/[0.06] hover:text-white">
            <X className="h-3.5 w-3.5" /> Clear all
          </button>
        </div>
      )}

      {/* Permission matrix with checkboxes + role reference */}
      <div className="premium-card-soft overflow-hidden rounded-lg">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500 min-w-[220px]">
                  Permission
                </th>
                <th className="px-4 py-3 text-center text-[11px] font-bold uppercase tracking-wide text-techi-orange">
                  Team
                </th>
                {ROLE_COLUMNS.map((col) => (
                  <th key={col.key} className={`px-3 py-3 text-center text-[11px] font-bold uppercase tracking-wide ${col.cls}`}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERM_CATEGORIES.map((cat) => {
                const rows = TEAM_PERMISSION_DEFS.filter((d) => d.category === cat);
                return (
                  <>
                    <tr key={`cat-${cat}`} className="border-b border-white/[0.04]">
                      <td colSpan={6} className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-600">
                        {cat}
                      </td>
                    </tr>
                    {rows.map((row) => {
                      const isSelected = selected.has(row.key);
                      return (
                        <tr key={row.key} className="border-b border-white/[0.03] transition hover:bg-white/[0.02]">
                          <td className="px-4 py-2.5">
                            <label className={`flex items-start gap-3 ${canManage ? "cursor-pointer" : ""}`}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => canManage && toggle(row.key)}
                                disabled={!canManage}
                                className="mt-0.5 h-3.5 w-3.5 rounded border-white/15 accent-orange-500"
                              />
                              <div>
                                <p className="text-[13px] font-semibold text-slate-200">{row.label}</p>
                                <p className="text-[11px] text-slate-600">{row.description}</p>
                              </div>
                            </label>
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            {isSelected
                              ? <Check className="inline h-3.5 w-3.5 text-techi-orange" />
                              : <span className="text-slate-700">—</span>
                            }
                          </td>
                          {ROLE_COLUMNS.map((col) => {
                            const has = ROLE_PERMS[col.key]?.has(row.key) ?? false;
                            return (
                              <td key={col.key} className="px-3 py-2.5 text-center">
                                {has
                                  ? <Check className={`inline h-3.5 w-3.5 ${col.cls}`} />
                                  : <X className="inline h-3 w-3 text-slate-700" />
                                }
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {canManage && (
        <Button onClick={() => void handleSave()} disabled={loading}>
          <Save className="h-3.5 w-3.5" />
          {loading ? "Saving…" : `Save Permissions (${selected.size})`}
        </Button>
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
          <DashboardSummary team={team} memberCount={team.operator_ids.length} />
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
