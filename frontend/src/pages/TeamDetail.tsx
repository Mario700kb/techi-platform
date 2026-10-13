import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  Info,
  KeyRound,
  Layers,
  Monitor,
  RefreshCcw,
  Search,
  Shield,
  ShieldCheck,
  Users,
  UsersRound,
  X,
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
import { getDeviceDirectory, DeviceDirectoryEntry as Device } from "../api/devices";
import { Button, EmptyState } from "../components/ui";
import { CardHead } from "../components/ui/PanelCard";
import SaveFooter, { useSaveState } from "../components/ui/SaveFooter";
import TablePagination from "../components/ui/TablePagination";
import { useAuth } from "../auth/AuthContext";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { useTabIndicator } from "../hooks/useTabIndicator";
import { TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { toggled } from "../utils/sets";
import { activateProps, stopRowClick } from "../utils/a11y";
import { TEAM_COLOR_PRESETS } from "../utils/teamColors";

// ── Team permission definitions ──────────────────────────────────────────── //

export const TEAM_PERMISSION_DEFS: { key: string; label: string; description: string; category: string }[] = [
  { key: "view_devices", label: "View Devices", description: "See devices in the fleet", category: "Visibility" },
  {
    key: "remote_support_connect",
    label: "Connect",
    description: "Open remote support sessions",
    category: "Remote Support",
  },
  {
    key: "remote_support_manage",
    label: "Manage Sessions",
    description: "End or transfer remote support sessions",
    category: "Remote Support",
  },
  {
    key: "restart_device",
    label: "Restart Device",
    description: "Send device restart command",
    category: "Device Actions",
  },
  {
    key: "restart_agent",
    label: "Restart Agent",
    description: "Restart the management agent",
    category: "Device Actions",
  },
  {
    key: "reinstall_remote_support",
    label: "Reinstall Remote",
    description: "Reinstall remote support software",
    category: "Device Actions",
  },
  {
    key: "maintenance_mode",
    label: "Maintenance Mode",
    description: "Put devices in maintenance mode",
    category: "Device Actions",
  },
  { key: "view_notes", label: "View Notes", description: "Read device notes", category: "Content" },
  { key: "edit_notes", label: "Edit Notes", description: "Create and edit device notes", category: "Content" },
  { key: "view_inventory", label: "View Inventory", description: "View software inventory", category: "Content" },
  { key: "view_patch", label: "View Patch Status", description: "View patch compliance data", category: "Content" },
  { key: "deployment", label: "Deploy Packages", description: "Deploy software packages", category: "Admin" },
  { key: "manage_clients", label: "Manage Clients", description: "Add, edit, remove clients", category: "Admin" },
  { key: "manage_groups", label: "Manage Groups", description: "Add, edit, remove device groups", category: "Admin" },
  {
    key: "manage_operators",
    label: "Manage Operators",
    description: "Create and manage operator accounts",
    category: "Admin",
  },
  { key: "audit_log", label: "View Audit Log", description: "Read the system audit log", category: "Admin" },
  { key: "system_settings", label: "System Settings", description: "Access system-level settings", category: "Admin" },
  {
    key: "vault_view",
    label: "View Vault",
    description: "See Credential Vault entries (list only, never secrets)",
    category: "Vault",
  },
  {
    key: "vault_create",
    label: "Create Vault Credentials",
    description: "Add new credentials to the Vault",
    category: "Vault",
  },
  {
    key: "vault_edit",
    label: "Edit Vault Credentials",
    description: "Update credential metadata and rotate secrets",
    category: "Vault",
  },
  {
    key: "vault_reveal",
    label: "Reveal Vault Secrets",
    description: "View a credential's plaintext secret (audited)",
    category: "Vault",
  },
  {
    key: "vault_delete",
    label: "Delete Vault Credentials",
    description: "Remove credentials from the Vault",
    category: "Vault",
  },
  {
    key: "vault_test",
    label: "Test Vault Credentials",
    description: "Run a connection test where supported",
    category: "Vault",
  },
  {
    key: "vault_assign",
    label: "Assign Vault Credentials",
    description: "Link credentials to clients/devices",
    category: "Vault",
  },
];

const PERM_CATEGORIES = ["Visibility", "Remote Support", "Device Actions", "Content", "Admin", "Vault"];

const CATEGORY_TONE: Record<string, string> = {
  Visibility: TONE.info,
  "Remote Support": "var(--th-status-agent)",
  "Device Actions": TONE.warning,
  Content: TONE.online,
  Admin: TONE.critical,
  Vault: TONE.maintenance,
};

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  operator: "Operator",
  readonly: "Read-only",
};
const ROLE_TONE: Record<string, string> = {
  owner: "var(--th-accent)",
  admin: TONE.warning,
  operator: TONE.info,
  readonly: TONE.neutral,
};

type Tab = "overview" | "members" | "access" | "permissions";

const tone = (value: string) => ({ "--onb-tone": value }) as CSSProperties;

function ColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (c: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Team colour">
      {TEAM_COLOR_PRESETS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          disabled={disabled}
          onClick={() => onChange(c)}
          className="th-onb-swatch"
          style={{ "--swatch": c } as CSSProperties}
        />
      ))}
    </div>
  );
}

const sameSet = <T,>(a: Set<T>, b: Set<T>) => a.size === b.size && [...a].every((x) => b.has(x));

// ── Overview ──────────────────────────────────────────────────────────────── //

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
  const [color, setColor] = useState(team.color ?? TEAM_COLOR_PRESETS[0]);
  const state = useSaveState();
  const dirty =
    name.trim() !== team.name ||
    description.trim() !== (team.description ?? "") ||
    color !== (team.color ?? TEAM_COLOR_PRESETS[0]);

  const save = () => {
    if (!name.trim()) return;
    void state.run(
      async () => {
        onSaved(await updateTeam(team.id, { name: name.trim(), description: description.trim() || null, color }));
      },
      "Team details saved",
      "Failed to save",
    );
  };

  return (
    <div className="th-onb-card th-onb-enter">
      <CardHead
        icon={Shield}
        tone="var(--th-accent)"
        title="Team details"
        subtitle="How the team appears across the console"
      />
      <div className="th-onb-body">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="th-onb-field">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canManage}
              id="team-name"
              aria-label="Team name"
            />
            {!name.trim() && (
              <span className="th-onb-hint" style={{ color: "var(--th-status-critical)" }}>
                A name is required
              </span>
            )}
          </label>
          <div className="th-onb-field">
            Colour
            <div className="flex min-h-9 items-center">
              <ColorPicker value={color} onChange={setColor} disabled={!canManage} />
            </div>
          </div>
        </div>
        <label className="th-onb-field">
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={!canManage}
            rows={3}
            placeholder="What does this team look after?"
          />
        </label>
      </div>
      <SaveFooter
        canManage={canManage}
        dirty={dirty && !!name.trim()}
        saving={state.saving}
        saved={state.saved}
        error={state.error}
        label="Save details"
        onSave={save}
      />
    </div>
  );
}

// ── Members ───────────────────────────────────────────────────────────────── //

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
  const state = useSaveState();
  const original = useMemo(() => new Set(team.operator_ids), [team.operator_ids]);
  const dirty = !sameSet(selected, original);

  const q = search.trim().toLowerCase();
  const filtered = operators.filter(
    (op) =>
      !q ||
      (op.display_name ?? op.username).toLowerCase().includes(q) ||
      op.email.toLowerCase().includes(q) ||
      op.username.toLowerCase().includes(q),
  );
  const allSelected = filtered.length > 0 && filtered.every((op) => selected.has(op.id));

  const toggle = (id: number) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () =>
    setSelected((prev) => {
      const n = new Set(prev);
      for (const op of filtered) {
        if (allSelected) n.delete(op.id);
        else n.add(op.id);
      }
      return n;
    });

  const save = () =>
    void state.run(
      async () => {
        await updateTeamMembers(team.id, Array.from(selected));
        onSaved(Array.from(selected));
      },
      `${selected.size} member${selected.size === 1 ? "" : "s"} saved`,
      "Failed to save members",
    );

  return (
    <div className="th-onb-card th-onb-enter">
      <CardHead
        icon={Users}
        tone={TONE.info}
        title="Members"
        subtitle={`${formatCount(selected.size)} of ${formatCount(operators.length)} operators belong to this team`}
        aside={
          <div className="flex items-center gap-2">
            <div className="w-[240px]">
              <label className="th-search th-search-sm">
                <Search className="h-3.5 w-3.5 flex-none" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search operators"
                  aria-label="Search operators"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="th-explorer-clear"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </label>
            </div>
            {canManage && (
              <Button size="sm" variant="secondary" onClick={toggleAll} disabled={filtered.length === 0}>
                {allSelected ? "Clear all" : "Select all"}
              </Button>
            )}
          </div>
        }
      />
      {filtered.length === 0 ? (
        <EmptyState className="py-10" icon={<Users className="h-5 w-5" />} title="No operators match" />
      ) : (
        <ul className="th-team-list">
          {filtered.map((op, index) => {
            const label = op.display_name ?? op.username;
            const checked = selected.has(op.id);
            return (
              <li key={op.id} className="th-alerts-row" style={{ "--row": index } as CSSProperties}>
                <label
                  className="th-team-row"
                  data-checked={checked || undefined}
                  data-disabled={!canManage || undefined}
                >
                  <input
                    type="checkbox"
                    className="th-team-check"
                    checked={checked}
                    onChange={() => toggle(op.id)}
                    disabled={!canManage}
                    aria-label={`Member: ${label}`}
                  />
                  <span className="th-onb-avatar !h-8 !w-8 !text-[12px]" aria-hidden="true">
                    {label.charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="th-alerts-primary">{label}</span>
                    <span className="th-alerts-secondary">
                      <span className="font-mono">{op.username}</span> · {op.email}
                    </span>
                  </span>
                  {!op.is_active && (
                    <span className="th-status-chip" style={{ "--chip-tone": TONE.neutral } as CSSProperties}>
                      <i />
                      Inactive
                    </span>
                  )}
                  <span
                    className="th-status-chip"
                    style={{ "--chip-tone": ROLE_TONE[op.role] ?? TONE.neutral } as CSSProperties}
                  >
                    <Shield className="h-3 w-3" style={{ color: ROLE_TONE[op.role] }} />
                    {ROLE_LABEL[op.role] ?? op.role}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <SaveFooter
        canManage={canManage}
        dirty={dirty}
        saving={state.saving}
        saved={state.saved}
        error={state.error}
        label={`Save members (${selected.size})`}
        onSave={save}
      />
    </div>
  );
}

// ── Device access — client → group → device ───────────────────────────────── //

type CheckState = "checked" | "indeterminate" | "unchecked" | "inherited";

function TreeCheckbox({
  state,
  onChange,
  disabled,
  label,
  inheritedFrom,
}: {
  state: CheckState;
  onChange?: () => void;
  disabled?: boolean;
  label: string;
  inheritedFrom?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "indeterminate";
  }, [state]);
  if (state === "inherited") {
    return (
      <span
        className="th-team-inherited"
        title={inheritedFrom ?? "Access inherited from parent"}
        aria-label={`${label}: inherited`}
      >
        <Check className="h-3 w-3" />
      </span>
    );
  }
  return (
    <input
      ref={ref}
      type="checkbox"
      className="th-team-check"
      checked={state === "checked"}
      onChange={onChange ?? (() => {})}
      disabled={disabled}
      aria-label={label}
    />
  );
}

function DeviceStatusDot({ device }: { device: Device }) {
  const state = device.freshness_state;
  const color = state === "online" ? TONE.online : state === "stale" ? TONE.warning : TONE.neutral;
  return <span className="th-onb-dot !h-2 !w-2" style={{ "--swatch": color } as CSSProperties} title={state} />;
}

type AccessFilter = "all" | "granted" | "none";

const ACCESS_FILTERS: { id: AccessFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "granted", label: "With access" },
  { id: "none", label: "No access" },
];

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
  const [selGroups, setSelGroups] = useState<Set<number>>(new Set(team.group_ids));
  const [selDevices, setSelDevices] = useState<Set<number>>(new Set(team.device_ids));
  const [exClients, setExClients] = useState<Set<number>>(new Set());
  const [exGroups, setExGroups] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AccessFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Selecting a client auto-expands it; deselecting doesn't collapse
  const toggleC = (id: number) =>
    setSelClients((p) => {
      const n = new Set(p);
      if (n.has(id)) {
        n.delete(id);
      } else {
        n.add(id);
        setExClients((ex) => {
          const e = new Set(ex);
          e.add(id);
          return e;
        });
      }
      return n;
    });

  // Selecting a group auto-expands it
  const toggleG = (id: number) =>
    setSelGroups((p) => {
      const n = new Set(p);
      if (n.has(id)) {
        n.delete(id);
      } else {
        n.add(id);
        setExGroups((ex) => {
          const e = new Set(ex);
          e.add(id);
          return e;
        });
      }
      return n;
    });

  const toggleD = (id: number) => setSelDevices((p) => toggled(p, id));
  const toggleExC = (id: number) => setExClients((p) => toggled(p, id));
  const toggleExG = (id: number) => setExGroups((p) => toggled(p, id));

  const expandAll = () => {
    setExClients(new Set(clients.map((c) => c.id)));
    setExGroups(new Set(groups.map((g) => g.id)));
  };
  const collapseAll = () => {
    setExClients(new Set());
    setExGroups(new Set());
  };

  const accessIndex = useMemo(() => {
    const groupsByClient = new Map<number, DeviceGroup[]>();
    const devicesByGroup = new Map<number, Device[]>();
    const devicesByClient = new Map<number, Device[]>();
    const ungroupedByClient = new Map<number, Device[]>();
    for (const group of groups) {
      if (group.client_id == null) continue;
      groupsByClient.set(group.client_id, [...(groupsByClient.get(group.client_id) ?? []), group]);
    }
    for (const device of devices) {
      if (device.client_id != null) {
        devicesByClient.set(device.client_id, [...(devicesByClient.get(device.client_id) ?? []), device]);
        if (device.group_id == null) {
          ungroupedByClient.set(device.client_id, [...(ungroupedByClient.get(device.client_id) ?? []), device]);
        }
      }
      if (device.group_id != null) {
        devicesByGroup.set(device.group_id, [...(devicesByGroup.get(device.group_id) ?? []), device]);
      }
    }
    return { groupsByClient, devicesByGroup, devicesByClient, ungroupedByClient };
  }, [devices, groups]);

  const normalizedSearch = search.trim().toLowerCase();
  const matchesSearch = (value?: string | null) =>
    !normalizedSearch || (value ?? "").toLowerCase().includes(normalizedSearch);
  const groupsFor = (clientId: number) =>
    (accessIndex.groupsByClient.get(clientId) ?? []).filter((group) => matchesSearch(group.name));
  const devicesFor = (groupId: number) =>
    (accessIndex.devicesByGroup.get(groupId) ?? []).filter((device) => matchesSearch(device.hostname));
  const ungroupedDevicesFor = (clientId: number) =>
    (accessIndex.ungroupedByClient.get(clientId) ?? []).filter((device) => matchesSearch(device.hostname));
  const filteredClients = clients.filter(
    (client) =>
      matchesSearch(client.name) ||
      (accessIndex.groupsByClient.get(client.id) ?? []).some((group) => matchesSearch(group.name)) ||
      (accessIndex.devicesByClient.get(client.id) ?? []).some((device) => matchesSearch(device.hostname)),
  );
  const clientDeviceCount = (clientId: number) => accessIndex.devicesByClient.get(clientId)?.length ?? 0;

  // ── Computed check states ──────────────────────────────────────────────── //

  const clientCheckState = (clientId: number): CheckState => {
    if (selClients.has(clientId)) return "checked";
    const clientGroups = accessIndex.groupsByClient.get(clientId) ?? [];
    const anyDescendantSelected =
      clientGroups.some((g) => selGroups.has(g.id)) ||
      (accessIndex.devicesByClient.get(clientId) ?? []).some((d) => selDevices.has(d.id));
    return anyDescendantSelected ? "indeterminate" : "unchecked";
  };

  const hasAccess = (clientId: number) => clientCheckState(clientId) !== "unchecked";
  const accessCounts: Record<AccessFilter, number> = {
    all: filteredClients.length,
    granted: filteredClients.filter((client) => hasAccess(client.id)).length,
    none: filteredClients.filter((client) => !hasAccess(client.id)).length,
  };
  const listedClients =
    filter === "all"
      ? filteredClients
      : filteredClients.filter((client) => hasAccess(client.id) === (filter === "granted"));
  const pageCount = Math.max(1, Math.ceil(listedClients.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pagedClients = listedClients.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const filterTabsRef = useTabIndicator<HTMLDivElement>(filter);

  const groupCheckState = (group: DeviceGroup): CheckState => {
    if (selClients.has(group.client_id ?? -1)) return "inherited";
    if (selGroups.has(group.id)) return "checked";
    const anyDeviceSelected = (accessIndex.devicesByGroup.get(group.id) ?? []).some((d) => selDevices.has(d.id));
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
      setLoading(true);
      setError(null);
      setSaved(false);
      await Promise.all([
        updateTeamClientAccess(team.id, Array.from(selClients)),
        updateTeamGroupAccess(team.id, Array.from(selGroups)),
        updateTeamDeviceAccess(team.id, Array.from(selDevices)),
      ]);
      onSaved(Array.from(selClients), Array.from(selGroups), Array.from(selDevices));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save access");
    } finally {
      setLoading(false);
    }
  };

  const dirty =
    !sameSet(selClients, new Set(team.client_ids)) ||
    !sameSet(selGroups, new Set(team.group_ids)) ||
    !sameSet(selDevices, new Set(team.device_ids));

  const deviceRow = (device: Device, dState: CheckState, inheritedFrom?: string) => {
    const dInherited = dState === "inherited";
    const name = device.hostname ?? device.rustdesk_id ?? `Device #${device.id}`;
    return (
      <li key={device.id}>
        <div
          className="th-team-node"
          data-level="3"
          data-inherited={dInherited || undefined}
          data-clickable={(!dInherited && canManage) || undefined}
          {...(!dInherited && canManage ? activateProps(() => toggleD(device.id)) : {})}
        >
          <span {...stopRowClick}>
            <TreeCheckbox
              state={dState}
              onChange={() => !dInherited && canManage && toggleD(device.id)}
              disabled={!canManage || dInherited}
              label={name}
              inheritedFrom={inheritedFrom}
            />
          </span>
          <DeviceStatusDot device={device} />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{name}</span>
        </div>
      </li>
    );
  };

  return (
    <div className="th-onb-card th-onb-enter">
      <CardHead
        icon={Building2}
        tone={TONE.online}
        title="Device access"
        subtitle="A client grants all its devices, a group all of its devices, a device only itself; access is the union"
        aside={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={expandAll}>
              Expand all
            </Button>
            <Button size="sm" variant="secondary" onClick={collapseAll}>
              Collapse all
            </Button>
          </div>
        }
      />

      <div className="th-alerts-toolbar">
        <div ref={filterTabsRef} role="tablist" aria-label="Client access" className="th-tabs">
          {ACCESS_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              onClick={() => {
                setFilter(id);
                setPage(1);
              }}
              className="th-tab"
            >
              {label}
              <span className="th-tab-count">{formatCount(accessCounts[id])}</span>
            </button>
          ))}
        </div>
        <div className="pb-2">
          <label className="th-search th-search-sm w-[260px]">
            <Search className="h-3.5 w-3.5 flex-none" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search clients, groups, devices"
              aria-label="Search access"
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setPage(1);
                }}
                className="th-explorer-clear"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </label>
        </div>
      </div>

      <div className="th-team-summary">
        {[
          {
            key: "clients",
            icon: Building2,
            label: selClients.size === 1 ? "client" : "clients",
            value: selClients.size,
          },
          { key: "groups", icon: Layers, label: selGroups.size === 1 ? "group" : "groups", value: selGroups.size },
          {
            key: "devices",
            icon: Monitor,
            label: selDevices.size === 1 ? "device one by one" : "devices one by one",
            value: selDevices.size,
          },
        ].map((item) => (
          <span
            key={item.key}
            className="th-status-chip"
            style={item.value ? undefined : { color: "var(--th-text-faint)" }}
          >
            <item.icon className="h-3.5 w-3.5" />
            <span className="tabular-nums" style={{ color: item.value ? "var(--th-text-primary)" : undefined }}>
              {formatCount(item.value)}
            </span>{" "}
            {item.label}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1.5 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
          <span className="th-team-inherited !h-4 !w-4" aria-hidden="true">
            <Check className="h-2.5 w-2.5" />
          </span>
          Inherited from a client or group
        </span>
      </div>

      {listedClients.length === 0 ? (
        <EmptyState
          className="py-10"
          icon={<Building2 className="h-5 w-5" />}
          title={filter === "granted" && !normalizedSearch ? "No client has access yet" : "No clients match"}
        />
      ) : (
        <ul className="th-team-tree">
          {pagedClients.map((client) => {
            const clientGroups = groupsFor(client.id);
            const isExC = exClients.has(client.id);
            const cState = clientCheckState(client.id);
            const devCount = clientDeviceCount(client.id);
            const ung = ungroupedDevicesFor(client.id);
            const expandable = clientGroups.length > 0 || ung.length > 0;
            return (
              <li key={client.id}>
                <div
                  className="th-team-node"
                  data-level="1"
                  data-clickable="true"
                  data-checked={cState === "checked" || undefined}
                  {...activateProps(() => toggleExC(client.id))}
                  aria-expanded={expandable ? isExC : undefined}
                >
                  <span {...stopRowClick}>
                    <TreeCheckbox
                      state={cState}
                      onChange={() => canManage && toggleC(client.id)}
                      disabled={!canManage}
                      label={client.name}
                    />
                  </span>
                  <Building2 className="h-4 w-4 flex-none" style={{ color: "var(--th-text-muted)" }} />
                  <span
                    className="min-w-0 flex-1 truncate text-[13px] font-medium"
                    style={{ color: "var(--th-text-primary)" }}
                  >
                    {client.name}
                  </span>
                  <span className="th-team-count">
                    {formatCount(devCount)} device{devCount === 1 ? "" : "s"}
                  </span>
                  {expandable ? (
                    <ChevronRight
                      className="th-onb-chevron h-4 w-4"
                      data-open={isExC || undefined}
                      style={{ color: "var(--th-text-faint)" }}
                    />
                  ) : (
                    <span className="w-4" />
                  )}
                </div>

                {isExC && expandable && (
                  <ul className="th-onb-reveal">
                    {clientGroups.map((group) => {
                      const groupDevices = devicesFor(group.id);
                      const isExG = exGroups.has(group.id);
                      const gState = groupCheckState(group);
                      const inherited = gState === "inherited";
                      return (
                        <li key={group.id}>
                          <div
                            className="th-team-node"
                            data-level="2"
                            data-inherited={inherited || undefined}
                            data-clickable={groupDevices.length > 0 || undefined}
                            {...(groupDevices.length > 0 ? activateProps(() => toggleExG(group.id)) : {})}
                            aria-expanded={groupDevices.length > 0 ? isExG : undefined}
                          >
                            <span {...stopRowClick}>
                              <TreeCheckbox
                                state={gState}
                                onChange={() => canManage && !inherited && toggleG(group.id)}
                                disabled={!canManage || inherited}
                                label={`${client.name} / ${group.name}`}
                                inheritedFrom="Inherited from client access"
                              />
                            </span>
                            <Layers className="h-3.5 w-3.5 flex-none" style={{ color: "var(--th-text-faint)" }} />
                            <span className="min-w-0 flex-1 truncate text-[13px]">{group.name}</span>
                            <span className="th-team-count">{formatCount(groupDevices.length)}</span>
                            {groupDevices.length > 0 ? (
                              <ChevronRight
                                className="th-onb-chevron h-4 w-4"
                                data-open={isExG || undefined}
                                style={{ color: "var(--th-text-faint)" }}
                              />
                            ) : (
                              <span className="w-4" />
                            )}
                          </div>
                          {isExG && groupDevices.length > 0 && (
                            <ul className="th-onb-reveal">
                              {groupDevices.map((device) =>
                                deviceRow(
                                  device,
                                  deviceCheckState(device),
                                  selClients.has(device.client_id ?? -1)
                                    ? "Inherited from client access"
                                    : "Inherited from group access",
                                ),
                              )}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                    {ung.length > 0 && (
                      <li>
                        <div className="th-team-node" data-level="2">
                          <span className="w-4" />
                          <Monitor className="h-3.5 w-3.5 flex-none" style={{ color: "var(--th-text-faint)" }} />
                          <span
                            className="min-w-0 flex-1 truncate text-[13px] italic"
                            style={{ color: "var(--th-text-muted)" }}
                          >
                            Not in a group
                          </span>
                          <span className="th-team-count">{formatCount(ung.length)}</span>
                          <span className="w-4" />
                        </div>
                        <ul>
                          {ung.map((device) =>
                            deviceRow(
                              device,
                              selClients.has(client.id)
                                ? "inherited"
                                : selDevices.has(device.id)
                                  ? "checked"
                                  : "unchecked",
                              "Inherited from client access",
                            ),
                          )}
                        </ul>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {listedClients.length > 0 && (
        <TablePagination
          page={currentPage}
          pageSize={pageSize}
          total={listedClients.length}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          pageSizeOptions={[10, 25, 50]}
          itemLabel="clients"
        />
      )}

      <SaveFooter
        canManage={canManage}
        dirty={dirty}
        saving={loading}
        saved={saved ? "Device access saved" : null}
        error={error}
        label="Save access"
        onSave={() => void handleSave()}
      />
    </div>
  );
}

// ── Permissions ───────────────────────────────────────────────────────────── //

const PERM_TEMPLATES: { name: string; perms: string[] }[] = [
  { name: "Read Only", perms: ["view_devices", "view_notes", "view_inventory", "view_patch"] },
  { name: "Helpdesk L1", perms: ["view_devices", "remote_support_connect", "view_notes", "view_inventory"] },
  {
    name: "Helpdesk L2",
    perms: [
      "view_devices",
      "remote_support_connect",
      "restart_device",
      "restart_agent",
      "reinstall_remote_support",
      "view_notes",
      "edit_notes",
      "view_inventory",
      "view_patch",
    ],
  },
  {
    name: "Server Admin",
    perms: [
      "view_devices",
      "remote_support_connect",
      "remote_support_manage",
      "restart_device",
      "restart_agent",
      "reinstall_remote_support",
      "maintenance_mode",
      "view_notes",
      "edit_notes",
      "view_inventory",
      "view_patch",
      "deployment",
    ],
  },
  { name: "Deployment Operator", perms: ["view_devices", "deployment", "view_inventory"] },
];

const ACTION_PERM_KEYS = new Set([
  "remote_support_connect",
  "remote_support_manage",
  "restart_device",
  "restart_agent",
  "reinstall_remote_support",
  "maintenance_mode",
  "deployment",
]);

function resolvePermDeps(perms: Set<string>): { resolved: Set<string>; autoAdded: string[] } {
  const resolved = new Set(perms);
  const autoAdded: string[] = [];
  if ([...resolved].some((p) => ACTION_PERM_KEYS.has(p)) && !resolved.has("view_devices")) {
    resolved.add("view_devices");
    autoAdded.push("view_devices");
  }
  if (resolved.has("edit_notes") && !resolved.has("view_notes")) {
    resolved.add("view_notes");
    autoAdded.push("view_notes");
  }
  if (resolved.has("remote_support_manage") && !resolved.has("remote_support_connect")) {
    resolved.add("remote_support_connect");
    autoAdded.push("remote_support_connect");
  }
  return { resolved, autoAdded };
}

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
  const state = useSaveState();
  const original = useMemo(() => new Set(team.permissions), [team.permissions]);
  const dirty = !sameSet(selected, original);
  const activeTemplate =
    PERM_TEMPLATES.find((t) => sameSet(resolvePermDeps(new Set(t.perms)).resolved, selected))?.name ?? null;

  const toggle = (key: string) => {
    const n = new Set(selected);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    const { resolved, autoAdded: added } = resolvePermDeps(n);
    setSelected(resolved);
    setAutoAdded(added);
  };
  const applyTemplate = (perms: string[]) => {
    const { resolved, autoAdded: added } = resolvePermDeps(new Set(perms));
    setSelected(resolved);
    setAutoAdded(added);
  };
  const save = () =>
    void state.run(
      async () => {
        onSaved(await updateTeamPermissions(team.id, Array.from(selected)));
        setAutoAdded([]);
      },
      "Team permissions saved",
      "Failed to save permissions",
    );

  const capabilities = (
    [
      selected.has("view_devices") && "See devices in the fleet",
      selected.has("remote_support_connect") && "Open Remote Support sessions",
      selected.has("remote_support_manage") && "Manage and end remote sessions",
      (selected.has("restart_device") || selected.has("restart_agent")) && "Restart devices and agents",
      selected.has("reinstall_remote_support") && "Reinstall Remote Support",
      selected.has("maintenance_mode") && "Put devices in maintenance",
      selected.has("view_notes") && "Read device notes",
      selected.has("edit_notes") && "Create and edit notes",
      selected.has("view_inventory") && "View software inventory",
      selected.has("view_patch") && "View patch compliance",
      selected.has("deployment") && "Deploy software packages",
      (selected.has("manage_clients") || selected.has("manage_groups")) && "Manage clients and groups",
      selected.has("manage_operators") && "Manage operator accounts",
      selected.has("audit_log") && "Read the audit log",
      selected.has("system_settings") && "Change system settings",
      [...selected].some((p) => p.startsWith("vault_")) && "Work with Credential Vault entries",
    ] as (string | false)[]
  ).filter(Boolean) as string[];

  return (
    <div className="th-onb-card th-onb-enter">
      <CardHead
        icon={KeyRound}
        tone={TONE.warning}
        title="Permissions"
        subtitle={`${formatCount(selected.size)} of ${formatCount(TEAM_PERMISSION_DEFS.length)} granted to operator and read-only members`}
      />
      <div className="th-onb-body">
        <div className="th-onb-note" style={tone("var(--th-status-info)")}>
          <Info className="h-4 w-4" />
          <span>
            Enforced on the server for <strong>operator</strong> and <strong>read-only</strong> members. Owners and
            admins are not limited by team permissions.
          </span>
        </div>

        {canManage && (
          <div className="th-onb-field">
            Start from a template
            <div className="flex flex-wrap gap-2">
              {PERM_TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  className="th-team-template"
                  aria-pressed={activeTemplate === t.name}
                  onClick={() => applyTemplate(t.perms)}
                >
                  {t.name}
                </button>
              ))}
              <button
                type="button"
                className="th-team-template"
                data-tone="danger"
                onClick={() => {
                  setSelected(new Set());
                  setAutoAdded([]);
                }}
                disabled={selected.size === 0}
              >
                Clear all
              </button>
            </div>
          </div>
        )}

        {autoAdded.length > 0 && (
          <div className="th-onb-note th-onb-reveal" style={tone("var(--th-status-info)")}>
            <Info className="h-4 w-4" />
            <span>
              Added because something you picked needs them:{" "}
              {autoAdded.map((k) => TEAM_PERMISSION_DEFS.find((d) => d.key === k)?.label ?? k).join(", ")}.
            </span>
          </div>
        )}

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="grid gap-3 md:grid-cols-2">
            {PERM_CATEGORIES.map((cat) => {
              const rows = TEAM_PERMISSION_DEFS.filter((d) => d.category === cat);
              const count = rows.filter((r) => selected.has(r.key)).length;
              return (
                <section
                  key={cat}
                  className="th-team-perms"
                  style={{ "--cat-tone": CATEGORY_TONE[cat] ?? TONE.neutral } as CSSProperties}
                >
                  <header>
                    <span
                      className="th-onb-dot"
                      style={{ "--swatch": CATEGORY_TONE[cat] ?? TONE.neutral } as CSSProperties}
                    />
                    <span className="flex-1">{cat}</span>
                    <span className="tabular-nums" style={{ color: "var(--th-text-faint)" }}>
                      {count}/{rows.length}
                    </span>
                  </header>
                  <ul>
                    {rows.map((row) => (
                      <li key={row.key}>
                        <label
                          className="th-team-row !px-3 !py-2.5"
                          data-checked={selected.has(row.key) || undefined}
                          data-disabled={!canManage || undefined}
                        >
                          <input
                            type="checkbox"
                            className="th-team-check"
                            checked={selected.has(row.key)}
                            onChange={() => canManage && toggle(row.key)}
                            disabled={!canManage}
                            aria-label={row.label}
                          />
                          <span className="min-w-0 flex-1">
                            <span
                              className="flex items-center gap-1.5 text-[13px] font-medium"
                              style={{ color: "var(--th-text-primary)" }}
                            >
                              {row.label}
                              {autoAdded.includes(row.key) && (
                                <span
                                  className="th-status-chip !h-5 !px-1.5 !text-[11px]"
                                  style={{ "--chip-tone": TONE.info } as CSSProperties}
                                >
                                  auto
                                </span>
                              )}
                            </span>
                            <span className="block text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                              {row.description}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>

          <aside className="th-team-preview">
            <div className="th-onb-label">What members can do</div>
            {capabilities.length === 0 ? (
              <p className="th-onb-hint">Nothing selected: members fall back to their role's defaults.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {capabilities.map((line) => (
                  <li
                    key={line}
                    className="flex items-start gap-2 text-[13px]"
                    style={{ color: "var(--th-text-secondary)" }}
                  >
                    <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" style={{ color: TONE.online }} />
                    {line}
                  </li>
                ))}
              </ul>
            )}
            <div className="th-onb-label pt-2">Granted ({formatCount(selected.size)})</div>
            {selected.size === 0 ? (
              <p className="th-onb-hint">None.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {TEAM_PERMISSION_DEFS.filter((d) => selected.has(d.key)).map((d) => (
                  <span
                    key={d.key}
                    className="th-status-chip !h-6"
                    style={{ "--chip-tone": CATEGORY_TONE[d.category] ?? TONE.neutral } as CSSProperties}
                  >
                    <i />
                    {d.label}
                  </span>
                ))}
              </div>
            )}
          </aside>
        </div>
      </div>
      <SaveFooter
        canManage={canManage}
        dirty={dirty}
        saving={state.saving}
        saved={state.saved}
        error={state.error}
        label={`Save permissions (${selected.size})`}
        onSave={save}
      />
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────── //

const NO_OPERATORS: OperatorRecord[] = [];
const NO_ACCESS_SCOPE: { clients: Client[]; groups: DeviceGroup[]; devices: Device[] } = {
  clients: [],
  groups: [],
  devices: [],
};

async function loadAccessScope() {
  const [clients, groups, devices] = await Promise.all([getClients(), getGroups(), getDeviceDirectory()]);
  return { clients, groups, devices };
}

export default function TeamDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canManage = can("admin");

  const teamId = id ? parseInt(id, 10) : NaN;
  const [tab, setTab] = useState<Tab>("overview");
  const [openedTabs, setOpenedTabs] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(["overview"]));
  const tabsRef = useTabIndicator<HTMLDivElement>(tab);

  const {
    data: team,
    loading,
    refreshing,
    error: teamError,
    reload: loadTeam,
    setData: setTeam,
  } = useCachedQuery(isNaN(teamId) ? null : `page.team:${teamId}`, () => getTeam(teamId));
  const operatorsQuery = useCachedQuery(openedTabs.has("members") ? "page.teams.operators" : null, getOperators);
  const accessQuery = useCachedQuery(openedTabs.has("access") ? "page.teams.access-scope" : null, loadAccessScope);
  const operators = operatorsQuery.data ?? NO_OPERATORS;
  const { clients, groups, devices } = accessQuery.data ?? NO_ACCESS_SCOPE;
  const tabLoading = (tab === "members" && operatorsQuery.loading) || (tab === "access" && accessQuery.loading);
  // The tabs' edit forms take their values from `team` once, when they mount:
  // they wait for the server's answer rather than start from a cached copy.
  const panelLoading = tabLoading || refreshing;
  const error = isNaN(teamId)
    ? "Invalid team ID"
    : (teamError ??
      (operatorsQuery.data ? null : operatorsQuery.error) ??
      (accessQuery.data ? null : accessQuery.error));

  const openTab = (next: Tab) => {
    setTab(next);
    setOpenedTabs((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  };

  const retry = () => {
    void loadTeam();
    void operatorsQuery.reload();
    void accessQuery.reload();
  };

  // Reach: all non-archived devices granted through a client, a group or one by one.
  const effectiveDeviceCount = useMemo(() => {
    if (!team) return 0;
    if (devices.length === 0) return team.effective_device_count;
    const cIds = new Set(team.client_ids);
    const gIds = new Set(team.group_ids);
    const dIds = new Set(team.device_ids);
    return devices.filter(
      (d) =>
        (d.client_id != null && cIds.has(d.client_id)) ||
        (d.group_id != null && gIds.has(d.group_id)) ||
        dIds.has(d.id),
    ).length;
  }, [devices, team]);

  if (loading) {
    return (
      <section className="premium-page th-onb space-y-4" aria-busy="true">
        <div className="th-onb-card">
          <div className="th-alerts-skeleton !m-0 !h-28" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="th-onb-card">
              <div className="th-alerts-skeleton !m-0 !h-20" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (error || !team) {
    return (
      <section className="premium-page th-onb space-y-4">
        <button type="button" onClick={() => navigate("/teams")} className="th-onb-link">
          <ArrowLeft className="h-4 w-4" />
          Back to teams
        </button>
        <div className="th-onb-card">
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title="Couldn't open this team"
            description={error ?? "Team not found."}
            action={
              <Button size="sm" variant="secondary" onClick={retry}>
                <RefreshCcw className="h-3.5 w-3.5" />
                Retry
              </Button>
            }
          />
        </div>
      </section>
    );
  }

  const teamColor = team.color ?? TEAM_COLOR_PRESETS[0];
  const TABS: { key: Tab; label: string; icon: typeof Shield; count?: number }[] = [
    { key: "overview", label: "Overview", icon: Shield },
    { key: "members", label: "Members", icon: Users, count: team.operator_ids.length },
    {
      key: "access",
      label: "Device access",
      icon: Building2,
      count: team.client_ids.length + team.group_ids.length + team.device_ids.length,
    },
    { key: "permissions", label: "Permissions", icon: KeyRound, count: team.permissions.length },
  ];

  return (
    <section className="premium-page th-onb space-y-4">
      {/* ── identity ──────────────────────────────────────────────────── */}
      <div className="th-onb-card th-team-hero th-onb-enter" style={{ "--team": teamColor } as CSSProperties}>
        <div className="flex flex-wrap items-center gap-4 px-5 py-4">
          <button
            type="button"
            onClick={() => navigate("/teams")}
            className="th-onb-action"
            aria-label="Back to teams"
            title="Back to teams"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="th-team-mark" aria-hidden="true">
            {team.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <nav
              className="flex items-center gap-1 text-[12px]"
              style={{ color: "var(--th-text-muted)" }}
              aria-label="Breadcrumb"
            >
              <button type="button" className="hover:underline" onClick={() => navigate("/teams")}>
                Teams
              </button>
              <ChevronRight className="h-3 w-3" />
              <span>Team</span>
            </nav>
            <h1 className="truncate text-[22px] font-semibold leading-7" style={{ color: "var(--th-text-primary)" }}>
              {team.name}
            </h1>
            <p className="truncate text-[13px]" style={{ color: "var(--th-text-muted)" }}>
              {team.description || "No description"}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void loadTeam()}>
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* ── summary ───────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {[
          {
            label: "Members",
            value: team.operator_ids.length,
            hint: "Operators in the team",
            icon: UsersRound,
            tone: TONE.info,
          },
          {
            label: "Clients",
            value: team.client_ids.length,
            hint: "Granted whole",
            icon: Building2,
            tone: "var(--th-accent)",
          },
          {
            label: "Groups",
            value: team.group_ids.length,
            hint: "Device groups granted",
            icon: Layers,
            tone: TONE.maintenance,
          },
          {
            label: "Devices one by one",
            value: team.device_ids.length,
            hint: "Granted directly",
            icon: Monitor,
            tone: TONE.neutral,
          },
          {
            label: "Devices reached",
            value: effectiveDeviceCount,
            hint: "Through every grant",
            icon: ShieldCheck,
            tone: TONE.online,
          },
        ].map((item, index) => (
          <div
            key={item.label}
            className="th-onb-card th-onb-stat th-onb-enter"
            style={{ "--i": index + 1 } as CSSProperties}
          >
            <span className="th-onb-icon" style={{ "--onb-tone": item.tone } as CSSProperties}>
              <item.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                {item.label}
              </div>
              <div
                className="text-[24px] font-semibold leading-8 tabular-nums"
                style={{ color: "var(--th-text-primary)" }}
              >
                {formatCount(item.value)}
              </div>
              <div className="truncate text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                {item.hint}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── tabs ──────────────────────────────────────────────────────── */}
      <div className="th-onb-card th-onb-enter" style={{ "--i": 6 } as CSSProperties}>
        <div className="th-alerts-toolbar !border-b-0">
          <div ref={tabsRef} role="tablist" aria-label="Team sections" className="th-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => openTab(t.key)}
                className="th-tab"
              >
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
                {t.count !== undefined && <span className="th-tab-count">{formatCount(t.count)}</span>}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div role="tabpanel" key={tab} className="th-onb-panel">
        {panelLoading ? (
          <div className="th-onb-card" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.15 }} />
            ))}
          </div>
        ) : tab === "overview" ? (
          <OverviewTab team={team} canManage={canManage} onSaved={(u) => setTeam(u)} />
        ) : tab === "members" ? (
          <MembersTab
            team={team}
            operators={operators}
            canManage={canManage}
            onSaved={(ids) => setTeam((p) => (p ? { ...p, operator_ids: ids } : p))}
          />
        ) : tab === "access" ? (
          <AccessTab
            team={team}
            clients={clients}
            groups={groups}
            devices={devices}
            canManage={canManage}
            onSaved={(c, g, d) => setTeam((p) => (p ? { ...p, client_ids: c, group_ids: g, device_ids: d } : p))}
          />
        ) : (
          <PermissionsTab team={team} canManage={canManage} onSaved={(u) => setTeam(u)} />
        )}
      </div>
    </section>
  );
}
