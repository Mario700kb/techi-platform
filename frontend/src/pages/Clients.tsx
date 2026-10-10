import { ReactNode, useEffect, useMemo, useState } from "react";
import ConfirmationModal from "../components/ConfirmationModal";
import { Building2, Globe2, Pencil, Plus, RefreshCcw, Trash2, Users, X } from "lucide-react";
import { Client, DeviceGroup, TrustedDomain, createClient, createGroup, createTrustedDomain, deleteClient, deleteGroup, deleteTrustedDomain, getClients, getGroups, getTrustedDomains, updateClient, updateGroup, updateTrustedDomain } from "../api/clients";
import { Button, PageHeader, SelectField } from "../components/ui";
import { useAuth } from "../auth/AuthContext";
import { appCache, CACHE_KEYS, CACHE_TTL } from "../store/appCache";

export default function Clients() {
  const { can } = useAuth();
  const canManageClients = can("admin");
  const [clients, setClients] = useState<Client[]>(() => appCache.peek<Client[]>(CACHE_KEYS.clientsList) ?? []);
  const [groups, setGroups] = useState<DeviceGroup[]>(() => appCache.peek<DeviceGroup[]>(CACHE_KEYS.groupsList) ?? []);
  const [trustedDomains, setTrustedDomains] = useState<TrustedDomain[]>([]);
  const [clientName, setClientName] = useState("");
  const [clientDescription, setClientDescription] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [groupClientId, setGroupClientId] = useState("");
  const [domainName, setDomainName] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<{ title: string; message: ReactNode; confirmLabel: string; run: () => Promise<void> } | null>(null);
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

  const groupsByClient = useMemo(() => {
    return groups.reduce<Record<number, DeviceGroup[]>>((acc, group) => {
      acc[group.client_id] = [...(acc[group.client_id] ?? []), group];
      return acc;
    }, {});
  }, [groups]);

  const mappedTrustedDomains = useMemo(() => {
    return trustedDomains.filter((domain) => domain.client_id);
  }, [trustedDomains]);

  const loadData = async (force = false) => {
    // Skip if cache is fresh and not forced (manual refresh)
    if (!force && appCache.get(CACHE_KEYS.clientsList, CACHE_TTL.clientsList)) return;
    try {
      setLoading(true);
      setError(null);
      const [clientData, groupData, trustedDomainData] = await Promise.all([getClients(), getGroups(), getTrustedDomains()]);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load clients");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleCreateClient = async () => {
    if (!clientName.trim()) return;
    try {
      setError(null);
      const created = await createClient({
        name: clientName,
        description: clientDescription || undefined,
      });
      setClients((items) => { const next = [...items, created].sort((a, b) => a.name.localeCompare(b.name)); appCache.set(CACHE_KEYS.clientsList, next); return next; });
      setClientName("");
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
      setGroups((items) => { const next = [...items, created].sort((a, b) => a.name.localeCompare(b.name)); appCache.set(CACHE_KEYS.groupsList, next); return next; });
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

  const handleDeleteTrustedDomain = (domain: TrustedDomain) => setPendingConfirm({
    title: "Delete domain mapping",
    message: <>Delete the trusted domain mapping <strong>{domain.domain}</strong>?</>,
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
      setClients((items) => { const next = items.map((item) => (item.id === updated.id ? updated : item)); appCache.set(CACHE_KEYS.clientsList, next); return next; });
      setEditingClient(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update client");
    }
  };

  const handleDeleteClient = (client: Client) => setPendingConfirm({
    title: "Delete client",
    message: <>Delete <strong>{client.name}</strong>? Its devices stay in the dashboard but are detached from this client and its groups.</>,
    confirmLabel: "Delete client",
    run: async () => {
    try {
      setError(null);
      await deleteClient(client.id);
      setClients((items) => { const next = items.filter((item) => item.id !== client.id); appCache.set(CACHE_KEYS.clientsList, next); return next; });
      setGroups((items) => { const next = items.filter((item) => item.client_id !== client.id); appCache.set(CACHE_KEYS.groupsList, next); return next; });
      if (groupClientId === String(client.id)) {
        const nextClient = clients.find((item) => item.id !== client.id);
        setGroupClientId(nextClient ? String(nextClient.id) : "");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete client");
    }
    },
  });

  const handleDeleteGroup = (group: DeviceGroup) => setPendingConfirm({
    title: "Delete group",
    message: <>Delete <strong>{group.name}</strong>? Devices in this group are detached and remain in the dashboard.</>,
    confirmLabel: "Delete group",
    run: async () => {
    try {
      setError(null);
      await deleteGroup(group.id);
      setGroups((items) => { const next = items.filter((item) => item.id !== group.id); appCache.set(CACHE_KEYS.groupsList, next); return next; });
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
      setGroups((items) => { const next = items.map((item) => (item.id === updated.id ? updated : item)); appCache.set(CACHE_KEYS.groupsList, next); return next; });
      setEditingGroup(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update group");
    }
  };

  return (
    <section className="premium-page space-y-5">
      <PageHeader
        title="Clients"
        description="Create customer records and lightweight groups used by device assignment and enrollment tokens."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void loadData(true)} disabled={loading}>
              <RefreshCcw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </>
        }
      />

      {error && (
        <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-sm font-medium text-red-100">
          {error}
        </div>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="premium-card-soft overflow-hidden">
          <div className="border-b border-white/[0.08] px-5 py-4">
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-techi-orange" />
              <h2 className="text-base font-semibold text-white">Client list</h2>
            </div>
          </div>
          <div className="divide-y divide-white/[0.06]">
            {clients.length === 0 ? (
              <div className="p-6 text-sm font-medium text-slate-400">No clients yet.</div>
            ) : (
              clients.map((client) => (
                <div key={client.id} className="p-5">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-semibold text-white">{client.name}</h3>
	                        {canManageClients && (
	                        <button
                          type="button"
                          onClick={() => openEditClient(client)}
                          className="text-slate-500 transition hover:text-orange-200"
                          title="Edit client"
                        >
                          <Pencil className="h-3.5 w-3.5" />
	                        </button>
	                        )}
	                        {canManageClients && (
	                        <button
                          type="button"
                          onClick={() => void handleDeleteClient(client)}
                          className="text-slate-500 transition hover:text-red-300"
                          title="Delete client"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
	                        </button>
	                        )}
                      </div>
                      <p className="mt-1 text-xs font-medium text-slate-500">{client.slug}</p>
                      {client.description && (
                        <p className="mt-2 text-sm leading-6 text-slate-300">{client.description}</p>
                      )}
                    </div>
                    <span className="rounded-full border border-emerald-400/25 bg-emerald-400/[0.08] px-2.5 py-1 text-xs font-semibold text-emerald-300">
                      Active
                    </span>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {(groupsByClient[client.id] ?? []).map((group) => (
                      <span key={group.id} className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-slate-200">
                        {group.name}
	                        {canManageClients && (
	                        <button
                          type="button"
                          onClick={() => openEditGroup(group)}
                          className="text-slate-500 transition hover:text-orange-200"
                          title="Edit group"
                        >
                          <Pencil className="h-3 w-3" />
	                        </button>
	                        )}
	                        {canManageClients && (
	                        <button
                          type="button"
                          onClick={() => void handleDeleteGroup(group)}
                          className="text-slate-500 transition hover:text-red-300"
                          title="Delete group"
                        >
                          <Trash2 className="h-3 w-3" />
	                        </button>
	                        )}
                      </span>
                    ))}
                    {(groupsByClient[client.id] ?? []).length === 0 && (
                      <span className="text-xs font-medium text-slate-500">No groups</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

	        {canManageClients && (
	        <div className="space-y-5">
          <div className="premium-card-soft p-5">
	            <div className="mb-4 flex items-center gap-2">
	              <Plus className="h-4 w-4 text-techi-orange" />
	              <h2 className="text-base font-semibold text-white">Create client</h2>
	            </div>
            <div className="space-y-3">
              <input
                value={clientName}
                onChange={(event) => setClientName(event.target.value)}
                placeholder="Client name"
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-techi-orange/60"
              />
              <textarea
                value={clientDescription}
                onChange={(event) => setClientDescription(event.target.value)}
                placeholder="Description"
                rows={3}
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-techi-orange/60"
              />
              <Button className="w-full" type="button" onClick={handleCreateClient}>
                Create Client
              </Button>
	            </div>
	          </div>

          <div className="premium-card-soft p-5">
            <div className="mb-4 flex items-center gap-2">
              <Users className="h-4 w-4 text-techi-orange" />
              <h2 className="text-base font-semibold text-white">Create group</h2>
            </div>
            <div className="space-y-3">
              <SelectField
                value={groupClientId}
                onChange={(event) => setGroupClientId(event.target.value)}
                id="group-client"
                name="group-client"
                aria-label="Client for new group"
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-techi-orange/60"
              >
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>{client.name}</option>
                ))}
              </SelectField>
              <input
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder="Group name"
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-techi-orange/60"
              />
              <textarea
                value={groupDescription}
                onChange={(event) => setGroupDescription(event.target.value)}
                placeholder="Description"
                rows={3}
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-techi-orange/60"
              />
              <Button variant="secondary" className="w-full" type="button" onClick={handleCreateGroup} disabled={!clients.length}>
                Create Group
              </Button>
	            </div>
	          </div>

          <div className="premium-card-soft p-5">
            <div className="mb-4 flex items-center gap-2">
              <Globe2 className="h-4 w-4 text-techi-orange" />
              <h2 className="text-base font-semibold text-white">Domain mapping</h2>
            </div>
            <p className="mb-3 text-xs leading-5 text-slate-500">
              Maps the domain value shown on devices, for example x, to the real client used by automatic enrollment.
            </p>
            <div className="space-y-3">
              <input
                value={domainName}
                onChange={(event) => setDomainName(event.target.value)}
                placeholder="x"
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-techi-orange/60"
              />
              <SelectField
                value={domainClientId}
                onChange={(event) => setDomainClientId(event.target.value)}
                aria-label="Mapped client"
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-techi-orange/60"
              >
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>{client.name}</option>
                ))}
              </SelectField>
              <Button variant="secondary" className="w-full" type="button" onClick={handleCreateTrustedDomain} disabled={!clients.length}>
                Save Mapping
              </Button>
            </div>

            <div className="mt-5 space-y-2">
              {mappedTrustedDomains.length === 0 ? (
                <p className="text-xs font-medium text-slate-500">No domain mappings configured.</p>
              ) : (
                mappedTrustedDomains.map((domain) => (
                  <div key={domain.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-slate-100">{domain.domain}</span>
                      <button
                        type="button"
                        onClick={() => void handleDeleteTrustedDomain(domain)}
                        className="text-slate-500 transition hover:text-red-300"
                        title="Delete mapping"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <SelectField
                      value={domain.client_id ?? ""}
                      onChange={(event) => void handleTrustedDomainClientChange(domain, event.target.value)}
                      aria-label={`Client for ${domain.domain}`}
                      className="mb-2 w-full rounded-md border border-white/10 bg-slate-950 px-2 py-2 text-xs font-medium text-white outline-none focus:border-techi-orange/60"
                    >
                      {clients.map((client) => (
                        <option key={client.id} value={client.id}>{client.name}</option>
                      ))}
                    </SelectField>
                    <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-400">
                      <input
                        type="checkbox"
                        checked={domain.is_active}
                        onChange={(event) => void handleTrustedDomainActiveChange(domain, event.target.checked)}
                        className="h-3.5 w-3.5 rounded accent-orange-500"
                      />
                      Active
                    </label>
                  </div>
                ))
              )}
            </div>
          </div>
	        </div>
	        )}
      </div>

      {editingGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-slate-950 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">Edit group</h2>
              <button
                type="button"
                onClick={() => setEditingGroup(null)}
                className="rounded-md p-1 text-slate-500 transition hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <input
                value={editGroupName}
                onChange={(event) => setEditGroupName(event.target.value)}
                id="edit-group-name"
                name="edit-group-name"
                aria-label="Group name"
                className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-techi-orange/60"
              />
              <textarea
                value={editGroupDescription}
                onChange={(event) => setEditGroupDescription(event.target.value)}
                rows={3}
                placeholder="Description"
                className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-techi-orange/60"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingGroup(null)}
                  className="rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:bg-white/[0.04] hover:text-white"
                >
                  Cancel
                </button>
                <Button type="button" onClick={handleUpdateGroup}>
                  Save Group
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-slate-950 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">Edit client</h2>
              <button
                type="button"
                onClick={() => setEditingClient(null)}
                className="rounded-md p-1 text-slate-500 transition hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <input
                value={editClientName}
                onChange={(event) => setEditClientName(event.target.value)}
                id="edit-client-name"
                name="edit-client-name"
                aria-label="Client name"
                className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-techi-orange/60"
              />
              <textarea
                value={editClientDescription}
                onChange={(event) => setEditClientDescription(event.target.value)}
                rows={3}
                placeholder="Description"
                className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-techi-orange/60"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingClient(null)}
                  className="rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:bg-white/[0.04] hover:text-white"
                >
                  Cancel
                </button>
                <Button type="button" onClick={handleUpdateClient}>
                  Save Client
                </Button>
              </div>
            </div>
          </div>
        </div>
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
