import { useEffect, useMemo, useState } from "react";
import { Building2, ChevronRight, Cpu, FolderOpen, Loader2, Search, X } from "lucide-react";
import { Client, DeviceGroup, getClients, getGroups } from "../api/clients";
import { Device, getDevices } from "../api/devices";
import { ScopeEntry, ScopeEntryCreate, ScopeType, getOperatorScopes, replaceOperatorScopes } from "../api/scopes";
import { OperatorRecord } from "../api/operators";
import { Button } from "./ui";

interface Props {
  operator: OperatorRecord;
  onClose: () => void;
}

type Tab = "clients" | "groups" | "devices";

function SectionSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative mb-2">
      <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-500" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="th-input w-full rounded-md border py-1.5 pl-7 pr-3 text-xs font-medium outline-none focus:border-techi-orange/40"
      />
    </div>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
  sub,
  icon,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  sub?: string;
  icon: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition hover:bg-white/[0.04]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 accent-orange-400"
      />
      <span className="mt-px flex-shrink-0 text-slate-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-slate-200">{label}</span>
        {sub && <span className="block truncate text-[11px] text-slate-500">{sub}</span>}
      </span>
    </label>
  );
}

export default function OperatorScopeModal({ operator, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [clients, setClients] = useState<Client[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);

  const [selectedClients, setSelectedClients] = useState<Set<number>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<number>>(new Set());
  const [selectedDevices, setSelectedDevices] = useState<Set<number>>(new Set());

  const [tab, setTab] = useState<Tab>("clients");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const [existingScopes, clientList, groupList, deviceList] = await Promise.all([
          getOperatorScopes(operator.id),
          getClients(),
          getGroups(),
          getDevices({}, 0, 500),
        ]);
        setClients(clientList);
        setGroups(groupList);
        setDevices(deviceList.devices);

        const sc = new Set<number>();
        const sg = new Set<number>();
        const sd = new Set<number>();
        for (const e of existingScopes) {
          if (e.scope_type === "client") sc.add(e.scope_id);
          else if (e.scope_type === "group") sg.add(e.scope_id);
          else if (e.scope_type === "device") sd.add(e.scope_id);
        }
        setSelectedClients(sc);
        setSelectedGroups(sg);
        setSelectedDevices(sd);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load scope data");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [operator.id]);

  const toggle = (set: Set<number>, setFn: (s: Set<number>) => void, id: number, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    setFn(next);
  };

  const totalEntries = selectedClients.size + selectedGroups.size + selectedDevices.size;

  const clientMap = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);

  const filteredClients = useMemo(
    () => clients.filter((c) => c.name.toLowerCase().includes(search.toLowerCase())),
    [clients, search],
  );
  const filteredGroups = useMemo(
    () =>
      groups.filter(
        (g) =>
          g.name.toLowerCase().includes(search.toLowerCase()) ||
          (clientMap.get(g.client_id)?.name ?? "").toLowerCase().includes(search.toLowerCase()),
      ),
    [groups, search, clientMap],
  );
  const filteredDevices = useMemo(
    () =>
      devices.filter(
        (d) =>
          (d.hostname ?? "").toLowerCase().includes(search.toLowerCase()) ||
          d.rustdesk_id.toLowerCase().includes(search.toLowerCase()) ||
          (d.client_name ?? "").toLowerCase().includes(search.toLowerCase()),
      ),
    [devices, search],
  );

  const effectiveSummary = useMemo(() => {
    const parts: string[] = [];
    if (selectedClients.size > 0) {
      const names = [...selectedClients]
        .map((id) => clientMap.get(id)?.name ?? `Client #${id}`)
        .slice(0, 3)
        .join(", ");
      parts.push(`${selectedClients.size} client${selectedClients.size !== 1 ? "s" : ""} (${names}${selectedClients.size > 3 ? "…" : ""})`);
    }
    if (selectedGroups.size > 0) {
      parts.push(`${selectedGroups.size} group${selectedGroups.size !== 1 ? "s" : ""}`);
    }
    if (selectedDevices.size > 0) {
      parts.push(`${selectedDevices.size} device${selectedDevices.size !== 1 ? "s" : ""}`);
    }
    return parts.length === 0 ? "No access — operator sees nothing" : parts.join(" + ");
  }, [selectedClients, selectedGroups, selectedDevices, clientMap]);

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      const entries: ScopeEntryCreate[] = [
        ...[...selectedClients].map((id) => ({ scope_type: "client" as ScopeType, scope_id: id })),
        ...[...selectedGroups].map((id) => ({ scope_type: "group" as ScopeType, scope_id: id })),
        ...[...selectedDevices].map((id) => ({ scope_type: "device" as ScopeType, scope_id: id })),
      ];
      await replaceOperatorScopes(operator.id, entries);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save scope");
    } finally {
      setSaving(false);
    }
  };

  const TAB_LABELS: Record<Tab, string> = {
    clients: `Clients${selectedClients.size ? ` (${selectedClients.size})` : ""}`,
    groups: `Groups${selectedGroups.size ? ` (${selectedGroups.size})` : ""}`,
    devices: `Devices${selectedDevices.size ? ` (${selectedDevices.size})` : ""}`,
  };

  const displayName = operator.display_name ?? operator.username;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="th-elevated flex w-full max-w-xl flex-col rounded-xl border shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Manage Access Scope</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">
              <span className="font-mono text-slate-300">{operator.username}</span>
              {operator.display_name && ` · ${displayName}`}
              <span className="mx-1 text-slate-600">·</span>
              <span className="capitalize text-slate-400">{operator.role}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 transition hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-techi-orange" />
          </div>
        ) : (
          <>
            {/* Effective access summary */}
            <div className="th-table-head border-b border-white/[0.06] px-5 py-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Effective Access</p>
              <p className={`mt-0.5 text-xs font-medium ${totalEntries === 0 ? "text-amber-400" : "text-emerald-300"}`}>
                {effectiveSummary}
              </p>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-white/[0.08]">
              {(["clients", "groups", "devices"] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setTab(t); setSearch(""); }}
                  className={`flex-1 py-2.5 text-xs font-semibold transition ${
                    tab === t
                      ? "border-b-2 border-techi-orange text-white"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {TAB_LABELS[t]}
                </button>
              ))}
            </div>

            {/* Search + list */}
            <div className="flex-1 overflow-y-auto p-3" style={{ maxHeight: "320px" }}>
              <SectionSearch
                value={search}
                onChange={setSearch}
                placeholder={`Search ${tab}…`}
              />

              {tab === "clients" && (
                <div className="space-y-0.5">
                  {filteredClients.length === 0 && (
                    <p className="py-4 text-center text-xs text-slate-600">No clients found</p>
                  )}
                  {filteredClients.map((c) => (
                    <CheckRow
                      key={c.id}
                      checked={selectedClients.has(c.id)}
                      onChange={(on) => toggle(selectedClients, setSelectedClients, c.id, on)}
                      icon={<Building2 className="h-3.5 w-3.5" />}
                      label={c.name}
                      sub={c.slug}
                    />
                  ))}
                </div>
              )}

              {tab === "groups" && (
                <div className="space-y-0.5">
                  {filteredGroups.length === 0 && (
                    <p className="py-4 text-center text-xs text-slate-600">No groups found</p>
                  )}
                  {filteredGroups.map((g) => {
                    const clientName = clientMap.get(g.client_id)?.name;
                    const clientSelected = g.client_id && selectedClients.has(g.client_id);
                    return (
                      <CheckRow
                        key={g.id}
                        checked={selectedGroups.has(g.id) || !!clientSelected}
                        onChange={(on) => {
                          if (clientSelected) return;
                          toggle(selectedGroups, setSelectedGroups, g.id, on);
                        }}
                        icon={<FolderOpen className="h-3.5 w-3.5" />}
                        label={g.name}
                        sub={clientName ? `${clientName}${clientSelected ? " · via client" : ""}` : undefined}
                      />
                    );
                  })}
                </div>
              )}

              {tab === "devices" && (
                <div className="space-y-0.5">
                  {filteredDevices.length === 0 && (
                    <p className="py-4 text-center text-xs text-slate-600">No devices found</p>
                  )}
                  {filteredDevices.map((d) => {
                    const clientSelected = d.client_id && selectedClients.has(d.client_id);
                    const groupSelected = d.group_id && selectedGroups.has(d.group_id);
                    const implicitAccess = !!(clientSelected || groupSelected);
                    const via = clientSelected ? "via client" : groupSelected ? "via group" : undefined;
                    return (
                      <CheckRow
                        key={d.id}
                        checked={selectedDevices.has(d.id) || implicitAccess}
                        onChange={(on) => {
                          if (implicitAccess) return;
                          toggle(selectedDevices, setSelectedDevices, d.id, on);
                        }}
                        icon={<Cpu className="h-3.5 w-3.5" />}
                        label={d.hostname ?? d.rustdesk_id}
                        sub={[d.client_name, d.group_name, via].filter(Boolean).join(" · ") || undefined}
                      />
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            {error && (
              <div className="mx-4 rounded-md border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-100">
                {error}
              </div>
            )}
            <div className="flex items-center justify-between border-t border-white/[0.08] px-5 py-3.5">
              <span className="text-[11px] text-slate-500">
                {totalEntries === 0 ? (
                  <span className="text-amber-400/80">Saving with no entries = no fleet access</span>
                ) : (
                  <span>{totalEntries} scope {totalEntries === 1 ? "entry" : "entries"} selected</span>
                )}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="th-btn-secondary rounded-lg border px-4 py-2 text-sm font-semibold transition hover:bg-white/[0.04]"
                >
                  Cancel
                </button>
                <Button type="button" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    <>
                      <ChevronRight className="h-3.5 w-3.5" />
                      Save Scope
                    </>
                  )}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
