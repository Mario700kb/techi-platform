import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  KeyRound, Plus, RefreshCcw, Trash2, Eye, Link2, PlayCircle, ShieldCheck, Globe, Building2,
  Server, Radio, Mail, Key, MonitorCog, Router, UserCog, FileKey, Terminal as TerminalIcon,
  Webhook, AlertTriangle, PauseCircle, PlusCircle, Users,
} from "lucide-react";

import {
  VaultAssignment, VaultCredential, VaultCredentialCreate, VaultCredentialType,
  VaultCredentialTypeDescriptor, VaultScopeType, addVaultAssignment, createVaultCredential,
  deleteVaultCredential, listVaultAssignments, listVaultCredentialTypes, listVaultCredentials,
  removeVaultAssignment, revealVaultCredential, setVaultCredentialStatus, testVaultCredential,
  updateVaultCredential,
} from "../api/vault";
import { getClients, getGroups, Client, DeviceGroup } from "../api/clients";
import { getDevice, getDevices } from "../api/devices";
import { emitConnectRefresh } from "../api/connect";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Badge, Button } from "../components/ui";
import ConfirmationModal from "../components/ConfirmationModal";
import EntitySearchSelect, { type EntityOption } from "../components/EntitySearchSelect";
import { APP_TIME_ZONE, parseUTC, tiranaInputToUtcIso, utcToTiranaInput } from "../utils/time";

const INPUT_CLS =
  "th-input rounded-lg border px-3 py-2 text-sm font-medium outline-none focus:border-techi-orange/60";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Terminal: TerminalIcon, KeyRound, MonitorCog, Router, Globe, Key, Mail, Webhook, Radio, UserCog, FileKey,
};

const CATEGORY_LABELS: Record<string, string> = {
  ssh: "SSH", windows: "Windows", network: "Network", api: "API / Integrations",
  notifications: "Notifications", snmp: "SNMP", generic: "Generic",
};

type ViewTab = "all" | "ssh" | "windows" | "network" | "api" | "notifications" | "snmp" | "unused" | "attention";

const VIEW_TABS: { id: ViewTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ssh", label: "SSH" },
  { id: "windows", label: "Windows" },
  { id: "network", label: "Network" },
  { id: "api", label: "API / Integrations" },
  { id: "notifications", label: "Notifications" },
  { id: "snmp", label: "SNMP" },
  { id: "unused", label: "Unused" },
  { id: "attention", label: "Attention" },
];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return parseUTC(iso).toLocaleString(undefined, { timeZone: APP_TIME_ZONE,
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function lifecycleBadge(status: VaultCredential["lifecycle_status"]) {
  switch (status) {
    case "disabled":
      return { label: "Disabled", color: "color-mix(in srgb, var(--th-status-offline) 90%, transparent)", bg: "color-mix(in srgb, var(--th-status-offline) 12%, transparent)", border: "color-mix(in srgb, var(--th-status-offline) 30%, transparent)" };
    case "expired":
      return { label: "Expired", color: "var(--th-status-critical)", bg: "color-mix(in srgb, var(--th-status-critical) 10%, transparent)", border: "color-mix(in srgb, var(--th-status-critical) 30%, transparent)" };
    case "expiring_soon":
      return { label: "Expiring soon", color: "var(--th-status-warning)", bg: "color-mix(in srgb, var(--th-status-warning) 10%, transparent)", border: "color-mix(in srgb, var(--th-status-warning) 30%, transparent)" };
    case "validation_failed":
      return { label: "Validation failed", color: "var(--th-status-critical)", bg: "color-mix(in srgb, var(--th-status-critical) 10%, transparent)", border: "color-mix(in srgb, var(--th-status-critical) 30%, transparent)" };
    default:
      return { label: "Active", color: "var(--th-status-online)", bg: "color-mix(in srgb, var(--th-status-online) 10%, transparent)", border: "color-mix(in srgb, var(--th-status-online) 30%, transparent)" };
  }
}

function consumerLabel(status: VaultCredential["consumer_status"]): string {
  switch (status) {
    case "assigned_to_device": return "Assigned to device";
    case "assigned_to_client": return "Assigned to client";
    case "stored_only": return "Stored only";
    default: return "No active consumer";
  }
}

interface FormState {
  name: string;
  credential_type: VaultCredentialType;
  scope_type: VaultScopeType;
  client_id: string;   // submitted only when scope_type === "client"
  group_id: string;    // submitted only when scope_type === "group"
  device_id: string;   // submitted only when scope_type === "device"
  // UI-only narrowing filter for the Group/Device pickers — NEVER submitted.
  // This is the field the original bug conflated with `client_id` itself:
  // picking a client to narrow the device list also set `client_id` in the
  // submitted payload even when scope was "device", which the backend
  // correctly rejects ("scope 'device' must not set client_id").
  scope_client_filter: string;
  // Display-only labels for the searchable pickers (never submitted) — lets
  // the selector show a human name immediately in edit mode, before any
  // search has run.
  group_label: string;
  device_label: string;
  purpose: string;
  username: string;
  secret_fields: Record<string, string>;
  metadata: Record<string, string>;
  notes: string;
  expires_at: string;
}

const EMPTY_FORM: FormState = {
  name: "", credential_type: "generic_username_password", scope_type: "global",
  client_id: "", group_id: "", device_id: "", scope_client_filter: "",
  group_label: "", device_label: "",
  purpose: "", username: "", secret_fields: {}, metadata: {}, notes: "", expires_at: "",
};

export default function CredentialVault() {
  const { can, hasPermission } = useAuth();
  const isAdmin = can("admin");
  const canView = isAdmin || hasPermission("vault_view");
  const canCreate = isAdmin || hasPermission("vault_create");
  const canEdit = isAdmin || hasPermission("vault_edit");
  const canReveal = isAdmin || hasPermission("vault_reveal");
  const canDelete = isAdmin || hasPermission("vault_delete");
  const canTest = isAdmin || hasPermission("vault_test");
  const canAssign = isAdmin || hasPermission("vault_assign");

  const [items, setItems] = useState<VaultCredential[]>([]);
  const [types, setTypes] = useState<VaultCredentialTypeDescriptor[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<ViewTab>("all");
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterScope, setFilterScope] = useState("");
  const [filterClient, setFilterClient] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<VaultCredential | null>(null);
  const [blockedDelete, setBlockedDelete] = useState<{ target: VaultCredential; message: string } | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; fields: Record<string, string> } | null>(null);
  const [assignmentsTarget, setAssignmentsTarget] = useState<VaultCredential | null>(null);
  const [assignments, setAssignments] = useState<VaultAssignment[]>([]);
  const [assignClientId, setAssignClientId] = useState("");
  const [testResults, setTestResults] = useState<Record<number, { status: string; message: string }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [credentials, typeList, clientList, groupList] = await Promise.all([
        listVaultCredentials(), listVaultCredentialTypes(), getClients(), getGroups(),
      ]);
      setItems(credentials);
      setTypes(typeList);
      setClients(clientList);
      setGroups(groupList);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load vault");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const [searchParams, setSearchParams] = useSearchParams();

  // "Add credential" from the Connect menu (Section D/E) — deep-links here
  // with ?prefill_scope=device&prefill_device_id=..&prefill_credential_type=..
  // and opens the form pre-populated instead of making the operator
  // re-select everything by hand.
  useEffect(() => {
    const scope = searchParams.get("prefill_scope");
    const deviceIdParam = searchParams.get("prefill_device_id");
    const credentialType = searchParams.get("prefill_credential_type");
    const purpose = searchParams.get("prefill_purpose");
    if (!scope && !deviceIdParam && !credentialType) return;

    (async () => {
      let deviceLabel = "";
      let clientFilter = "";
      if (scope === "device" && deviceIdParam) {
        try {
          const device = await getDevice(Number(deviceIdParam));
          deviceLabel = device.display_name || device.hostname || `Device #${device.id}`;
          clientFilter = device.client_id ? String(device.client_id) : "";
        } catch {
          // Best-effort — still open the form pre-scoped even if the
          // device lookup fails (e.g. permission edge case).
        }
      }
      setForm({
        ...EMPTY_FORM,
        scope_type: (scope as VaultScopeType) || "device",
        device_id: deviceIdParam || "",
        device_label: deviceLabel,
        scope_client_filter: clientFilter,
        credential_type: (credentialType as VaultCredentialType) || EMPTY_FORM.credential_type,
        purpose: purpose || "",
      });
      setShowForm(true);
      // Clear the prefill params so a later refresh doesn't reopen the form.
      setSearchParams({}, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const typeById = useMemo(() => Object.fromEntries(types.map((t) => [t.id, t])), [types]);
  const clientById = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c.name])), [clients]);
  const groupById = useMemo(() => Object.fromEntries(groups.map((g) => [g.id, g])), [groups]);

  // Scope + derived context cell (Client/Group/Device column). A Device- or
  // Group-scoped credential never stores its client_id/group_id on the row
  // itself (scope integrity forbids it) — the backend joins through the
  // device/group at read time and returns it as context_client_name/
  // context_group_name, which this renders as "(derived context)".
  function renderScopeTarget(c: VaultCredential) {
    if (c.scope_type === "client") {
      return c.client_id ? (clientById[c.client_id] ?? `Client #${c.client_id}`) : "—";
    }
    if (c.scope_type === "group") {
      return (
        <div className="flex flex-col">
          <span>{c.context_group_name ?? (c.group_id ? `Group #${c.group_id}` : "—")}</span>
          {c.context_client_name && (
            <span className="text-[11px] text-slate-500" title="Derived context">{c.context_client_name}</span>
          )}
        </div>
      );
    }
    if (c.scope_type === "device") {
      return (
        <div className="flex flex-col">
          <span>{c.device_hostname ?? (c.device_id ? `Device #${c.device_id}` : "—")}</span>
          {(c.context_client_name || c.context_group_name) && (
            <span className="text-[11px] text-slate-500" title="Derived context">
              {[c.context_client_name, c.context_group_name].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
      );
    }
    return "—";
  }

  const clientOptions: EntityOption[] = useMemo(
    () => clients.map((c) => ({ value: String(c.id), label: c.name })),
    [clients],
  );
  // Groups narrowed by the chosen client filter (mirrors the existing
  // Clients.tsx / Deployment.tsx pattern of scoping a group picker to a client).
  const groupOptions: EntityOption[] = useMemo(() => {
    const filterClientId = form.scope_client_filter ? Number(form.scope_client_filter) : null;
    return groups
      .filter((g) => filterClientId === null || g.client_id === filterClientId)
      .map((g) => ({ value: String(g.id), label: g.name, sublabel: clientById[g.client_id] }));
  }, [groups, form.scope_client_filter, clientById]);

  const loadDeviceOptions = useMemo(() => {
    return async (query: string): Promise<EntityOption[]> => {
      const filterClientId = form.scope_client_filter ? Number(form.scope_client_filter) : undefined;
      const res = await getDevices({ client_id: filterClientId, search: query || undefined }, 0, 20);
      return res.devices.map((d) => ({
        value: String(d.id),
        label: d.display_name || d.hostname || `Device #${d.id}`,
        sublabel: `${d.client_id ? clientById[d.client_id] ?? `Client #${d.client_id}` : "No client"}` +
          `${d.group_id ? ` · ${groupById[d.group_id]?.name ?? `Group #${d.group_id}`}` : ""}` +
          ` · ${d.platform ?? "windows"} · #${d.id}`,
      }));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.scope_client_filter, clientById, groupById]);

  const summary = useMemo(() => {
    const s = {
      total: items.length, global: 0, client: 0, group: 0, device: 0,
      ssh: 0, windows: 0, network: 0, api: 0, attention: 0,
    };
    for (const item of items) {
      if (item.scope_type === "global") s.global += 1;
      if (item.scope_type === "client") s.client += 1;
      if (item.scope_type === "group") s.group += 1;
      if (item.scope_type === "device") s.device += 1;
      const category = typeById[item.credential_type]?.category;
      if (category === "ssh") s.ssh += 1;
      if (category === "windows") s.windows += 1;
      if (category === "network") s.network += 1;
      if (category === "api") s.api += 1;
      if (item.lifecycle_status === "expiring_soon" || item.lifecycle_status === "expired" || item.lifecycle_status === "validation_failed") {
        s.attention += 1;
      }
    }
    return s;
  }, [items, typeById]);

  const filtered = useMemo(() => {
    return items.filter((item) => {
      const category = typeById[item.credential_type]?.category;
      if (view === "ssh" && category !== "ssh") return false;
      if (view === "windows" && category !== "windows") return false;
      if (view === "network" && category !== "network") return false;
      if (view === "api" && category !== "api") return false;
      if (view === "notifications" && category !== "notifications") return false;
      if (view === "snmp" && category !== "snmp") return false;
      if (view === "unused" && item.is_referenced) return false;
      if (view === "attention" && !["expiring_soon", "expired", "validation_failed"].includes(item.lifecycle_status)) return false;
      if (filterType && item.credential_type !== filterType) return false;
      if (filterScope && item.scope_type !== filterScope) return false;
      if (filterClient && String(item.client_id ?? item.context_client_id ?? "") !== filterClient) return false;
      if (filterStatus && item.lifecycle_status !== filterStatus) return false;
      if (search.trim()) {
        const needle = search.trim().toLowerCase();
        const haystack = `${item.name} ${item.username ?? ""} ${item.purpose ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [items, view, filterType, filterScope, filterClient, filterStatus, search, typeById]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  }

  function startEdit(item: VaultCredential) {
    setForm({
      name: item.name, credential_type: item.credential_type, scope_type: item.scope_type,
      client_id: item.scope_type === "client" && item.client_id ? String(item.client_id) : "",
      group_id: item.scope_type === "group" && item.group_id ? String(item.group_id) : "",
      device_id: item.scope_type === "device" && item.device_id ? String(item.device_id) : "",
      // Prefill the narrowing filter from the derived context so the
      // picker's list is scoped sensibly even though it's never submitted.
      scope_client_filter: item.context_client_id ? String(item.context_client_id) : "",
      group_label: item.context_group_name ?? "",
      device_label: item.device_hostname ?? "",
      purpose: item.purpose ?? "", username: item.username ?? "", secret_fields: {},
      metadata: item.credential_metadata ?? {}, notes: item.notes ?? "",
      expires_at: utcToTiranaInput(item.expires_at).slice(0, 10),
    });
    setEditingId(item.id);
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      // Each scope type submits EXACTLY its own target identifier — this is
      // the fix for the production bug where scope="device" also sent
      // client_id (reused from the picker's narrowing filter), which the
      // backend correctly rejects ("scope 'device' must not set client_id").
      const payload: VaultCredentialCreate = {
        name: form.name.trim(),
        credential_type: form.credential_type,
        scope_type: form.scope_type,
        client_id: form.scope_type === "client" ? Number(form.client_id) || null : null,
        group_id: form.scope_type === "group" ? Number(form.group_id) || null : null,
        device_id: form.scope_type === "device" ? Number(form.device_id) || null : null,
        purpose: form.purpose.trim() || null,
        username: form.username.trim() || null,
        secret_fields: form.secret_fields,
        metadata: form.metadata,
        notes: form.notes.trim() || null,
        expires_at: form.expires_at ? tiranaInputToUtcIso(form.expires_at) : null,
      };
      if (editingId) {
        const updated = await updateVaultCredential(editingId, payload);
        setItems((current) => current.map((i) => (i.id === updated.id ? updated : i)));
      } else {
        const created = await createVaultCredential(payload);
        setItems((current) => [...current, created]);
      }
      // Connect readiness may have changed (a Winbox/WebFig/SSH method can
      // now resolve this credential) — refresh every mounted Connect
      // surface immediately, no manual page refresh.
      emitConnectRefresh();
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save credential");
    } finally {
      setSaving(false);
    }
  }

  async function handleReveal(cred: VaultCredential) {
    const reason = window.prompt(`Reason for revealing "${cred.name}" (required, written to audit):`);
    if (!reason || reason.trim().length < 5) return;
    try {
      const res = await revealVaultCredential(cred.id, reason.trim());
      setRevealed({ name: res.name, fields: res.secret_fields });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reveal failed");
    }
  }

  async function handleToggleStatus(cred: VaultCredential) {
    try {
      const updated = await setVaultCredentialStatus(cred.id, cred.status === "active" ? "disabled" : "active");
      setItems((current) => current.map((i) => (i.id === updated.id ? updated : i)));
      emitConnectRefresh(); // resolution is ACTIVE-only, so status flips change readiness

    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update status");
    }
  }

  async function handleTest(cred: VaultCredential) {
    try {
      const result = await testVaultCredential(cred.id);
      setTestResults((current) => ({ ...current, [cred.id]: result }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Test failed");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    try {
      await deleteVaultCredential(target.id);
      setItems((current) => current.filter((i) => i.id !== target.id));
      setDeleteTarget(null);
      emitConnectRefresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setDeleteTarget(null);
        setBlockedDelete({ target, message: e.message });
        return;
      }
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function handleForceDelete() {
    if (!blockedDelete) return;
    try {
      await deleteVaultCredential(blockedDelete.target.id, true);
      setItems((current) => current.filter((i) => i.id !== blockedDelete.target.id));
      setBlockedDelete(null);
      emitConnectRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function openAssignments(cred: VaultCredential) {
    setAssignmentsTarget(cred);
    setAssignClientId("");
    try {
      setAssignments(await listVaultAssignments(cred.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load assignments");
    }
  }

  async function handleAddAssignment() {
    if (!assignmentsTarget || !assignClientId) return;
    try {
      const created = await addVaultAssignment(assignmentsTarget.id, { client_id: Number(assignClientId) });
      setAssignments((current) => [created, ...current]);
      setAssignClientId("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add assignment");
    }
  }

  async function handleRemoveAssignment(assignmentId: number) {
    if (!assignmentsTarget) return;
    try {
      await removeVaultAssignment(assignmentsTarget.id, assignmentId);
      setAssignments((current) => current.filter((a) => a.id !== assignmentId));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove assignment");
    }
  }

  const selectedType = typeById[form.credential_type];

  if (!canView) {
    return (
      <section className="premium-page">
        <div className="premium-card p-6 text-sm" style={{ color: "var(--th-text-secondary)" }}>
          You do not have permission to view the Credential Vault.
        </div>
      </section>
    );
  }

  return (
    <section className="premium-page space-y-4">
      <div className="premium-card overflow-hidden p-4 md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-orange-400/70" />
              <p className="premium-kicker">Enterprise Credential Vault</p>
              <Badge variant="ghost">Encrypted</Badge>
            </div>
            <h1 className="mt-1.5 text-2xl font-semibold text-white">
              Credential <span className="premium-accent-text">Vault</span>
            </h1>
            <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-300">
              Secrets are stored with AES-256-GCM envelope encryption. Using a
              credential never exposes it; Reveal requires a reason and is audited.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void load()}>
              <RefreshCcw className="h-4 w-4" />
              Refresh
            </Button>
            {canCreate && (
              <Button onClick={() => { resetForm(); setShowForm(true); }}>
                <Plus className="h-4 w-4" />
                New credential
              </Button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-9">
        {[
          { label: "Total", value: summary.total, icon: KeyRound },
          { label: "Global", value: summary.global, icon: Globe },
          { label: "Client scoped", value: summary.client, icon: Building2 },
          { label: "Group scoped", value: summary.group, icon: Users },
          { label: "Device scoped", value: summary.device, icon: Server },
          { label: "SSH", value: summary.ssh, icon: TerminalIcon },
          { label: "Windows", value: summary.windows, icon: MonitorCog },
          { label: "Network", value: summary.network, icon: Router },
          { label: "API / Integration", value: summary.api, icon: Key },
          { label: "Attention", value: summary.attention, icon: AlertTriangle },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="premium-card flex flex-col gap-1 p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              <Icon className="h-3 w-3" /> {label}
            </div>
            <p className="text-xl font-bold text-white">{value}</p>
          </div>
        ))}
      </div>

      {/* View tabs */}
      <div className="flex flex-wrap gap-1.5">
        {VIEW_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setView(tab.id)}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
              view === tab.id ? "border-techi-orange/50 bg-techi-orange/15 text-techi-orange" : "border-white/10 text-slate-400 hover:bg-white/5"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="premium-card grid gap-2 p-3 sm:grid-cols-2 md:grid-cols-5">
        <input className={INPUT_CLS} placeholder="Search name/username/purpose" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className={INPUT_CLS} value={filterType} onChange={(e) => setFilterType(e.target.value)}>
          <option value="">All types</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <select className={INPUT_CLS} value={filterScope} onChange={(e) => setFilterScope(e.target.value)}>
          <option value="">All scopes</option>
          <option value="global">Global</option>
          <option value="client">Client</option>
          <option value="group">Group</option>
          <option value="device">Device</option>
        </select>
        <select className={INPUT_CLS} value={filterClient} onChange={(e) => setFilterClient(e.target.value)}>
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className={INPUT_CLS} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
          <option value="expiring_soon">Expiring soon</option>
          <option value="expired">Expired</option>
          <option value="validation_failed">Validation failed</option>
        </select>
      </div>

      {/* Create / edit form */}
      {showForm && canCreate && (
        <div className="premium-card p-4">
          <p className="premium-kicker mb-3">{editingId ? "Edit credential" : "New credential"}</p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <input className={INPUT_CLS} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <select
              className={INPUT_CLS} value={form.credential_type} disabled={!!editingId}
              onChange={(e) => setForm({ ...form, credential_type: e.target.value as VaultCredentialType, secret_fields: {}, metadata: {} })}
            >
              {types.filter((t) => !t.legacy).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <select
              aria-label="Scope"
              className={INPUT_CLS} value={form.scope_type} disabled={!!editingId}
              onChange={(e) => setForm({
                ...form, scope_type: e.target.value as VaultScopeType,
                // Selecting a new scope clears every other scope's fields —
                // this is what the production bug was missing for the
                // client_id/device_id combination, generalized to all four.
                client_id: "", group_id: "", device_id: "", scope_client_filter: "",
                group_label: "", device_label: "",
              })}
            >
              <option value="global">Global</option>
              <option value="client">Client</option>
              <option value="group">Group</option>
              <option value="device">Device</option>
            </select>
            <input className={INPUT_CLS} placeholder="Purpose (e.g. embedded_terminal)" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} />

            {form.scope_type === "client" && (
              <EntitySearchSelect
                value={form.client_id} disabled={!!editingId} placeholder="Select client"
                options={clientOptions}
                onChange={(v) => setForm({ ...form, client_id: v })}
              />
            )}

            {form.scope_type === "group" && (
              <>
                <EntitySearchSelect
                  value={form.scope_client_filter} disabled={!!editingId} placeholder="Filter by client (optional)"
                  options={clientOptions}
                  onChange={(v) => setForm({ ...form, scope_client_filter: v, group_id: "", group_label: "" })}
                />
                <EntitySearchSelect
                  value={form.group_id} disabled={!!editingId} placeholder="Select group"
                  options={groupOptions} selectedLabel={form.group_label}
                  onChange={(v, label) => setForm({ ...form, group_id: v, group_label: label ?? form.group_label })}
                />
              </>
            )}

            {form.scope_type === "device" && (
              <>
                <EntitySearchSelect
                  value={form.scope_client_filter} disabled={!!editingId} placeholder="Filter by client (optional)"
                  options={clientOptions}
                  onChange={(v) => setForm({ ...form, scope_client_filter: v, device_id: "", device_label: "" })}
                />
                <EntitySearchSelect
                  value={form.device_id} disabled={!!editingId} placeholder="Search device by hostname…"
                  loadOptions={loadDeviceOptions} selectedLabel={form.device_label}
                  onChange={(v, label) => setForm({ ...form, device_id: v, device_label: label ?? form.device_label })}
                />
              </>
            )}
            {selectedType?.requires_username && (
              <input className={INPUT_CLS} placeholder="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            )}
            <input className={INPUT_CLS} type="date" placeholder="Expires at" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />

            {/* Type-specific non-secret metadata fields */}
            {selectedType?.metadata_fields.map((f) => (
              <FieldInput
                key={f.key} spec={f} value={form.metadata[f.key] ?? f.default ?? ""}
                onChange={(value) => setForm({ ...form, metadata: { ...form.metadata, [f.key]: value } })}
              />
            ))}
            {/* Type-specific secret fields */}
            {selectedType?.secret_fields.map((f) => (
              <FieldInput
                key={f.key} spec={f} value={form.secret_fields[f.key] ?? ""}
                placeholder={editingId ? "Leave blank to keep current secret" : undefined}
                onChange={(value) => setForm({ ...form, secret_fields: { ...form.secret_fields, [f.key]: value } })}
              />
            ))}
            <input className={`${INPUT_CLS} md:col-span-2 xl:col-span-4`} placeholder="Notes (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void handleSave()} disabled={saving || !form.name.trim()}>
              <Plus className="h-4 w-4" />
              {saving ? "Saving…" : editingId ? "Save changes" : "Add credential"}
            </Button>
            <Button variant="secondary" onClick={resetForm}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Main table */}
      <div className="premium-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/5 text-[10px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Purpose</th>
                <th className="px-4 py-3">Scope</th>
                <th className="px-4 py-3">Client / Device</th>
                <th className="px-4 py-3">Identity</th>
                <th className="px-4 py-3">References</th>
                <th className="px-4 py-3">Last used</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-500">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-500">No credentials match the current filters.</td></tr>
              ) : (
                filtered.map((c) => {
                  const badge = lifecycleBadge(c.lifecycle_status);
                  const Icon = ICONS[typeById[c.credential_type]?.icon ?? ""] ?? KeyRound;
                  const testResult = testResults[c.id];
                  return (
                    <tr key={c.id} className="border-b border-white/5 align-top">
                      <td className="px-4 py-3 font-semibold text-white">
                        <div className="flex items-center gap-2">
                          <Icon className="h-3.5 w-3.5 text-orange-300/70" />
                          {c.name}
                        </div>
                        <p className="mt-0.5 text-[11px] font-normal text-slate-500" title={consumerLabel(c.consumer_status)}>
                          {consumerLabel(c.consumer_status)}
                        </p>
                        {c.used_by && c.used_by.length > 0 && (
                          <p className="mt-0.5 text-[11px] font-normal text-emerald-400/80" title="Actually authenticated a live connection">
                            Used by: {c.used_by.join(", ")}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3"><Badge variant="ghost">{typeById[c.credential_type]?.label ?? c.credential_type}</Badge></td>
                      <td className="px-4 py-3 text-slate-300">{c.purpose || "—"}</td>
                      <td className="px-4 py-3 text-slate-300 capitalize">{c.scope_type}</td>
                      <td className="px-4 py-3 text-slate-400">{renderScopeTarget(c)}</td>
                      <td className="px-4 py-3 font-mono text-slate-400">{c.username || "—"}</td>
                      <td className="px-4 py-3">
                        <button type="button" onClick={() => void openAssignments(c)} className="inline-flex items-center gap-1 text-xs font-semibold text-slate-300 hover:text-techi-orange">
                          <Link2 className="h-3 w-3" /> {c.reference_count}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-slate-400">{formatDate(c.last_used_at)}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold" style={{ color: badge.color, background: badge.bg, borderColor: badge.border }}>
                          {badge.label}
                        </span>
                        {testResult && (
                          <p className={`mt-1 text-[10px] ${testResult.status === "success" ? "text-emerald-400" : testResult.status === "failed" ? "text-red-400" : "text-slate-500"}`}>
                            {testResult.message}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {canReveal && (
                            <button type="button" onClick={() => void handleReveal(c)} title="Reveal" className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.06]">
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {canTest && (
                            <button type="button" onClick={() => void handleTest(c)} title="Test connection" className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.06]">
                              <PlayCircle className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {canEdit && (
                            <button type="button" onClick={() => startEdit(c)} title="Edit" className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.06]">
                              <ShieldCheck className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {canEdit && (
                            <button type="button" onClick={() => void handleToggleStatus(c)} title={c.status === "active" ? "Disable" : "Enable"} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.06]">
                              <PauseCircle className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {canAssign && (
                            <button type="button" onClick={() => void openAssignments(c)} title="Assignments" className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.06]">
                              <PlusCircle className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {canDelete && (
                            <button type="button" onClick={() => setDeleteTarget(c)} title="Delete" className="inline-flex items-center gap-1 rounded-md border border-red-400/30 px-2 py-1 text-xs font-semibold text-red-200 transition hover:bg-red-400/10">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {revealed && (
        <ConfirmationModal title={`Secret — ${revealed.name}`} confirmLabel="Close" destructive={false} onConfirm={() => setRevealed(null)} onClose={() => setRevealed(null)}>
          <div className="space-y-2">
            {Object.entries(revealed.fields).map(([key, value]) => (
              <div key={key}>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{key}</p>
                <p className="break-all font-mono text-sm" style={{ color: "var(--th-text-primary)" }}>{value}</p>
              </div>
            ))}
          </div>
        </ConfirmationModal>
      )}

      {deleteTarget && (
        <ConfirmationModal title="Delete credential" confirmLabel="Delete" onConfirm={() => void handleDelete()} onClose={() => setDeleteTarget(null)}>
          <p className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
            Permanently delete <strong>{deleteTarget.name}</strong>? This cannot be undone.
          </p>
        </ConfirmationModal>
      )}

      {blockedDelete && (
        <ConfirmationModal title="Credential still in use" confirmLabel="Delete anyway" onConfirm={() => void handleForceDelete()} onClose={() => setBlockedDelete(null)}>
          <p className="text-sm" style={{ color: "var(--th-text-secondary)" }}>{blockedDelete.message}</p>
        </ConfirmationModal>
      )}

      {assignmentsTarget && (
        <ConfirmationModal title={`Assignments — ${assignmentsTarget.name}`} confirmLabel="Close" destructive={false} onConfirm={() => setAssignmentsTarget(null)} onClose={() => setAssignmentsTarget(null)}>
          <div className="space-y-3">
            {assignments.length === 0 ? (
              <p className="text-sm text-slate-500">Not explicitly assigned to any client or device.</p>
            ) : (
              <ul className="space-y-1.5">
                {assignments.map((a) => (
                  <li key={a.id} className="flex items-center justify-between rounded-md border border-white/10 px-2.5 py-1.5 text-xs">
                    <span>{a.client_name ? `Client: ${a.client_name}` : a.device_name ? `Device: ${a.device_name}` : `#${a.id}`}</span>
                    {canAssign && (
                      <button type="button" onClick={() => void handleRemoveAssignment(a.id)} className="text-red-300 hover:text-red-200">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canAssign && (
              <div className="flex gap-2">
                <select className={`${INPUT_CLS} flex-1`} value={assignClientId} onChange={(e) => setAssignClientId(e.target.value)}>
                  <option value="">Select client to assign</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <Button onClick={() => void handleAddAssignment()} disabled={!assignClientId}>Add</Button>
              </div>
            )}
          </div>
        </ConfirmationModal>
      )}
    </section>
  );
}

function FieldInput({
  spec, value, onChange, placeholder,
}: {
  spec: { key: string; label: string; required: boolean; kind: string; options: string[] | null; default: string | null };
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  if (spec.kind === "select" && spec.options) {
    return (
      <select className={INPUT_CLS} value={value} onChange={(e) => onChange(e.target.value)}>
        {spec.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (spec.kind === "textarea") {
    return (
      <textarea
        className={`${INPUT_CLS} min-h-[80px] md:col-span-2`} placeholder={placeholder ?? `${spec.label}${spec.required ? " *" : ""}`}
        value={value} onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      className={INPUT_CLS} type={spec.kind === "password" ? "password" : spec.kind === "number" ? "number" : "text"}
      placeholder={placeholder ?? `${spec.label}${spec.required ? " *" : ""}`}
      value={value} onChange={(e) => onChange(e.target.value)}
    />
  );
}
