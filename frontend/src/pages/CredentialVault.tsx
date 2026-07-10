import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KeyRound, Plus, RefreshCcw, Trash2, Eye, Link2, PlayCircle, ShieldCheck, Globe, Building2,
  Server, Radio, Mail, Key, MonitorCog, Router, UserCog, FileKey, Terminal as TerminalIcon,
  Webhook, AlertTriangle, PauseCircle, PlusCircle,
} from "lucide-react";

import {
  VaultAssignment, VaultCredential, VaultCredentialCreate, VaultCredentialType,
  VaultCredentialTypeDescriptor, VaultScopeType, addVaultAssignment, createVaultCredential,
  deleteVaultCredential, listVaultAssignments, listVaultCredentialTypes, listVaultCredentials,
  removeVaultAssignment, revealVaultCredential, setVaultCredentialStatus, testVaultCredential,
  updateVaultCredential,
} from "../api/vault";
import { getClients, Client } from "../api/clients";
import { getDevices, Device } from "../api/devices";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Badge, Button } from "../components/ui";
import ConfirmationModal from "../components/ConfirmationModal";
import { parseUTC } from "../utils/time";

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
  return parseUTC(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function lifecycleBadge(status: VaultCredential["lifecycle_status"]) {
  switch (status) {
    case "disabled":
      return { label: "Disabled", color: "rgba(148,163,184,.9)", bg: "rgba(148,163,184,.12)", border: "rgba(148,163,184,.3)" };
    case "expired":
      return { label: "Expired", color: "#fca5a5", bg: "rgba(239,68,68,.1)", border: "rgba(239,68,68,.3)" };
    case "expiring_soon":
      return { label: "Expiring soon", color: "#fcd34d", bg: "rgba(245,158,11,.1)", border: "rgba(245,158,11,.3)" };
    case "validation_failed":
      return { label: "Validation failed", color: "#fca5a5", bg: "rgba(239,68,68,.1)", border: "rgba(239,68,68,.3)" };
    default:
      return { label: "Active", color: "#86efac", bg: "rgba(34,197,94,.1)", border: "rgba(34,197,94,.3)" };
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
  client_id: string;
  device_id: string;
  purpose: string;
  username: string;
  secret_fields: Record<string, string>;
  metadata: Record<string, string>;
  notes: string;
  expires_at: string;
}

const EMPTY_FORM: FormState = {
  name: "", credential_type: "generic_username_password", scope_type: "global",
  client_id: "", device_id: "", purpose: "", username: "", secret_fields: {}, metadata: {}, notes: "", expires_at: "",
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
  const [devices, setDevices] = useState<Device[]>([]);
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
      const [credentials, typeList, clientList] = await Promise.all([
        listVaultCredentials(), listVaultCredentialTypes(), getClients(),
      ]);
      setItems(credentials);
      setTypes(typeList);
      setClients(clientList);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load vault");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (form.scope_type !== "device" || !form.client_id) {
      setDevices([]);
      return;
    }
    void getDevices({ client_id: Number(form.client_id) }, 0, 200).then((res) => setDevices(res.devices));
  }, [form.scope_type, form.client_id]);

  const typeById = useMemo(() => Object.fromEntries(types.map((t) => [t.id, t])), [types]);
  const clientById = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c.name])), [clients]);

  const summary = useMemo(() => {
    const s = {
      total: items.length, global: 0, client: 0, device: 0,
      ssh: 0, windows: 0, network: 0, api: 0, attention: 0,
    };
    for (const item of items) {
      if (item.scope_type === "global") s.global += 1;
      if (item.scope_type === "client") s.client += 1;
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
      if (filterClient && String(item.client_id ?? "") !== filterClient) return false;
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
      client_id: item.client_id ? String(item.client_id) : "", device_id: item.device_id ? String(item.device_id) : "",
      purpose: item.purpose ?? "", username: item.username ?? "", secret_fields: {},
      metadata: item.credential_metadata ?? {}, notes: item.notes ?? "",
      expires_at: item.expires_at ? item.expires_at.slice(0, 10) : "",
    });
    setEditingId(item.id);
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const payload: VaultCredentialCreate = {
        name: form.name.trim(),
        credential_type: form.credential_type,
        scope_type: form.scope_type,
        client_id: form.scope_type === "client" || form.scope_type === "device" ? Number(form.client_id) || null : null,
        device_id: form.scope_type === "device" ? Number(form.device_id) || null : null,
        purpose: form.purpose.trim() || null,
        username: form.username.trim() || null,
        secret_fields: form.secret_fields,
        metadata: form.metadata,
        notes: form.notes.trim() || null,
        expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
      };
      if (editingId) {
        const updated = await updateVaultCredential(editingId, payload);
        setItems((current) => current.map((i) => (i.id === updated.id ? updated : i)));
      } else {
        const created = await createVaultCredential(payload);
        setItems((current) => [...current, created]);
      }
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
            <select className={INPUT_CLS} value={form.scope_type} disabled={!!editingId} onChange={(e) => setForm({ ...form, scope_type: e.target.value as VaultScopeType, client_id: "", device_id: "" })}>
              <option value="global">Global</option>
              <option value="client">Client</option>
              <option value="device">Device</option>
            </select>
            <input className={INPUT_CLS} placeholder="Purpose (e.g. embedded_terminal)" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} />

            {(form.scope_type === "client" || form.scope_type === "device") && (
              <select className={INPUT_CLS} value={form.client_id} disabled={!!editingId} onChange={(e) => setForm({ ...form, client_id: e.target.value, device_id: "" })}>
                <option value="">Select client</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            {form.scope_type === "device" && (
              <select className={INPUT_CLS} value={form.device_id} disabled={!!editingId} onChange={(e) => setForm({ ...form, device_id: e.target.value })}>
                <option value="">Select device</option>
                {devices.map((d) => <option key={d.id} value={d.id}>{d.display_name || d.hostname}</option>)}
              </select>
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
                      </td>
                      <td className="px-4 py-3"><Badge variant="ghost">{typeById[c.credential_type]?.label ?? c.credential_type}</Badge></td>
                      <td className="px-4 py-3 text-slate-300">{c.purpose || "—"}</td>
                      <td className="px-4 py-3 text-slate-300 capitalize">{c.scope_type}</td>
                      <td className="px-4 py-3 text-slate-400">
                        {c.client_id ? (clientById[c.client_id] ?? `Client #${c.client_id}`) : c.device_id ? `Device #${c.device_id}` : "—"}
                      </td>
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
