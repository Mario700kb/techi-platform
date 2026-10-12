import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";
import {
  KeyRound,
  Plus,
  RefreshCcw,
  Trash2,
  Eye,
  Link2,
  PlayCircle,
  Globe,
  Pencil,
  Power,
  Mail,
  Key,
  MonitorCog,
  Router,
  UserCog,
  FileKey,
  Terminal as TerminalIcon,
  Radio,
  Webhook,
  AlertTriangle,
  Search,
  X,
  Copy,
  Check,
  ShieldAlert,
  ShieldCheck,
  History,
  Lock,
} from "lucide-react";

import {
  VaultAssignment,
  VaultCredential,
  VaultCredentialCreate,
  VaultCredentialType,
  VaultCredentialTypeDescriptor,
  VaultScopeType,
  addVaultAssignment,
  createVaultCredential,
  deleteVaultCredential,
  listVaultAssignments,
  listVaultCredentialTypes,
  listVaultCredentials,
  removeVaultAssignment,
  revealVaultCredential,
  setVaultCredentialStatus,
  testVaultCredential,
  updateVaultCredential,
} from "../api/vault";
import { getClients, getGroups, Client, DeviceGroup } from "../api/clients";
import { getDevice, getDevices } from "../api/devices";
import { emitConnectRefresh } from "../api/connect";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button, EmptyState, PageHeader, SelectField } from "../components/ui";
import { CardHead } from "../components/ui/PanelCard";
import Modal from "../components/ui/Modal";
import TablePagination from "../components/ui/TablePagination";
import ConfirmationModal from "../components/ConfirmationModal";
import EntitySearchSelect, { type EntityOption } from "../components/EntitySearchSelect";
import { useTabIndicator } from "../hooks/useTabIndicator";
import { TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { formatLocalDateTime, timeAgo, tiranaInputToUtcIso, utcToTiranaInput } from "../utils/time";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Terminal: TerminalIcon,
  KeyRound,
  MonitorCog,
  Router,
  Globe,
  Key,
  Mail,
  Webhook,
  Radio,
  UserCog,
  FileKey,
};

type Category = VaultCredentialTypeDescriptor["category"];

const CATEGORY_TONE: Record<Category, string> = {
  ssh: "var(--th-accent)",
  windows: TONE.info,
  network: TONE.maintenance,
  api: TONE.warning,
  notifications: TONE.info,
  snmp: TONE.maintenance,
  generic: TONE.neutral,
};

const SCOPE_LABEL: Record<VaultScopeType, string> = {
  global: "Global",
  client: "Client",
  group: "Group",
  device: "Device",
};

type ViewTab = "all" | Exclude<Category, "generic"> | "unused" | "attention";

const VIEW_TABS: { id: ViewTab; label: string; category?: boolean }[] = [
  { id: "all", label: "All" },
  { id: "ssh", label: "SSH", category: true },
  { id: "windows", label: "Windows", category: true },
  { id: "network", label: "Network", category: true },
  { id: "api", label: "API / Integrations", category: true },
  { id: "notifications", label: "Notifications", category: true },
  { id: "snmp", label: "SNMP", category: true },
  { id: "unused", label: "Unused" },
  { id: "attention", label: "Attention" },
];

const ATTENTION: VaultCredential["lifecycle_status"][] = ["expiring_soon", "expired", "validation_failed"];

const LIFECYCLE: Record<VaultCredential["lifecycle_status"], { label: string; tone: string }> = {
  active: { label: "Active", tone: TONE.online },
  disabled: { label: "Disabled", tone: TONE.neutral },
  expiring_soon: { label: "Expiring soon", tone: TONE.warning },
  expired: { label: "Expired", tone: TONE.critical },
  validation_failed: { label: "Validation failed", tone: TONE.critical },
};

const CONSUMER_LABEL: Record<VaultCredential["consumer_status"], string> = {
  assigned_to_device: "Assigned to device",
  assigned_to_client: "Assigned to client",
  stored_only: "Stored only",
  no_active_consumer: "No active consumer",
};

const DAY = { day: "numeric", month: "short", year: "numeric" } as const;

interface FormState {
  name: string;
  credential_type: VaultCredentialType;
  scope_type: VaultScopeType;
  client_id: string; // submitted only when scope_type === "client"
  group_id: string; // submitted only when scope_type === "group"
  device_id: string; // submitted only when scope_type === "device"
  // Narrows the Group/Device pickers and is never submitted: reusing it as
  // client_id is what made the backend reject device-scoped credentials
  // ("scope 'device' must not set client_id").
  scope_client_filter: string;
  // Names for the pickers in edit mode, before any search has run.
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
  name: "",
  credential_type: "generic_username_password",
  scope_type: "global",
  client_id: "",
  group_id: "",
  device_id: "",
  scope_client_filter: "",
  group_label: "",
  device_label: "",
  purpose: "",
  username: "",
  secret_fields: {},
  metadata: {},
  notes: "",
  expires_at: "",
};

function Note({ tone, children, onDismiss }: { tone: string; children: React.ReactNode; onDismiss?: () => void }) {
  return (
    <div
      className="th-onb-note th-onb-reveal"
      style={{ "--onb-tone": tone } as CSSProperties}
      role={tone === TONE.critical ? "alert" : "status"}
    >
      <AlertTriangle className="h-4 w-4" />
      <span className="flex-1">{children}</span>
      {onDismiss && (
        <button type="button" className="th-onb-action !h-5 !w-5" onClick={onDismiss} aria-label="Dismiss">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function SecretValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="th-onb-field">
      {label}
      <div className="th-onb-code flex items-start gap-2 px-3 py-2">
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all" style={{ color: "var(--th-text-primary)" }}>
          {value}
        </span>
        <button
          type="button"
          className="th-onb-action !h-6 !w-6 flex-none"
          onClick={copy}
          aria-label={`Copy ${label}`}
          title="Copy"
        >
          {copied ? <Check className="h-3.5 w-3.5" style={{ color: TONE.online }} /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const viewTabsRef = useTabIndicator<HTMLDivElement>(view);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<VaultCredential | null>(null);
  const [blockedDelete, setBlockedDelete] = useState<{ target: VaultCredential; message: string } | null>(null);
  const [revealTarget, setRevealTarget] = useState<VaultCredential | null>(null);
  const [revealReason, setRevealReason] = useState("");
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string> | null>(null);
  const [assignmentsTarget, setAssignmentsTarget] = useState<VaultCredential | null>(null);
  const [assignments, setAssignments] = useState<VaultAssignment[]>([]);
  const [assignClientId, setAssignClientId] = useState("");
  const [testing, setTesting] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, { status: string; message: string }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [credentials, typeList, clientList, groupList] = await Promise.all([
        listVaultCredentials(),
        listVaultCredentialTypes(),
        getClients(),
        getGroups(),
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

  useEffect(() => {
    void load();
  }, [load]);

  const [searchParams, setSearchParams] = useSearchParams();

  // "Add credential" in the Connect menu links here with
  // ?prefill_scope=device&prefill_device_id=..&prefill_credential_type=..
  // and the form opens already scoped to that device.
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
          // The form still opens scoped to the device; only its name is missing.
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
      setFormError(null);
      setShowForm(true);
      // A later refresh must not reopen the form.
      setSearchParams({}, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const typeById = useMemo(() => Object.fromEntries(types.map((t) => [t.id, t])), [types]);
  const clientById = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c.name])), [clients]);
  const groupById = useMemo(() => Object.fromEntries(groups.map((g) => [g.id, g])), [groups]);

  // A device- or group-scoped credential never stores client_id/group_id
  // itself; the backend joins them at read time as context_*_name.
  function scopeTarget(c: VaultCredential): { primary: string; secondary?: string } {
    if (c.scope_type === "client")
      return { primary: c.client_id ? (clientById[c.client_id] ?? `Client #${c.client_id}`) : "—" };
    if (c.scope_type === "group") {
      return {
        primary: c.context_group_name ?? (c.group_id ? `Group #${c.group_id}` : "—"),
        secondary: c.context_client_name ?? undefined,
      };
    }
    if (c.scope_type === "device") {
      const context = [c.context_client_name, c.context_group_name].filter(Boolean).join(" · ");
      return {
        primary: c.device_hostname ?? (c.device_id ? `Device #${c.device_id}` : "—"),
        secondary: context || undefined,
      };
    }
    return { primary: "Every device" };
  }

  const clientOptions: EntityOption[] = useMemo(
    () => clients.map((c) => ({ value: String(c.id), label: c.name })),
    [clients],
  );
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
        sublabel:
          `${d.client_id ? (clientById[d.client_id] ?? `Client #${d.client_id}`) : "No client"}` +
          `${d.group_id ? ` · ${groupById[d.group_id]?.name ?? `Group #${d.group_id}`}` : ""}` +
          ` · ${d.platform ?? "windows"} · #${d.id}`,
      }));
    };
  }, [form.scope_client_filter, clientById, groupById]);

  const categoryOf = useCallback(
    (item: VaultCredential): Category | undefined => typeById[item.credential_type]?.category,
    [typeById],
  );

  const matchesView = useCallback(
    (item: VaultCredential, tab: ViewTab) => {
      if (tab === "all") return true;
      if (tab === "unused") return !item.is_referenced;
      if (tab === "attention") return ATTENTION.includes(item.lifecycle_status);
      return categoryOf(item) === tab;
    },
    [categoryOf],
  );

  const summary = useMemo(() => {
    const scopes = { global: 0, client: 0, group: 0, device: 0 };
    let inUse = 0,
      expired = 0,
      expiring = 0,
      failed = 0;
    let lastUsed: VaultCredential | null = null;
    for (const item of items) {
      scopes[item.scope_type] += 1;
      if (item.is_referenced) inUse += 1;
      if (item.lifecycle_status === "expired") expired += 1;
      if (item.lifecycle_status === "expiring_soon") expiring += 1;
      if (item.lifecycle_status === "validation_failed") failed += 1;
      if (item.last_used_at && (!lastUsed || item.last_used_at > (lastUsed.last_used_at ?? ""))) lastUsed = item;
    }
    return { scopes, inUse, expired, expiring, failed, attention: expired + expiring + failed, lastUsed };
  }, [items]);

  const viewCounts = useMemo(
    () =>
      Object.fromEntries(
        VIEW_TABS.map((tab) => [tab.id, items.filter((item) => matchesView(item, tab.id)).length]),
      ) as Record<ViewTab, number>,
    [items, matchesView],
  );
  const shownTabs = VIEW_TABS.filter((tab) => !tab.category || viewCounts[tab.id] > 0 || view === tab.id);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((item) => {
      if (!matchesView(item, view)) return false;
      if (filterType && item.credential_type !== filterType) return false;
      if (filterScope && item.scope_type !== filterScope) return false;
      if (filterClient && String(item.client_id ?? item.context_client_id ?? "") !== filterClient) return false;
      if (filterStatus && item.lifecycle_status !== filterStatus) return false;
      if (needle && !`${item.name} ${item.username ?? ""} ${item.purpose ?? ""}`.toLowerCase().includes(needle))
        return false;
      return true;
    });
  }, [items, view, filterType, filterScope, filterClient, filterStatus, search, matchesView]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const paged = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const hasFilters = Boolean(
    search.trim() || filterType || filterScope || filterClient || filterStatus || view !== "all",
  );

  const clearFilters = () => {
    setView("all");
    setSearch("");
    setFilterType("");
    setFilterScope("");
    setFilterClient("");
    setFilterStatus("");
    setPage(1);
  };
  const withPageReset =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setPage(1);
    };

  function closeForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError(null);
    setShowForm(false);
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError(null);
    setShowForm(true);
  }

  function startEdit(item: VaultCredential) {
    setForm({
      name: item.name,
      credential_type: item.credential_type,
      scope_type: item.scope_type,
      client_id: item.scope_type === "client" && item.client_id ? String(item.client_id) : "",
      group_id: item.scope_type === "group" && item.group_id ? String(item.group_id) : "",
      device_id: item.scope_type === "device" && item.device_id ? String(item.device_id) : "",
      scope_client_filter: item.context_client_id ? String(item.context_client_id) : "",
      group_label: item.context_group_name ?? "",
      device_label: item.device_hostname ?? "",
      purpose: item.purpose ?? "",
      username: item.username ?? "",
      secret_fields: {},
      metadata: item.credential_metadata ?? {},
      notes: item.notes ?? "",
      expires_at: utcToTiranaInput(item.expires_at).slice(0, 10),
    });
    setEditingId(item.id);
    setFormError(null);
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      // Each scope submits exactly its own target id and nothing else.
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
      // A Winbox, WebFig or SSH method may resolve this credential now.
      emitConnectRefresh();
      closeForm();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to save credential");
    } finally {
      setSaving(false);
    }
  }

  function openReveal(cred: VaultCredential) {
    setRevealTarget(cred);
    setRevealReason("");
    setRevealError(null);
    setRevealed(null);
  }

  function closeReveal() {
    setRevealTarget(null);
    setRevealed(null);
    setRevealReason("");
  }

  async function handleReveal() {
    if (!revealTarget || revealReason.trim().length < 5) return;
    setRevealing(true);
    setRevealError(null);
    try {
      const res = await revealVaultCredential(revealTarget.id, revealReason.trim());
      setRevealed(res.secret_fields);
    } catch (e) {
      setRevealError(e instanceof Error ? e.message : "Reveal failed");
    } finally {
      setRevealing(false);
    }
  }

  async function handleToggleStatus(cred: VaultCredential) {
    try {
      const updated = await setVaultCredentialStatus(cred.id, cred.status === "active" ? "disabled" : "active");
      setItems((current) => current.map((i) => (i.id === updated.id ? updated : i)));
      emitConnectRefresh(); // only active credentials resolve, so readiness changes
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update status");
    }
  }

  async function handleTest(cred: VaultCredential) {
    setTesting(cred.id);
    try {
      const result = await testVaultCredential(cred.id);
      setTestResults((current) => ({ ...current, [cred.id]: result }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Test failed");
    } finally {
      setTesting(null);
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
    setAssignments([]);
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
      <section className="premium-page th-onb space-y-4">
        <PageHeader title="Credential Vault" description="Encrypted credentials for Connect, SSH and integrations." />
        <div className="th-onb-card th-onb-enter">
          <EmptyState
            icon={<ShieldAlert className="h-5 w-5" />}
            title="Access denied"
            description="You do not have permission to view the Credential Vault."
          />
        </div>
      </section>
    );
  }

  const lastUsed = summary.lastUsed;
  const stats = [
    {
      label: "Credentials",
      value: formatCount(items.length),
      icon: KeyRound,
      tone: "var(--th-accent)",
      hint: `${summary.scopes.global} global · ${summary.scopes.client} client · ${summary.scopes.group} group · ${summary.scopes.device} device`,
    },
    {
      label: "In use",
      value: formatCount(summary.inUse),
      icon: Link2,
      tone: TONE.online,
      hint:
        items.length - summary.inUse
          ? `${formatCount(items.length - summary.inUse)} not referenced anywhere`
          : "Every credential is referenced",
    },
    {
      label: "Needs attention",
      value: formatCount(summary.attention),
      icon: AlertTriangle,
      tone: summary.attention ? TONE.critical : TONE.neutral,
      hint: summary.attention
        ? [
            summary.expired && `${summary.expired} expired`,
            summary.expiring && `${summary.expiring} expiring soon`,
            summary.failed && `${summary.failed} failed validation`,
          ]
            .filter(Boolean)
            .join(" · ")
        : "Nothing expired or failing",
    },
    {
      label: "Last used",
      value: lastUsed ? timeAgo(lastUsed.last_used_at) : "Never",
      icon: History,
      tone: lastUsed ? TONE.info : TONE.neutral,
      hint: lastUsed ? lastUsed.name : "No credential has been used yet",
    },
  ];

  return (
    <section className="premium-page th-onb space-y-4">
      <PageHeader
        title="Credential Vault"
        description="AES-256-GCM envelope encryption. Using a credential never exposes it; revealing one needs a reason and is audited."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {canCreate && (
              <Button size="sm" onClick={openCreate}>
                <Plus className="h-3.5 w-3.5" />
                New credential
              </Button>
            )}
          </>
        }
      />

      {error && (
        <Note tone={TONE.critical} onDismiss={() => setError(null)}>
          {error}
        </Note>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((item, index) => (
          <div
            key={item.label}
            className="th-onb-card th-onb-stat th-onb-enter"
            style={{ "--i": index } as CSSProperties}
          >
            <span className="th-onb-icon" style={{ "--onb-tone": item.tone } as CSSProperties}>
              <item.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                {item.label}
              </div>
              <div
                className="truncate text-[24px] font-semibold leading-8 tabular-nums"
                style={{ color: "var(--th-text-primary)" }}
              >
                {item.value}
              </div>
              <div className="truncate text-[12px]" style={{ color: "var(--th-text-faint)" }} title={item.hint}>
                {item.hint}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="th-alerts-card th-onb-tokens th-onb-enter" style={{ "--i": 4 } as CSSProperties}>
        <CardHead
          icon={Lock}
          tone="var(--th-accent)"
          title="Credentials"
          subtitle={
            loading && items.length === 0
              ? "Loading…"
              : `${formatCount(items.length)} stored · ${formatCount(filtered.length)} shown`
          }
        />
        <div className="th-alerts-toolbar">
          <div ref={viewTabsRef} role="tablist" aria-label="Credential view" className="th-tabs">
            {shownTabs.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                onClick={() => {
                  setView(id);
                  setPage(1);
                }}
                className="th-tab"
              >
                {id === "attention" && viewCounts.attention > 0 && (
                  <span className="th-tab-dot" style={{ "--tab-tone": TONE.critical } as CSSProperties} />
                )}
                {label}
                <span className="th-tab-count">{formatCount(viewCounts[id])}</span>
              </button>
            ))}
          </div>
          <div className="pb-2">
            <label className="th-search th-search-sm w-[280px]">
              <Search className="h-3.5 w-3.5 flex-none" />
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search name or username"
                aria-label="Search credentials"
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

        <div className="th-vault-filters">
          <SelectField
            aria-label="Type"
            value={filterType}
            onChange={(e) => withPageReset(setFilterType)(e.target.value)}
          >
            <option value="">All types</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            aria-label="Scope filter"
            value={filterScope}
            onChange={(e) => withPageReset(setFilterScope)(e.target.value)}
          >
            <option value="">All scopes</option>
            <option value="global">Global</option>
            <option value="client">Client</option>
            <option value="group">Group</option>
            <option value="device">Device</option>
          </SelectField>
          <SelectField
            aria-label="Client"
            value={filterClient}
            onChange={(e) => withPageReset(setFilterClient)(e.target.value)}
          >
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            aria-label="Status"
            value={filterStatus}
            onChange={(e) => withPageReset(setFilterStatus)(e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
            <option value="expiring_soon">Expiring soon</option>
            <option value="expired">Expired</option>
            <option value="validation_failed">Validation failed</option>
          </SelectField>
        </div>

        {loading && items.length === 0 ? (
          <div className="th-alerts-scroll" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.15 }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            className="th-fade-in py-10"
            icon={<KeyRound className="h-5 w-5" />}
            title={items.length === 0 ? "The vault is empty" : "No credentials match these filters"}
            description={
              items.length === 0
                ? "Stored credentials let Connect, SSH and integrations sign in without anyone seeing the secret."
                : undefined
            }
            action={
              hasFilters && items.length > 0 ? (
                <Button size="sm" variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="th-alerts-scroll th-table-scroll">
            <table className="th-alerts-table">
              <colgroup>
                <col />
                <col className="w-[200px]" />
                <col className="w-[20%]" />
                <col className="w-[150px]" />
                <col className="w-[96px]" />
                <col className="w-[140px]" />
                <col className="w-[150px]" />
                <col className="w-[224px]" />
              </colgroup>
              <thead>
                <tr>
                  <th>Credential</th>
                  <th>Type</th>
                  <th>Scope</th>
                  <th>Identity</th>
                  <th>References</th>
                  <th>Last used</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((c, index) => {
                  const descriptor = typeById[c.credential_type];
                  const Icon = ICONS[descriptor?.icon ?? ""] ?? KeyRound;
                  const tone = CATEGORY_TONE[descriptor?.category ?? "generic"];
                  const lifecycle = LIFECYCLE[c.lifecycle_status];
                  const target = scopeTarget(c);
                  const testResult = testResults[c.id];
                  const needsAttention = ATTENTION.includes(c.lifecycle_status);
                  return (
                    <tr
                      key={c.id}
                      className="th-alerts-row"
                      style={
                        { "--row": index, "--row-tone": needsAttention ? lifecycle.tone : undefined } as CSSProperties
                      }
                    >
                      <td>
                        <span className="flex min-w-0 items-center gap-2.5">
                          <span
                            className="th-onb-icon !h-8 !w-8 flex-none"
                            style={{ "--onb-tone": tone } as CSSProperties}
                          >
                            <Icon className="h-4 w-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="th-alerts-primary truncate">{c.name}</span>
                            {c.used_by && c.used_by.length > 0 ? (
                              <span
                                className="th-alerts-secondary truncate"
                                style={{ color: TONE.online }}
                                title="Authenticated a live connection"
                              >
                                Used by: {c.used_by.join(", ")}
                              </span>
                            ) : (
                              <span className="th-alerts-secondary truncate">
                                {CONSUMER_LABEL[c.consumer_status] ?? CONSUMER_LABEL.no_active_consumer}
                              </span>
                            )}
                          </span>
                        </span>
                      </td>
                      <td>
                        <span
                          className="th-status-chip max-w-full"
                          style={{ "--chip-tone": tone } as CSSProperties}
                          title={descriptor?.label ?? c.credential_type}
                        >
                          <span className="truncate">{descriptor?.label ?? c.credential_type}</span>
                        </span>
                      </td>
                      <td>
                        <span className="th-alerts-primary flex min-w-0 items-center gap-1.5">
                          <span className="th-status-chip !h-5 flex-none !px-1.5 !text-[11px]">
                            {SCOPE_LABEL[c.scope_type]}
                          </span>
                          <span className="truncate">{target.primary}</span>
                        </span>
                        {target.secondary && (
                          <span className="th-alerts-secondary truncate" title="Derived from the device or group">
                            {target.secondary}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="th-alerts-primary truncate font-mono !text-[12px]">{c.username || "—"}</span>
                        {c.purpose && <span className="th-alerts-secondary truncate">{c.purpose}</span>}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="th-onb-link tabular-nums"
                          onClick={() => void openAssignments(c)}
                          title="Show assignments"
                          aria-label={`${c.reference_count} references for ${c.name}`}
                        >
                          <Link2 className="h-3.5 w-3.5" />
                          {formatCount(c.reference_count)}
                        </button>
                      </td>
                      <td>
                        {c.last_used_at ? (
                          <>
                            <span className="th-alerts-primary">{timeAgo(c.last_used_at)}</span>
                            <span className="th-alerts-secondary tabular-nums">
                              {formatLocalDateTime(c.last_used_at)}
                            </span>
                          </>
                        ) : (
                          <span className="th-alerts-secondary !mt-0">Never</span>
                        )}
                      </td>
                      <td>
                        <span className="th-status-chip" style={{ "--chip-tone": lifecycle.tone } as CSSProperties}>
                          <i />
                          {lifecycle.label}
                        </span>
                        {testResult ? (
                          <span
                            className="th-alerts-secondary truncate"
                            style={{
                              color:
                                testResult.status === "success"
                                  ? TONE.online
                                  : testResult.status === "failed"
                                    ? TONE.critical
                                    : undefined,
                            }}
                            title={testResult.message}
                          >
                            {testResult.message}
                          </span>
                        ) : c.expires_at && c.lifecycle_status !== "disabled" ? (
                          <span className="th-alerts-secondary tabular-nums">
                            {c.lifecycle_status === "expired" ? "Expired" : "Expires"}{" "}
                            {formatLocalDateTime(c.expires_at, DAY)}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <div className="th-onb-actions">
                          {canReveal && (
                            <button
                              type="button"
                              className="th-onb-action"
                              onClick={() => openReveal(c)}
                              title="Reveal"
                              aria-label={`Reveal ${c.name}`}
                            >
                              <Eye className="h-4 w-4" />
                            </button>
                          )}
                          {canTest && (
                            <button
                              type="button"
                              className="th-onb-action"
                              onClick={() => void handleTest(c)}
                              disabled={testing === c.id}
                              title="Test connection"
                              aria-label={`Test ${c.name}`}
                            >
                              <PlayCircle className={`h-4 w-4 ${testing === c.id ? "animate-pulse" : ""}`} />
                            </button>
                          )}
                          {canEdit && (
                            <button
                              type="button"
                              className="th-onb-action"
                              onClick={() => startEdit(c)}
                              title="Edit"
                              aria-label={`Edit ${c.name}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                          )}
                          {canEdit && (
                            <button
                              type="button"
                              className="th-onb-action"
                              data-active={c.status === "active" || undefined}
                              onClick={() => void handleToggleStatus(c)}
                              title={c.status === "active" ? "Disable" : "Enable"}
                              aria-label={`${c.status === "active" ? "Disable" : "Enable"} ${c.name}`}
                            >
                              <Power className="h-4 w-4" />
                            </button>
                          )}
                          {canAssign && (
                            <button
                              type="button"
                              className="th-onb-action"
                              onClick={() => void openAssignments(c)}
                              title="Assignments"
                              aria-label={`Assignments for ${c.name}`}
                            >
                              <Link2 className="h-4 w-4" />
                            </button>
                          )}
                          {canDelete && (
                            <button
                              type="button"
                              className="th-onb-action"
                              data-tone="danger"
                              onClick={() => setDeleteTarget(c)}
                              title="Delete"
                              aria-label={`Delete ${c.name}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {filtered.length > 0 && (
          <TablePagination
            page={currentPage}
            pageSize={pageSize}
            total={filtered.length}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            pageSizeOptions={[25, 50, 100]}
            itemLabel="credentials"
          />
        )}
      </div>

      {showForm && canCreate && (
        <Modal
          title={editingId ? "Edit credential" : "Add a credential"}
          subtitle={
            editingId
              ? "Leave a secret field blank to keep the stored value"
              : "Encrypted at rest; only its use and reveals are recorded"
          }
          icon={editingId ? Pencil : KeyRound}
          size="lg"
          busy={saving}
          onClose={closeForm}
          footer={
            <>
              <Button variant="secondary" type="button" onClick={closeForm} disabled={saving}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleSave()} disabled={saving || !form.name.trim()}>
                {editingId ? <ShieldCheck className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                {saving ? "Saving…" : editingId ? "Save changes" : "Add credential"}
              </Button>
            </>
          }
        >
          {formError && <Note tone={TONE.critical}>{formError}</Note>}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="th-onb-field">
              Name
              <input
                placeholder="Name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                data-autofocus
              />
            </label>
            <div className="th-onb-field">
              Type
              <SelectField
                aria-label="Credential type"
                value={form.credential_type}
                disabled={!!editingId}
                onChange={(e) =>
                  setForm({
                    ...form,
                    credential_type: e.target.value as VaultCredentialType,
                    secret_fields: {},
                    metadata: {},
                  })
                }
              >
                {types
                  .filter((t) => !t.legacy)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
              </SelectField>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="th-onb-field">
              Scope
              <SelectField
                aria-label="Scope"
                value={form.scope_type}
                disabled={!!editingId}
                onChange={(e) =>
                  setForm({
                    ...form,
                    scope_type: e.target.value as VaultScopeType,
                    // A new scope clears every other scope's target, so none leaks into the payload.
                    client_id: "",
                    group_id: "",
                    device_id: "",
                    scope_client_filter: "",
                    group_label: "",
                    device_label: "",
                  })
                }
              >
                <option value="global">Global</option>
                <option value="client">Client</option>
                <option value="group">Group</option>
                <option value="device">Device</option>
              </SelectField>
            </div>
            <label className="th-onb-field">
              Purpose
              <input
                placeholder="Purpose (e.g. embedded_terminal)"
                value={form.purpose}
                onChange={(e) => setForm({ ...form, purpose: e.target.value })}
              />
            </label>
          </div>

          {form.scope_type === "client" && (
            <div className="th-onb-field th-onb-reveal">
              Client
              <EntitySearchSelect
                value={form.client_id}
                disabled={!!editingId}
                placeholder="Select client"
                options={clientOptions}
                onChange={(v) => setForm({ ...form, client_id: v })}
              />
            </div>
          )}

          {form.scope_type === "group" && (
            <div className="grid gap-4 sm:grid-cols-2 th-onb-reveal">
              <div className="th-onb-field">
                Client
                <EntitySearchSelect
                  value={form.scope_client_filter}
                  disabled={!!editingId}
                  placeholder="Filter by client (optional)"
                  options={clientOptions}
                  onChange={(v) => setForm({ ...form, scope_client_filter: v, group_id: "", group_label: "" })}
                />
              </div>
              <div className="th-onb-field">
                Group
                <EntitySearchSelect
                  value={form.group_id}
                  disabled={!!editingId}
                  placeholder="Select group"
                  options={groupOptions}
                  selectedLabel={form.group_label}
                  onChange={(v, label) => setForm({ ...form, group_id: v, group_label: label ?? form.group_label })}
                />
              </div>
            </div>
          )}

          {form.scope_type === "device" && (
            <div className="grid gap-4 sm:grid-cols-2 th-onb-reveal">
              <div className="th-onb-field">
                Client
                <EntitySearchSelect
                  value={form.scope_client_filter}
                  disabled={!!editingId}
                  placeholder="Filter by client (optional)"
                  options={clientOptions}
                  onChange={(v) => setForm({ ...form, scope_client_filter: v, device_id: "", device_label: "" })}
                />
              </div>
              <div className="th-onb-field">
                Device
                <EntitySearchSelect
                  value={form.device_id}
                  disabled={!!editingId}
                  placeholder="Search device by hostname…"
                  loadOptions={loadDeviceOptions}
                  selectedLabel={form.device_label}
                  onChange={(v, label) => setForm({ ...form, device_id: v, device_label: label ?? form.device_label })}
                />
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {selectedType?.requires_username && (
              <label className="th-onb-field">
                Username
                <input
                  placeholder="Username"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            )}
            {selectedType?.secret_fields.map((f) => (
              <FieldInput
                key={f.key}
                spec={f}
                value={form.secret_fields[f.key] ?? ""}
                placeholder={editingId ? "Leave blank to keep current secret" : undefined}
                onChange={(value) => setForm({ ...form, secret_fields: { ...form.secret_fields, [f.key]: value } })}
              />
            ))}
            {selectedType?.metadata_fields.map((f) => (
              <FieldInput
                key={f.key}
                spec={f}
                value={form.metadata[f.key] ?? f.default ?? ""}
                onChange={(value) => setForm({ ...form, metadata: { ...form.metadata, [f.key]: value } })}
              />
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="th-onb-field">
              Expires
              <input
                type="date"
                value={form.expires_at}
                onChange={(e) => setForm({ ...form, expires_at: e.target.value })}
                aria-label="Expires at"
              />
            </label>
            <label className="th-onb-field">
              Notes
              <input
                placeholder="Notes (optional)"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </label>
          </div>
        </Modal>
      )}

      {revealTarget && (
        <Modal
          title={revealed ? `Secret · ${revealTarget.name}` : "Reveal secret"}
          subtitle={revealed ? "Visible only in this dialog; closing it hides the value again" : revealTarget.name}
          icon={Eye}
          tone="warning"
          busy={revealing}
          onClose={closeReveal}
          footer={
            revealed ? (
              <Button type="button" onClick={closeReveal}>
                Done
              </Button>
            ) : (
              <>
                <Button variant="secondary" type="button" onClick={closeReveal} disabled={revealing}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleReveal()}
                  disabled={revealing || revealReason.trim().length < 5}
                >
                  <Eye className="h-4 w-4" />
                  {revealing ? "Revealing…" : "Reveal"}
                </Button>
              </>
            )
          }
        >
          {revealed ? (
            Object.keys(revealed).length === 0 ? (
              <EmptyState className="py-6" icon={<KeyRound className="h-5 w-5" />} title="No secret fields stored" />
            ) : (
              Object.entries(revealed).map(([key, value]) => <SecretValue key={key} label={key} value={value} />)
            )
          ) : (
            <>
              {revealError && <Note tone={TONE.critical}>{revealError}</Note>}
              <label className="th-onb-field">
                Reason
                <textarea
                  rows={3}
                  value={revealReason}
                  onChange={(e) => setRevealReason(e.target.value)}
                  data-autofocus
                  placeholder="Why the secret is needed, e.g. ticket number"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleReveal();
                  }}
                />
                <span className="th-onb-hint">
                  At least 5 characters. It is written to the audit log with your name.
                </span>
              </label>
            </>
          )}
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmationModal
          title="Delete credential"
          confirmLabel="Delete"
          onConfirm={() => void handleDelete()}
          onClose={() => setDeleteTarget(null)}
        >
          <p className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
            Permanently delete <strong>{deleteTarget.name}</strong>? This cannot be undone.
          </p>
        </ConfirmationModal>
      )}

      {blockedDelete && (
        <ConfirmationModal
          title="Credential still in use"
          confirmLabel="Delete anyway"
          onConfirm={() => void handleForceDelete()}
          onClose={() => setBlockedDelete(null)}
        >
          <p className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
            {blockedDelete.message}
          </p>
        </ConfirmationModal>
      )}

      {assignmentsTarget && (
        <Modal
          title="Assignments"
          subtitle={assignmentsTarget.name}
          icon={Link2}
          onClose={() => setAssignmentsTarget(null)}
          footer={
            <Button type="button" variant="secondary" onClick={() => setAssignmentsTarget(null)}>
              Close
            </Button>
          }
        >
          {assignments.length === 0 ? (
            <EmptyState
              className="py-6"
              icon={<Link2 className="h-5 w-5" />}
              title="No explicit assignments"
              description="Not assigned to any client or device."
            />
          ) : (
            <ul className="th-batch-list">
              {assignments.map((a) => (
                <li key={a.id}>
                  <span className="th-status-chip !h-5 flex-none !px-1.5 !text-[11px]">
                    {a.client_name ? "Client" : a.device_name ? "Device" : "Other"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "var(--th-text-primary)" }}>
                    {a.client_name ?? a.device_name ?? `#${a.id}`}
                  </span>
                  {canAssign && (
                    <button
                      type="button"
                      className="th-onb-action"
                      data-tone="danger"
                      onClick={() => void handleRemoveAssignment(a.id)}
                      aria-label={`Remove assignment ${a.client_name ?? a.device_name ?? a.id}`}
                      title="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canAssign && (
            <div className="th-onb-field">
              Assign to a client
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <SelectField
                    aria-label="Client to assign"
                    value={assignClientId}
                    onChange={(e) => setAssignClientId(e.target.value)}
                  >
                    <option value="">Select client…</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </SelectField>
                </div>
                <Button type="button" onClick={() => void handleAddAssignment()} disabled={!assignClientId}>
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}

function FieldInput({
  spec,
  value,
  onChange,
  placeholder,
}: {
  spec: {
    key: string;
    label: string;
    required: boolean;
    kind: string;
    options: string[] | null;
    default: string | null;
  };
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const label = `${spec.label}${spec.required ? " *" : ""}`;
  if (spec.kind === "select" && spec.options) {
    return (
      <div className="th-onb-field">
        {label}
        <SelectField aria-label={spec.label} value={value} onChange={(e) => onChange(e.target.value)}>
          {spec.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </SelectField>
      </div>
    );
  }
  if (spec.kind === "textarea") {
    return (
      <label className="th-onb-field sm:col-span-2">
        {label}
        <textarea
          rows={4}
          className="font-mono"
          placeholder={placeholder ?? label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      </label>
    );
  }
  return (
    <label className="th-onb-field">
      {label}
      <input
        type={spec.kind === "password" ? "password" : spec.kind === "number" ? "number" : "text"}
        placeholder={placeholder ?? label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={spec.kind === "password" ? "new-password" : "off"}
      />
    </label>
  );
}
