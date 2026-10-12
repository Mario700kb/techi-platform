import { ReactNode, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  AlertTriangle,
  Building2,
  Globe2,
  Layers,
  Monitor,
  Pencil,
  Plus,
  RefreshCcw,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";
import ConfirmationModal from "../components/ConfirmationModal";
import {
  Client,
  DeviceGroup,
  TrustedDomain,
  createClient,
  createGroup,
  createTrustedDomain,
  deleteClient,
  deleteGroup,
  deleteTrustedDomain,
  getClients,
  getGroups,
  getTrustedDomains,
  updateClient,
  updateGroup,
  updateTrustedDomain,
} from "../api/clients";
import { getDeviceTree } from "../api/devices";
import { Button, EmptyState, PageHeader, Select } from "../components/ui";
import { CardHead } from "../components/ui/PanelCard";
import Modal from "../components/ui/Modal";
import TablePagination from "../components/ui/TablePagination";
import { useAuth } from "../auth/AuthContext";
import { useTabIndicator } from "../hooks/useTabIndicator";
import { appCache, CACHE_KEYS, CACHE_TTL } from "../store/appCache";
import { TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { formatLocalDateTime } from "../utils/time";

type ClientFilter = "all" | "active" | "inactive";

const CLIENT_FILTERS: { id: ClientFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "inactive", label: "Inactive" },
];

/** Mirrors ClientService._normalize_slug, so the placeholder is the slug the
 *  backend will store. */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
}

export default function Clients() {
  const { can } = useAuth();
  const canManageClients = can("admin");
  const [clients, setClients] = useState<Client[]>(() => appCache.peek<Client[]>(CACHE_KEYS.clientsList) ?? []);
  const [groups, setGroups] = useState<DeviceGroup[]>(() => appCache.peek<DeviceGroup[]>(CACHE_KEYS.groupsList) ?? []);
  const [trustedDomains, setTrustedDomains] = useState<TrustedDomain[]>([]);
  const [deviceCounts, setDeviceCounts] = useState<Record<string, number>>({});
  const [clientName, setClientName] = useState("");
  const [clientDescription, setClientDescription] = useState("");
  const [clientSlug, setClientSlug] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [groupClientId, setGroupClientId] = useState("");
  const [domainName, setDomainName] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    message: ReactNode;
    confirmLabel: string;
    run: () => Promise<void>;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [domainClientId, setDomainClientId] = useState("");
  const [editingGroup, setEditingGroup] = useState<DeviceGroup | null>(null);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [editClientName, setEditClientName] = useState("");
  const [editClientDescription, setEditClientDescription] = useState("");
  const [editGroupName, setEditGroupName] = useState("");
  const [editGroupDescription, setEditGroupDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClientFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const filterTabsRef = useTabIndicator<HTMLDivElement>(filter);

  const groupsByClient = useMemo(() => {
    return groups.reduce<Record<number, DeviceGroup[]>>((acc, group) => {
      acc[group.client_id] = [...(acc[group.client_id] ?? []), group];
      return acc;
    }, {});
  }, [groups]);

  const mappedTrustedDomains = useMemo(() => {
    return trustedDomains.filter((domain) => domain.client_id);
  }, [trustedDomains]);

  const clientOptions = useMemo(() => clients.map((c) => ({ value: String(c.id), label: c.name })), [clients]);
  const counts = useMemo(
    () => ({
      all: clients.length,
      active: clients.filter((c) => c.is_active).length,
      inactive: clients.filter((c) => !c.is_active).length,
    }),
    [clients],
  );
  const visibleClients = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients.filter((client) => {
      if (filter === "active" && !client.is_active) return false;
      if (filter === "inactive" && client.is_active) return false;
      if (!q) return true;
      const groupNames = (groupsByClient[client.id] ?? []).map((g) => g.name).join(" ");
      return [client.name, client.slug, client.description ?? "", groupNames].some((v) => v.toLowerCase().includes(q));
    });
  }, [clients, filter, search, groupsByClient]);
  const pagedClients = useMemo(
    () => visibleClients.slice((page - 1) * pageSize, page * pageSize),
    [visibleClients, page, pageSize],
  );

  const loadData = async (force = false) => {
    // Skip if cache is fresh and not forced (manual refresh)
    if (!force && appCache.get(CACHE_KEYS.clientsList, CACHE_TTL.clientsList)) {
      if (!trustedDomains.length)
        getTrustedDomains()
          .then(setTrustedDomains)
          .catch(() => undefined);
      getDeviceTree()
        .then((tree) => setDeviceCounts(tree.by_client))
        .catch(() => undefined);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const [clientData, groupData, trustedDomainData] = await Promise.all([
        getClients(),
        getGroups(),
        getTrustedDomains(),
      ]);
      appCache.set(CACHE_KEYS.clientsList, clientData);
      appCache.set(CACHE_KEYS.groupsList, groupData);
      setClients(clientData);
      setGroups(groupData);
      setTrustedDomains(trustedDomainData);
      if (!groupClientId && clientData[0]) {
        setGroupClientId(String(clientData[0].id));
      }
      if (!domainClientId && clientData[0]) {
        setDomainClientId(String(clientData[0].id));
      }
      getDeviceTree()
        .then((tree) => setDeviceCounts(tree.by_client))
        .catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load clients");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!groupClientId && clients[0]) setGroupClientId(String(clients[0].id));
    if (!domainClientId && clients[0]) setDomainClientId(String(clients[0].id));
  }, [clients]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateClient = async () => {
    if (!clientName.trim()) return;
    try {
      setError(null);
      const created = await createClient({
        name: clientName,
        slug: clientSlug.trim() || undefined,
        description: clientDescription || undefined,
      });
      setClients((items) => {
        const next = [...items, created].sort((a, b) => a.name.localeCompare(b.name));
        appCache.set(CACHE_KEYS.clientsList, next);
        return next;
      });
      setClientName("");
      setClientSlug("");
      setClientDescription("");
      if (!groupClientId) setGroupClientId(String(created.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create client");
    }
  };

  const handleCreateGroup = async () => {
    if (!groupName.trim() || !groupClientId) return;
    try {
      setError(null);
      const created = await createGroup({
        name: groupName,
        client_id: Number(groupClientId),
        description: groupDescription || undefined,
      });
      setGroups((items) => {
        const next = [...items, created].sort((a, b) => a.name.localeCompare(b.name));
        appCache.set(CACHE_KEYS.groupsList, next);
        return next;
      });
      setGroupName("");
      setGroupDescription("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create group");
    }
  };

  const handleCreateTrustedDomain = async () => {
    if (!domainName.trim() || !domainClientId) return;
    try {
      setError(null);
      const created = await createTrustedDomain({
        domain: domainName,
        client_id: Number(domainClientId),
        is_active: true,
      });
      setTrustedDomains((items) => [...items, created].sort((a, b) => a.domain.localeCompare(b.domain)));
      setDomainName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create domain mapping");
    }
  };

  const handleTrustedDomainClientChange = async (domain: TrustedDomain, clientId: string) => {
    try {
      setError(null);
      const updated = await updateTrustedDomain(domain.id, { client_id: clientId ? Number(clientId) : null });
      setTrustedDomains((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update domain mapping");
    }
  };

  const handleTrustedDomainActiveChange = async (domain: TrustedDomain, isActive: boolean) => {
    try {
      setError(null);
      const updated = await updateTrustedDomain(domain.id, { is_active: isActive });
      setTrustedDomains((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update domain mapping");
    }
  };

  const handleDeleteTrustedDomain = (domain: TrustedDomain) =>
    setPendingConfirm({
      title: "Delete domain mapping",
      message: (
        <>
          Delete the trusted domain mapping <strong style={{ color: "var(--th-text-primary)" }}>{domain.domain}</strong>
          ?
        </>
      ),
      confirmLabel: "Delete mapping",
      run: async () => {
        try {
          setError(null);
          await deleteTrustedDomain(domain.id);
          setTrustedDomains((items) => items.filter((item) => item.id !== domain.id));
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to delete domain mapping");
        }
      },
    });

  const openEditClient = (client: Client) => {
    setEditingClient(client);
    setEditClientName(client.name);
    setEditClientDescription(client.description ?? "");
  };

  const handleUpdateClient = async () => {
    if (!editingClient || !editClientName.trim()) return;
    try {
      setError(null);
      const updated = await updateClient(editingClient.id, {
        name: editClientName,
        description: editClientDescription || null,
      });
      setClients((items) => {
        const next = items.map((item) => (item.id === updated.id ? updated : item));
        appCache.set(CACHE_KEYS.clientsList, next);
        return next;
      });
      setEditingClient(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update client");
    }
  };

  const handleDeleteClient = (client: Client) =>
    setPendingConfirm({
      title: "Delete client",
      message: (
        <>
          Delete <strong style={{ color: "var(--th-text-primary)" }}>{client.name}</strong>? Its devices stay in the
          dashboard but are detached from this client and its groups.
        </>
      ),
      confirmLabel: "Delete client",
      run: async () => {
        try {
          setError(null);
          await deleteClient(client.id);
          setClients((items) => {
            const next = items.filter((item) => item.id !== client.id);
            appCache.set(CACHE_KEYS.clientsList, next);
            return next;
          });
          setGroups((items) => {
            const next = items.filter((item) => item.client_id !== client.id);
            appCache.set(CACHE_KEYS.groupsList, next);
            return next;
          });
          if (groupClientId === String(client.id)) {
            const nextClient = clients.find((item) => item.id !== client.id);
            setGroupClientId(nextClient ? String(nextClient.id) : "");
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to delete client");
        }
      },
    });

  const handleDeleteGroup = (group: DeviceGroup) =>
    setPendingConfirm({
      title: "Delete group",
      message: (
        <>
          Delete <strong style={{ color: "var(--th-text-primary)" }}>{group.name}</strong>? Devices in this group are
          detached and remain in the dashboard.
        </>
      ),
      confirmLabel: "Delete group",
      run: async () => {
        try {
          setError(null);
          await deleteGroup(group.id);
          setGroups((items) => {
            const next = items.filter((item) => item.id !== group.id);
            appCache.set(CACHE_KEYS.groupsList, next);
            return next;
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to delete group");
        }
      },
    });

  const openEditGroup = (group: DeviceGroup) => {
    setEditingGroup(group);
    setEditGroupName(group.name);
    setEditGroupDescription(group.description ?? "");
  };

  const handleUpdateGroup = async () => {
    if (!editingGroup || !editGroupName.trim()) return;
    try {
      setError(null);
      const updated = await updateGroup(editingGroup.id, {
        name: editGroupName,
        description: editGroupDescription || null,
      });
      setGroups((items) => {
        const next = items.map((item) => (item.id === updated.id ? updated : item));
        appCache.set(CACHE_KEYS.groupsList, next);
        return next;
      });
      setEditingGroup(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update group");
    }
  };

  const totalDevices = Object.values(deviceCounts).reduce((sum, n) => sum + n, 0);
  const activeMappings = mappedTrustedDomains.filter((d) => d.is_active).length;

  return (
    <section className="premium-page th-onb flex flex-col gap-4">
      <PageHeader
        title="Clients"
        description="Customer records and the groups that device assignment and enrollment tokens place devices into."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void loadData(true)} disabled={loading}>
            <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      {error && (
        <div
          className="th-onb-note th-onb-reveal"
          style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
          role="alert"
        >
          <AlertTriangle className="h-4 w-4" />
          <span className="flex-1">{error}</span>
          <button type="button" className="th-onb-action !h-5 !w-5" onClick={() => setError(null)} aria-label="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── summary ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Clients",
            value: formatCount(counts.all),
            hint: `${formatCount(counts.active)} active`,
            icon: Building2,
            tone: "var(--th-accent)",
          },
          {
            label: "Groups",
            value: formatCount(groups.length),
            hint: "Client PC, Servers and custom",
            icon: Layers,
            tone: TONE.info,
          },
          {
            label: "Assigned devices",
            value: formatCount(totalDevices),
            hint: "Across every client",
            icon: Monitor,
            tone: TONE.online,
          },
          {
            label: "Domain mappings",
            value: formatCount(mappedTrustedDomains.length),
            hint: `${formatCount(activeMappings)} active`,
            icon: Globe2,
            tone: TONE.maintenance,
          },
        ].map((item, index) => (
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
                className="text-[24px] font-semibold leading-8 tabular-nums"
                style={{ color: "var(--th-text-primary)" }}
              >
                {item.value}
              </div>
              <div className="truncate text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                {item.hint}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── create client · create group ────────────────────────────────── */}
      {canManageClients && (
        <div className="grid items-stretch gap-4 max-md:order-last xl:grid-cols-2">
          <div className="th-onb-card th-onb-enter" style={{ "--i": 4 } as CSSProperties}>
            <CardHead
              icon={Building2}
              tone="var(--th-accent)"
              title="New client"
              subtitle="A customer whose devices the platform manages"
            />
            <div className="th-onb-body flex-1">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="th-onb-field">
                  Name
                  <input
                    value={clientName}
                    onChange={(event) => setClientName(event.target.value)}
                    placeholder="e.g. Vasgroup"
                    onKeyDown={(e) => e.key === "Enter" && void handleCreateClient()}
                  />
                </label>
                <label className="th-onb-field">
                  Slug
                  <input
                    value={clientSlug}
                    onChange={(event) => setClientSlug(event.target.value)}
                    placeholder={slugify(clientName) || "Derived from the name"}
                    spellCheck={false}
                  />
                </label>
              </div>
              <label className="th-onb-field">
                Description
                <textarea
                  value={clientDescription}
                  onChange={(event) => setClientDescription(event.target.value)}
                  placeholder="Optional"
                  rows={3}
                />
              </label>
            </div>
            <div className="th-onb-foot">
              <Button
                className="w-full"
                type="button"
                onClick={() => void handleCreateClient()}
                disabled={!clientName.trim()}
              >
                <Plus className="h-4 w-4" />
                Create client
              </Button>
            </div>
          </div>

          <div className="th-onb-card th-onb-enter" style={{ "--i": 5 } as CSSProperties}>
            <CardHead
              icon={Users}
              tone="var(--th-status-info)"
              title="New group"
              subtitle="Groups sort a client's devices; Client PC and Servers exist by default"
            />
            <div className="th-onb-body flex-1">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="th-onb-field">
                  Client
                  <Select
                    id="group-client"
                    aria-label="Client for new group"
                    value={groupClientId}
                    onChange={setGroupClientId}
                    options={clientOptions}
                    placeholder="Select client"
                  />
                </div>
                <label className="th-onb-field">
                  Name
                  <input
                    value={groupName}
                    onChange={(event) => setGroupName(event.target.value)}
                    placeholder="e.g. Reception"
                    onKeyDown={(e) => e.key === "Enter" && void handleCreateGroup()}
                  />
                </label>
              </div>
              <label className="th-onb-field">
                Description
                <textarea
                  value={groupDescription}
                  onChange={(event) => setGroupDescription(event.target.value)}
                  placeholder="Optional"
                  rows={3}
                />
              </label>
            </div>
            <div className="th-onb-foot">
              <Button
                className="w-full"
                type="button"
                onClick={() => void handleCreateGroup()}
                disabled={!clients.length || !groupName.trim() || !groupClientId}
              >
                <Plus className="h-4 w-4" />
                Create group
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── clients ─────────────────────────────────────────────────────── */}
      <div className="th-alerts-card th-onb-tokens th-onb-enter" style={{ "--i": 6 } as CSSProperties}>
        <CardHead
          icon={Building2}
          tone="var(--th-accent)"
          title="Clients"
          subtitle={
            loading && clients.length === 0
              ? "Loading…"
              : `${formatCount(clients.length)} clients · ${formatCount(groups.length)} groups`
          }
        />
        <div className="th-alerts-toolbar">
          <div ref={filterTabsRef} role="tablist" aria-label="Client status" className="th-tabs">
            {CLIENT_FILTERS.map(({ id, label }) => (
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
                <span className="th-tab-count">{formatCount(counts[id])}</span>
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
                placeholder="Search clients or groups"
                aria-label="Search clients"
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
        </div>

        {loading && clients.length === 0 ? (
          <div className="th-alerts-scroll" aria-busy="true" aria-label="Loading clients">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.12 }} />
            ))}
          </div>
        ) : visibleClients.length === 0 ? (
          <EmptyState
            className="th-fade-in py-10"
            icon={<Building2 className="h-5 w-5" />}
            title={clients.length === 0 ? "No clients yet" : "No clients match these filters"}
            action={
              clients.length > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setFilter("all");
                    setSearch("");
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="th-alerts-scroll th-table-scroll">
            <table className="th-alerts-table" data-mobile="cards">
              <colgroup>
                <col className="w-[28%]" />
                <col className="w-[110px]" />
                <col className="w-[100px]" />
                <col />
                <col className="w-[130px]" />
                {canManageClients && <col className="w-[92px]" />}
              </colgroup>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Status</th>
                  <th className="text-right">Devices</th>
                  <th>Groups</th>
                  <th>Created</th>
                  {canManageClients && <th className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {pagedClients.map((client, index) => {
                  const clientGroups = groupsByClient[client.id] ?? [];
                  const devices = deviceCounts[String(client.id)] ?? 0;
                  return (
                    <tr key={client.id} className="th-alerts-row" style={{ "--row": index } as CSSProperties}>
                      <td>
                        <span className="th-alerts-primary">{client.name}</span>
                        <span className="th-alerts-secondary" title={client.description ?? undefined}>
                          <span className="font-mono">{client.slug}</span>
                          {client.description ? ` · ${client.description}` : ""}
                        </span>
                      </td>
                      <td>
                        <span
                          className="th-status-chip"
                          style={{ "--chip-tone": client.is_active ? TONE.online : TONE.neutral } as CSSProperties}
                        >
                          <i />
                          {client.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="text-right">
                        <span
                          className="th-alerts-primary tabular-nums"
                          style={devices ? undefined : { color: "var(--th-text-faint)" }}
                        >
                          {formatCount(devices)}
                        </span>
                      </td>
                      <td>
                        {clientGroups.length === 0 ? (
                          <span className="th-alerts-secondary">No groups</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {clientGroups.map((group) => (
                              <span key={group.id} className="th-onb-group" title={group.description ?? undefined}>
                                {group.name}
                                {canManageClients && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => openEditGroup(group)}
                                      aria-label={`Edit group ${group.name}`}
                                      title="Edit group"
                                    >
                                      <Pencil className="h-3 w-3" />
                                    </button>
                                    <button
                                      type="button"
                                      data-tone="danger"
                                      onClick={() => handleDeleteGroup(group)}
                                      aria-label={`Delete group ${group.name}`}
                                      title="Delete group"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </button>
                                  </>
                                )}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className="th-alerts-secondary !mt-0 tabular-nums">
                          {formatLocalDateTime(client.created_at, { day: "numeric", month: "short", year: "numeric" })}
                        </span>
                      </td>
                      {canManageClients && (
                        <td>
                          <div className="th-onb-actions">
                            <button
                              type="button"
                              className="th-onb-action"
                              onClick={() => openEditClient(client)}
                              title="Edit client"
                              aria-label={`Edit ${client.name}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              className="th-onb-action"
                              data-tone="danger"
                              onClick={() => handleDeleteClient(client)}
                              title="Delete client"
                              aria-label={`Delete ${client.name}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {visibleClients.length > 0 && (
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={visibleClients.length}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            pageSizeOptions={[25, 50, 100]}
            itemLabel="clients"
          />
        )}
      </div>

      {/* ── domain mappings ─────────────────────────────────────────────── */}
      {canManageClients && (
        <div className="th-alerts-card th-onb-tokens th-onb-enter" style={{ "--i": 7 } as CSSProperties}>
          <CardHead
            icon={Globe2}
            tone={TONE.maintenance}
            title="Domain mapping"
            subtitle="Maps the domain a device reports to the client that automatic enrollment places it in"
          />
          <div className="th-onb-maprow th-onb-mapadd">
            <label className="th-onb-field">
              Domain
              <input
                value={domainName}
                onChange={(event) => setDomainName(event.target.value)}
                placeholder="e.g. VASGROUP"
                spellCheck={false}
                onKeyDown={(e) => e.key === "Enter" && void handleCreateTrustedDomain()}
              />
            </label>
            <div className="th-onb-field">
              Client
              <Select
                id="domain-client"
                aria-label="Mapped client"
                value={domainClientId}
                onChange={setDomainClientId}
                options={clientOptions}
                placeholder="Select client"
                className="w-full"
              />
            </div>
            <Button
              className="w-full"
              type="button"
              onClick={() => void handleCreateTrustedDomain()}
              disabled={!clients.length || !domainName.trim() || !domainClientId}
            >
              <Plus className="h-4 w-4" />
              Add mapping
            </Button>
          </div>
          {mappedTrustedDomains.length === 0 ? (
            <EmptyState
              className="py-8"
              icon={<Globe2 className="h-5 w-5" />}
              title="No domain mappings"
              description="Without one, domain-joined devices enroll through their token's client."
            />
          ) : (
            <div role="table" aria-label="Domain mappings">
              <div role="row" className="th-onb-maprow th-onb-maphead">
                <span role="columnheader">Domain</span>
                <span role="columnheader">Client</span>
                <span role="columnheader" className="flex justify-between">
                  <span>Active</span>
                  <span>Actions</span>
                </span>
              </div>
              {mappedTrustedDomains.map((domain, index) => (
                <div
                  role="row"
                  key={domain.id}
                  className="th-onb-maprow th-alerts-row"
                  style={{ "--row": index } as CSSProperties}
                >
                  <span role="cell" className="th-alerts-primary font-mono !text-[12px]">
                    {domain.domain}
                  </span>
                  <span role="cell">
                    <Select
                      id={`domain-${domain.id}-client`}
                      aria-label={`Client for ${domain.domain}`}
                      value={domain.client_id ? String(domain.client_id) : ""}
                      onChange={(value) => void handleTrustedDomainClientChange(domain, value)}
                      options={clientOptions}
                      className="w-full"
                    />
                  </span>
                  <span role="cell" className="flex items-center justify-between">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={domain.is_active}
                      aria-label={`${domain.domain} active`}
                      className="th-onb-switch"
                      onClick={() => void handleTrustedDomainActiveChange(domain, !domain.is_active)}
                    >
                      <i />
                    </button>
                    <button
                      type="button"
                      className="th-onb-action"
                      data-tone="danger"
                      onClick={() => handleDeleteTrustedDomain(domain)}
                      title="Delete mapping"
                      aria-label={`Delete mapping ${domain.domain}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {editingGroup && (
        <Modal
          title="Edit group"
          subtitle={clients.find((c) => c.id === editingGroup.client_id)?.name}
          icon={Users}
          onClose={() => setEditingGroup(null)}
          footer={
            <>
              <Button variant="secondary" type="button" onClick={() => setEditingGroup(null)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleUpdateGroup()} disabled={!editGroupName.trim()}>
                Save group
              </Button>
            </>
          }
        >
          <label className="th-onb-field">
            Name
            <input
              value={editGroupName}
              onChange={(event) => setEditGroupName(event.target.value)}
              id="edit-group-name"
              aria-label="Group name"
            />
          </label>
          <label className="th-onb-field">
            Description
            <textarea
              value={editGroupDescription}
              onChange={(event) => setEditGroupDescription(event.target.value)}
              rows={3}
              placeholder="Optional"
            />
          </label>
        </Modal>
      )}

      {editingClient && (
        <Modal
          title="Edit client"
          subtitle={editingClient.slug}
          icon={Building2}
          onClose={() => setEditingClient(null)}
          footer={
            <>
              <Button variant="secondary" type="button" onClick={() => setEditingClient(null)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleUpdateClient()} disabled={!editClientName.trim()}>
                Save client
              </Button>
            </>
          }
        >
          <label className="th-onb-field">
            Name
            <input
              value={editClientName}
              onChange={(event) => setEditClientName(event.target.value)}
              id="edit-client-name"
              aria-label="Client name"
            />
          </label>
          <label className="th-onb-field">
            Description
            <textarea
              value={editClientDescription}
              onChange={(event) => setEditClientDescription(event.target.value)}
              rows={3}
              placeholder="Optional"
            />
          </label>
        </Modal>
      )}

      {pendingConfirm && (
        <ConfirmationModal
          title={pendingConfirm.title}
          confirmLabel={pendingConfirm.confirmLabel}
          loading={confirmBusy}
          onClose={() => setPendingConfirm(null)}
          onConfirm={async () => {
            setConfirmBusy(true);
            await pendingConfirm.run();
            setConfirmBusy(false);
            setPendingConfirm(null);
          }}
        >
          {pendingConfirm.message}
        </ConfirmationModal>
      )}
    </section>
  );
}
