import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Building2, Check, CheckSquare, ChevronDown, ChevronRight,
  RefreshCcw, Save, Shield, Square, Users, UsersRound, X,
} from "lucide-react";
import {
  TeamDetail,
  getTeam,
  updateTeam,
  updateTeamMembers,
  updateTeamClientAccess,
  updateTeamGroupAccess,
} from "../api/teams";
import { getOperators, OperatorRecord } from "../api/operators";
import { getClients, getGroups, Client, DeviceGroup } from "../api/clients";
import { Button } from "../components/ui";
import { useAuth } from "../auth/AuthContext";

// ── Color presets ────────────────────────────────────────────────────────── //

const COLOR_PRESETS = [
  "#f97316", "#6366f1", "#ec4899", "#10b981",
  "#3b82f6", "#8b5cf6", "#ef4444", "#14b8a6",
  "#f59e0b", "#64748b",
];

// ── Permissions matrix (mirrors backend permission_service.py) ──────────── //

const PERMISSION_ROWS = [
  { key: "view_devices",             label: "View Devices",           category: "Visibility" },
  { key: "remote_support_connect",   label: "Remote Support",         category: "Actions" },
  { key: "restart_device",           label: "Restart Device",         category: "Actions" },
  { key: "restart_agent",            label: "Restart Agent",          category: "Actions" },
  { key: "reinstall_remote_support", label: "Reinstall Remote",       category: "Actions" },
  { key: "maintenance_mode",         label: "Maintenance Mode",       category: "Actions" },
  { key: "view_notes",               label: "View Notes",             category: "Content" },
  { key: "edit_notes",               label: "Edit Notes",             category: "Content" },
  { key: "view_inventory",           label: "View Inventory",         category: "Content" },
  { key: "view_patch",               label: "View Patch Status",      category: "Content" },
  { key: "deployment",               label: "Deployment",             category: "Admin" },
  { key: "manage_clients",           label: "Manage Clients",         category: "Admin" },
  { key: "manage_groups",            label: "Manage Groups",          category: "Admin" },
  { key: "manage_operators",         label: "Manage Operators",       category: "Admin" },
  { key: "audit_log",                label: "Audit Log",              category: "Admin" },
  { key: "system_settings",          label: "System Settings",        category: "Admin" },
];

const ROLE_PERMS: Record<string, Set<string>> = {
  owner: new Set(PERMISSION_ROWS.map((r) => r.key)),
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

// ── Shared constants ─────────────────────────────────────────────────────── //

const INPUT_CLS =
  "th-input w-full rounded-lg border px-3 py-2.5 text-sm font-medium outline-none focus:border-techi-orange/60";
const LABEL_CLS = "block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1";

type Tab = "overview" | "members" | "access" | "permissions";

// ── Sub-components ───────────────────────────────────────────────────────── //

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
      setLoading(true);
      setError(null);
      setSaved(false);
      const updated = await updateTeam(team.id, {
        name: name.trim(),
        description: description.trim() || null,
        color,
      });
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
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canManage}
          className={INPUT_CLS}
        />
      </div>
      <div>
        <label className={LABEL_CLS}>Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!canManage}
          placeholder="What does this team manage?"
          rows={3}
          className={`${INPUT_CLS} resize-none`}
        />
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
      op.username.toLowerCase().includes(search.toLowerCase())
  );

  const allFilteredSelected = filtered.length > 0 && filtered.every((op) => selected.has(op.id));

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const ids = filtered.map((op) => op.id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        ids.forEach((id) => next.delete(id));
      } else {
        ids.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const handleSave = async () => {
    try {
      setLoading(true);
      setError(null);
      setSaved(false);
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
        <p className="text-sm text-slate-400">
          Select which operators belong to this team.
        </p>
        <div className="flex items-center gap-2">
          {canManage && (
            <button
              type="button"
              onClick={toggleAll}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-slate-400 transition hover:bg-white/[0.06] hover:text-white"
            >
              {allFilteredSelected ? (
                <><CheckSquare className="h-3.5 w-3.5" /> Deselect all</>
              ) : (
                <><Square className="h-3.5 w-3.5" /> Select all</>
              )}
            </button>
          )}
        </div>
      </div>

      <div className="relative">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search operators…"
          className="th-input w-full rounded-lg border py-2 pl-3 pr-3 text-sm outline-none focus:border-techi-orange/60"
        />
      </div>

      <div className="premium-card-soft overflow-hidden rounded-lg">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-slate-500">No operators found.</p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {filtered.map((op) => {
              const label = op.display_name ?? op.username;
              const isSelected = selected.has(op.id);
              return (
                <li key={op.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-3 transition hover:bg-white/[0.03]">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(op.id)}
                      disabled={!canManage}
                      className="h-4 w-4 rounded border-white/15 accent-orange-500"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-white truncate">{label}</p>
                      <p className="text-[11px] text-slate-500">{op.email}</p>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                      op.role === "owner"
                        ? "border-orange-300/25 bg-techi-orange/15 text-orange-200"
                        : op.role === "admin"
                        ? "border-red-300/25 bg-red-500/10 text-red-200"
                        : "border-white/[0.10] bg-white/[0.05] text-slate-400"
                    }`}>
                      {op.role}
                    </span>
                  </label>
                </li>
              );
            })}
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

// ── Device Access tab ────────────────────────────────────────────────────── //

function AccessTab({
  team,
  clients,
  groups,
  canManage,
  onSaved,
}: {
  team: TeamDetail;
  clients: Client[];
  groups: DeviceGroup[];
  canManage: boolean;
  onSaved: (clientIds: number[], groupIds: number[]) => void;
}) {
  const [selectedClients, setSelectedClients] = useState<Set<number>>(new Set(team.client_ids));
  const [selectedGroups, setSelectedGroups] = useState<Set<number>>(new Set(team.group_ids));
  const [clientSearch, setClientSearch] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [expandedClients, setExpandedClients] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const filteredClients = clients.filter(
    (c) => clientSearch === "" || c.name.toLowerCase().includes(clientSearch.toLowerCase())
  );

  const filteredGroups = (clientId: number) =>
    groups.filter(
      (g) =>
        g.client_id === clientId &&
        (groupSearch === "" || g.name.toLowerCase().includes(groupSearch.toLowerCase()))
    );

  const toggleClient = (id: number) =>
    setSelectedClients((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleGroup = (id: number) =>
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleExpand = (clientId: number) =>
    setExpandedClients((prev) => {
      const next = new Set(prev);
      next.has(clientId) ? next.delete(clientId) : next.add(clientId);
      return next;
    });

  const handleSave = async () => {
    try {
      setLoading(true);
      setError(null);
      setSaved(false);
      await updateTeamClientAccess(team.id, Array.from(selectedClients));
      await updateTeamGroupAccess(team.id, Array.from(selectedGroups));
      onSaved(Array.from(selectedClients), Array.from(selectedGroups));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save access");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      {error && <ErrorBanner message={error} />}
      {saved && <SaveBanner message="Device access saved." />}

      <div className="rounded-lg border border-blue-400/10 bg-blue-500/[0.05] px-4 py-3 text-xs leading-5 text-slate-400">
        <span className="font-semibold text-slate-300">How access works:</span>{" "}
        Selecting a <span className="font-semibold text-white">client</span> grants the team visibility
        of all that client's devices. Selecting a <span className="font-semibold text-white">group</span> grants
        visibility of devices in that group only.
      </div>

      {/* Clients */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-techi-orange" />
          <h3 className="text-sm font-semibold text-white">Clients</h3>
          <span className="rounded-full border border-white/[0.08] bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold text-slate-400">
            {selectedClients.size} selected
          </span>
        </div>
        <div className="relative">
          <input
            value={clientSearch}
            onChange={(e) => setClientSearch(e.target.value)}
            placeholder="Search clients…"
            className="th-input w-full rounded-lg border py-2 pl-3 pr-3 text-sm outline-none focus:border-techi-orange/60"
          />
        </div>
        <div className="premium-card-soft overflow-hidden rounded-lg">
          {filteredClients.length === 0 ? (
            <p className="px-4 py-5 text-center text-sm text-slate-500">No clients found.</p>
          ) : (
            <ul className="divide-y divide-white/[0.04]">
              {filteredClients.map((client) => {
                const clientGroups = filteredGroups(client.id);
                const hasGroups = groups.some((g) => g.client_id === client.id);
                const isExpanded = expandedClients.has(client.id);
                return (
                  <li key={client.id}>
                    <div className="flex items-center gap-3 px-4 py-3">
                      <label className="flex flex-1 cursor-pointer items-center gap-3 transition hover:bg-white/[0.01]">
                        <input
                          type="checkbox"
                          checked={selectedClients.has(client.id)}
                          onChange={() => toggleClient(client.id)}
                          disabled={!canManage}
                          className="h-4 w-4 rounded border-white/15 accent-orange-500"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-white">{client.name}</p>
                          {client.description && (
                            <p className="text-[11px] text-slate-500 truncate">{client.description}</p>
                          )}
                        </div>
                      </label>
                      {hasGroups && (
                        <button
                          type="button"
                          onClick={() => toggleExpand(client.id)}
                          className="rounded-md p-1 text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-300"
                          title={isExpanded ? "Collapse groups" : "Expand groups"}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                    {isExpanded && clientGroups.length > 0 && (
                      <ul className="border-t border-white/[0.04] bg-white/[0.02]">
                        {clientGroups.map((group) => (
                          <li key={group.id}>
                            <label className="flex cursor-pointer items-center gap-3 py-2.5 pl-10 pr-4 transition hover:bg-white/[0.02]">
                              <input
                                type="checkbox"
                                checked={selectedGroups.has(group.id)}
                                onChange={() => toggleGroup(group.id)}
                                disabled={!canManage}
                                className="h-3.5 w-3.5 rounded border-white/15 accent-orange-500"
                              />
                              <span className="text-[13px] text-slate-300">{group.name}</span>
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
        </div>
      </div>

      {/* Groups (ungrouped / search) */}
      {groupSearch && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-white">Groups matching "{groupSearch}"</h3>
          <div className="premium-card-soft overflow-hidden rounded-lg">
            <ul className="divide-y divide-white/[0.04]">
              {groups
                .filter((g) => g.name.toLowerCase().includes(groupSearch.toLowerCase()))
                .map((group) => {
                  const client = clients.find((c) => c.id === group.client_id);
                  return (
                    <li key={group.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-4 py-3 transition hover:bg-white/[0.02]">
                        <input
                          type="checkbox"
                          checked={selectedGroups.has(group.id)}
                          onChange={() => toggleGroup(group.id)}
                          disabled={!canManage}
                          className="h-4 w-4 rounded border-white/15 accent-orange-500"
                        />
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-white">{group.name}</p>
                          {client && <p className="text-[11px] text-slate-500">{client.name}</p>}
                        </div>
                      </label>
                    </li>
                  );
                })}
            </ul>
          </div>
        </div>
      )}

      {!groupSearch && (
        <div className="relative">
          <input
            value={groupSearch}
            onChange={(e) => setGroupSearch(e.target.value)}
            placeholder="Search all groups across clients…"
            className="th-input w-full rounded-lg border py-2 pl-3 pr-3 text-sm outline-none focus:border-techi-orange/60"
          />
        </div>
      )}

      {canManage && (
        <Button onClick={() => void handleSave()} disabled={loading}>
          <Save className="h-3.5 w-3.5" />
          {loading ? "Saving…" : "Save Access"}
        </Button>
      )}
    </div>
  );
}

// ── Permissions Preview tab ──────────────────────────────────────────────── //

const ROLE_COLUMNS = [
  { key: "owner",    label: "Owner",    cls: "text-orange-300" },
  { key: "admin",    label: "Admin",    cls: "text-red-300" },
  { key: "operator", label: "Operator", cls: "text-slate-300" },
  { key: "readonly", label: "Readonly", cls: "text-slate-500" },
];

const CATEGORY_ORDER = ["Visibility", "Actions", "Content", "Admin"];

function PermissionsTab() {
  const categories = CATEGORY_ORDER.map((cat) => ({
    label: cat,
    rows: PERMISSION_ROWS.filter((r) => r.category === cat),
  }));

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-indigo-400/10 bg-indigo-500/[0.05] px-4 py-3 text-xs leading-5 text-slate-400">
        <span className="font-semibold text-slate-300">Role vs Team:</span>{" "}
        A user's <span className="font-semibold text-white">role</span> controls{" "}
        <em>what actions</em> they can perform. Their{" "}
        <span className="font-semibold text-white">team membership</span> controls{" "}
        <em>which devices</em> they can see. Admin/Owner users bypass all team restrictions
        and see the full fleet.
      </div>

      <div className="premium-card-soft overflow-hidden rounded-lg">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500 min-w-[180px]">
                  Permission
                </th>
                {ROLE_COLUMNS.map((col) => (
                  <th key={col.key} className={`px-4 py-3 text-center text-[11px] font-bold uppercase tracking-wide ${col.cls}`}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categories.map((cat) => (
                <>
                  <tr key={`cat-${cat.label}`} className="border-b border-white/[0.04]">
                    <td
                      colSpan={5}
                      className="px-5 py-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-600"
                    >
                      {cat.label}
                    </td>
                  </tr>
                  {cat.rows.map((row) => (
                    <tr key={row.key} className="border-b border-white/[0.03] transition hover:bg-white/[0.02]">
                      <td className="px-5 py-2.5 text-[13px] text-slate-300">{row.label}</td>
                      {ROLE_COLUMNS.map((col) => {
                        const has = ROLE_PERMS[col.key]?.has(row.key) ?? false;
                        return (
                          <td key={col.key} className="px-4 py-2.5 text-center">
                            {has ? (
                              <Check className={`inline h-3.5 w-3.5 ${col.cls}`} />
                            ) : (
                              <X className="inline h-3 w-3 text-slate-700" />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────── //

export default function TeamDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canManage = can("admin");

  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [operators, setOperators] = useState<OperatorRecord[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  const teamId = id ? parseInt(id, 10) : NaN;

  const loadAll = async () => {
    if (isNaN(teamId)) { setError("Invalid team ID"); setLoading(false); return; }
    try {
      setLoading(true);
      setError(null);
      const [t, ops, cls, grps] = await Promise.all([
        getTeam(teamId),
        getOperators(),
        getClients(),
        getGroups(),
      ]);
      setTeam(t);
      setOperators(ops);
      setClients(cls);
      setGroups(grps);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load team");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadAll(); }, [teamId]);

  const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "overview",     label: "Overview",            icon: <Shield className="h-3.5 w-3.5" /> },
    { key: "members",      label: "Members",             icon: <Users className="h-3.5 w-3.5" /> },
    { key: "access",       label: "Device Access",       icon: <Building2 className="h-3.5 w-3.5" /> },
    { key: "permissions",  label: "Permissions Preview", icon: <UsersRound className="h-3.5 w-3.5" /> },
  ];

  if (loading) {
    return (
      <section className="premium-page">
        <p className="text-sm font-medium text-slate-400">Loading team…</p>
      </section>
    );
  }

  if (error || !team) {
    return (
      <section className="premium-page space-y-4">
        <button
          type="button"
          onClick={() => navigate("/teams")}
          className="flex items-center gap-1.5 text-sm font-medium text-slate-400 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Teams
        </button>
        <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">
          {error ?? "Team not found."}
        </div>
      </section>
    );
  }

  return (
    <section className="premium-page space-y-5">
      {/* Header */}
      <div className="premium-card overflow-hidden p-5 md:p-6">
        <div className="mb-4">
          <button
            type="button"
            onClick={() => navigate("/teams")}
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 transition hover:text-slate-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Teams
          </button>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span
              className="h-8 w-8 shrink-0 rounded-lg"
              style={{ background: team.color ?? "#f97316" }}
            />
            <div>
              <p className="premium-kicker">Team</p>
              <h1 className="text-2xl font-semibold text-white">{team.name}</h1>
              {team.description && (
                <p className="mt-0.5 text-sm text-slate-400">{team.description}</p>
              )}
            </div>
          </div>
          <Button size="sm" onClick={() => void loadAll()}>
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>

        {/* Tab bar */}
        <div className="mt-5 flex gap-1 border-b border-white/[0.06] pb-0">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 rounded-t-md px-3.5 py-2 text-[13px] font-semibold transition-all ${
                tab === t.key
                  ? "border-b-2 border-techi-orange text-white"
                  : "text-slate-500 hover:text-slate-300"
              }`}
              style={tab === t.key ? { marginBottom: "-1px" } : undefined}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="premium-card-soft overflow-hidden p-5 md:p-6">
        {tab === "overview" && (
          <OverviewTab
            team={team}
            canManage={canManage}
            onSaved={(updated) => setTeam(updated)}
          />
        )}
        {tab === "members" && (
          <MembersTab
            team={team}
            operators={operators}
            canManage={canManage}
            onSaved={(ids) => setTeam((prev) => prev ? { ...prev, operator_ids: ids } : prev)}
          />
        )}
        {tab === "access" && (
          <AccessTab
            team={team}
            clients={clients}
            groups={groups}
            canManage={canManage}
            onSaved={(clientIds, groupIds) =>
              setTeam((prev) => prev ? { ...prev, client_ids: clientIds, group_ids: groupIds } : prev)
            }
          />
        )}
        {tab === "permissions" && <PermissionsTab />}
      </div>
    </section>
  );
}
