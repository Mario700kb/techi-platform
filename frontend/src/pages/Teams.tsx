import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, ChevronRight, Cpu, Pencil, Plus, RefreshCcw, Search, Trash2, Users, UsersRound, X } from "lucide-react";
import {
  TeamWithStats,
  TeamCreate,
  TeamUpdate,
  listTeams,
  createTeam,
  updateTeam,
  deleteTeam,
} from "../api/teams";
import { Button, EmptyState, PageHeader } from "../components/ui";
import { useAuth } from "../auth/AuthContext";
import { APP_TIME_ZONE, parseUTC } from "../utils/time";
import ConfirmationModal from "../components/ConfirmationModal";

const COLOR_PRESETS = [
  "#E85A3C", "#7C9CBF", "#C77B93", "#5C8C6A",
  "#4E8E86", "#8E7CC3", "#F04A2A", "#C8A000",
  "#FF6B47", "#A0A0AA",
];

const INPUT_CLS =
  "th-input w-full rounded-lg border px-3 py-2.5 text-sm font-medium outline-none focus:border-techi-orange/60";
const LABEL_CLS = "block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1";

interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  title: string;
}

function Modal({ onClose, children, title }: ModalProps) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex min-h-dvh items-center justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div className="th-elevated w-full max-w-md rounded-xl border p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-500 transition hover:bg-white/5 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {COLOR_PRESETS.map((c) => (
        <button key={c} type="button" onClick={() => onChange(c)} className="h-7 w-7 rounded-full border-2 transition hover:scale-110"
          style={{ background: c, borderColor: value === c ? "white" : "transparent", boxShadow: value === c ? `0 0 0 1px ${c}` : undefined }} title={c} />
      ))}
    </div>
  );
}

// ── Permission templates ──────────────────────────────────────────────────── //

const PERMISSION_TEMPLATES: Record<string, { label: string; description: string; permissions: string[] }> = {
  helpdesk_l1: {
    label: "Helpdesk L1",
    description: "Basic remote support and diagnostics",
    permissions: ["view_devices", "remote_support_connect", "diagnostics", "view_notes", "view_inventory", "view_patch"],
  },
  helpdesk_l2: {
    label: "Helpdesk L2",
    description: "Helpdesk L1 + restart, maintenance, notes editing",
    permissions: [
      "view_devices", "remote_support_connect", "diagnostics", "view_notes", "edit_notes",
      "view_inventory", "view_patch", "restart_agent", "restart_device", "maintenance_mode",
    ],
  },
  server_admin: {
    label: "Server Admin",
    description: "Full operational permissions, no operator management",
    permissions: [
      "view_devices", "remote_support_connect", "remote_support_manage", "diagnostics",
      "restart_device", "restart_agent", "reinstall_remote_support", "maintenance_mode",
      "view_notes", "edit_notes", "view_inventory", "view_patch",
      "deployment", "manage_clients", "manage_groups", "audit_log",
    ],
  },
  deployment_operator: {
    label: "Deployment Operator",
    description: "Deploy packages, manage remote support software",
    permissions: ["view_devices", "deployment", "reinstall_remote_support", "restart_agent", "diagnostics", "view_inventory", "view_patch"],
  },
  readonly: {
    label: "Read Only",
    description: "View-only access to devices and data",
    permissions: ["view_devices", "view_notes", "view_inventory", "view_patch"],
  },
  custom: {
    label: "Custom",
    description: "Start with no permissions and configure manually",
    permissions: [],
  },
};

function TemplateSelector({ onSelect }: { onSelect: (perms: string[]) => void }) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <div>
      <label className={LABEL_CLS}>Permission Template <span className="text-slate-600 normal-case font-medium">(optional)</span></label>
      <div className="grid grid-cols-2 gap-1.5">
        {Object.entries(PERMISSION_TEMPLATES).map(([key, tmpl]) => (
          <button
            key={key}
            type="button"
            onClick={() => { setActive(key); onSelect(tmpl.permissions); }}
            className={`rounded-lg border px-3 py-2 text-left text-xs transition ${
              active === key
                ? "border-techi-orange/40 bg-techi-orange/10 text-orange-200"
                : "border-white/[0.08] bg-white/[0.03] text-slate-400 hover:border-white/15 hover:text-slate-200"
            }`}
          >
            <p className="font-semibold">{tmpl.label}</p>
            <p className="mt-0.5 text-[11px] leading-4 text-slate-500">{tmpl.description}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

function TeamFormFields({
  form, onChange, error,
}: {
  form: { name: string; description: string; color: string };
  onChange: (u: Partial<typeof form>) => void;
  error: string | null;
}) {
  return (
    <div className="space-y-3">
      {error && <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-2.5 text-xs font-medium text-red-100">{error}</div>}
      <div>
        <label className={LABEL_CLS}>Team name *</label>
        <input value={form.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="e.g. IT Support" className={INPUT_CLS} />
      </div>
      <div>
        <label className={LABEL_CLS}>Description</label>
        <textarea value={form.description} onChange={(e) => onChange({ description: e.target.value })} placeholder="What does this team manage?" rows={2} className={`${INPUT_CLS} resize-none`} />
      </div>
      <div>
        <label className={LABEL_CLS}>Color</label>
        <ColorPicker value={form.color} onChange={(c) => onChange({ color: c })} />
      </div>
    </div>
  );
}

const EMPTY_FORM = { name: "", description: "", color: "#E85A3C", permissions: [] as string[] };

function StatPill({ icon, count, title }: { icon: React.ReactNode; count: number; title: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[11px] font-semibold text-slate-400">
      {icon}
      {count}
    </span>
  );
}

export default function Teams() {
  const { can } = useAuth();
  const canManage = can("admin");
  const navigate = useNavigate();

  const [teams, setTeams] = useState<TeamWithStats[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ ...EMPTY_FORM });
  const [createError, setCreateError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);

  const [editTarget, setEditTarget] = useState<TeamWithStats | null>(null);
  const [editForm, setEditForm] = useState({ ...EMPTY_FORM });
  const [editError, setEditError] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<TeamWithStats | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const loadData = async () => {
    try {
      setLoading(true); setError(null);
      setTeams(await listTeams());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load teams");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadData(); }, []);

  const filtered = teams.filter(
    (t) => search === "" || t.name.toLowerCase().includes(search.toLowerCase()) || (t.description ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const handleCreate = async () => {
    const name = createForm.name.trim();
    if (!name) { setCreateError("Team name is required"); return; }
    if (teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) { setCreateError("A team with this name already exists"); return; }
    try {
      setCreateLoading(true); setCreateError(null);
      const created = await createTeam({
        name,
        description: createForm.description.trim() || null,
        color: createForm.color,
        permissions: createForm.permissions.length > 0 ? createForm.permissions : null,
      });
      setTeams((prev) => [...prev, { ...created, member_count: 0, client_count: 0, group_count: 0, explicit_device_count: 0, effective_device_count: 0 }]);
      setShowCreate(false);
      setCreateForm({ ...EMPTY_FORM });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create team");
    } finally {
      setCreateLoading(false);
    }
  };

  const openEdit = (team: TeamWithStats) => {
    setEditTarget(team);
    setEditForm({ name: team.name, description: team.description ?? "", color: team.color ?? "#E85A3C", permissions: [] });
    setEditError(null);
  };

  const handleEdit = async () => {
    if (!editTarget) return;
    const name = editForm.name.trim();
    if (!name) { setEditError("Team name is required"); return; }
    try {
      setEditLoading(true); setEditError(null);
      const updated = await updateTeam(editTarget.id, { name, description: editForm.description.trim() || null, color: editForm.color });
      setTeams((prev) => prev.map((t) => t.id === editTarget.id ? { ...updated, member_count: editTarget.member_count, client_count: editTarget.client_count, group_count: editTarget.group_count, explicit_device_count: editTarget.explicit_device_count, effective_device_count: editTarget.effective_device_count } : t));
      setEditTarget(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update team");
    } finally {
      setEditLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      setDeleteLoading(true);
      await deleteTeam(deleteTarget.id);
      setTeams((prev) => prev.filter((t) => t.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete team");
      setDeleteTarget(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <section className="premium-page space-y-5">
      {/* Header */}
      <PageHeader
        title="Teams"
        description="Group operators into teams and grant each team visibility over specific clients, device groups, or individual devices."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void loadData()} disabled={loading}>
              <RefreshCcw className="h-3.5 w-3.5" /> Refresh
            </Button>
            {canManage && (
              <Button size="sm" onClick={() => { setCreateError(null); setShowCreate(true); }}>
                <Plus className="h-3.5 w-3.5" /> New Team
              </Button>
            )}
          </>
        }
      />

      {error && <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-sm font-medium text-red-100">{error}</div>}

      {/* Table */}
      <div className="premium-card-soft overflow-hidden">
        <div className="border-b border-white/[0.08] px-5 py-3.5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <UsersRound className="h-4 w-4 text-techi-orange" />
              <h2 className="text-sm font-semibold text-white">{teams.length} team{teams.length !== 1 ? "s" : ""}</h2>
            </div>
            <div className="relative max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search teams…" className="th-input w-full rounded-lg border py-2 pl-8 pr-3 text-sm outline-none focus:border-techi-orange/60" />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Team</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Description</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Members</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Clients</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Groups</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Eff. Devices</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Created</th>
                <th className="px-5 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-0">
                    {loading ? (
                      <p className="px-5 py-10 text-center text-sm font-medium text-slate-500">Loading…</p>
                    ) : search ? (
                      <EmptyState icon={<Search className="h-5 w-5" />} title="No teams match your search" description="Try a different name." />
                    ) : (
                      <EmptyState
                        icon={<UsersRound className="h-5 w-5" />}
                        title="No teams yet"
                        description="Teams give a group of operators access to specific clients, device groups or devices."
                        action={canManage && (
                          <Button size="sm" onClick={() => { setCreateError(null); setShowCreate(true); }}>
                            <Plus className="h-3.5 w-3.5" /> New Team
                          </Button>
                        )}
                      />
                    )}
                  </td>
                </tr>
              )}
              {filtered.map((team) => (
                <tr key={team.id} className="group transition hover:bg-white/[0.02]">
                  <td className="px-5 py-3.5">
                    <button type="button" onClick={() => navigate(`/teams/${team.id}`)} className="flex items-center gap-2.5 text-left">
                      <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: team.color ?? "#E85A3C" }} />
                      <span className="font-semibold text-white group-hover:text-techi-orange transition-colors">{team.name}</span>
                      <ChevronRight className="h-3.5 w-3.5 text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  </td>
                  <td className="max-w-[180px] px-5 py-3.5">
                    <span className="line-clamp-1 text-[12px] text-slate-400">{team.description ?? <span className="text-slate-600">—</span>}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <StatPill icon={<UsersRound className="h-2.5 w-2.5" />} count={team.member_count} title="Members" />
                  </td>
                  <td className="px-5 py-3.5">
                    <StatPill icon={<Building2 className="h-2.5 w-2.5" />} count={team.client_count} title="Clients" />
                  </td>
                  <td className="px-5 py-3.5">
                    <StatPill icon={<Users className="h-2.5 w-2.5" />} count={team.group_count} title="Groups" />
                  </td>
                  <td className="px-5 py-3.5">
                    <StatPill icon={<Cpu className="h-2.5 w-2.5" />} count={team.effective_device_count} title={`Effective devices (${team.explicit_device_count} explicit)`} />
                  </td>
                  <td className="px-5 py-3.5 text-[12px] text-slate-400">
                    {parseUTC(team.created_at).toLocaleDateString("en-GB", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "short", year: "numeric" })}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center justify-end gap-1">
                      <button type="button" onClick={() => navigate(`/teams/${team.id}`)} title="Open team" className="rounded-md p-1.5 text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-200">
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                      {canManage && (
                        <>
                          <button type="button" onClick={() => openEdit(team)} title="Edit team" className="rounded-md p-1.5 text-slate-500 transition hover:bg-white/[0.06] hover:text-orange-200">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button type="button" onClick={() => setDeleteTarget(team)} title="Delete team" className="rounded-md p-1.5 text-slate-500 transition hover:bg-white/[0.06] hover:text-red-300">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <Modal title="Create Team" onClose={() => setShowCreate(false)}>
          <div className="space-y-4">
            <TeamFormFields form={createForm} onChange={(u) => setCreateForm((f) => ({ ...f, ...u }))} error={createError} />
            <TemplateSelector onSelect={(perms) => setCreateForm((f) => ({ ...f, permissions: perms }))} />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setShowCreate(false)} className="th-btn-secondary rounded-lg border px-4 py-2 text-sm font-semibold transition hover:bg-white/[0.04]">Cancel</button>
            <Button type="button" onClick={() => void handleCreate()} disabled={createLoading}>
              {createLoading ? "Creating…" : "Create Team"}
            </Button>
          </div>
        </Modal>
      )}

      {editTarget && (
        <Modal title="Edit Team" onClose={() => setEditTarget(null)}>
          <TeamFormFields form={editForm} onChange={(u) => setEditForm((f) => ({ ...f, ...u }))} error={editError} />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setEditTarget(null)} className="th-btn-secondary rounded-lg border px-4 py-2 text-sm font-semibold transition hover:bg-white/[0.04]">Cancel</button>
            <Button type="button" onClick={() => void handleEdit()} disabled={editLoading}>
              {editLoading ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmationModal
          title="Delete Team"
          confirmLabel={deleteLoading ? "Deleting" : "Delete"}
          loading={deleteLoading}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void handleDelete()}
        >
          Permanently delete team <span className="font-semibold text-white">{deleteTarget.name}</span>?{" "}
          Operators will lose the access granted through this team.
        </ConfirmationModal>
      )}
    </section>
  );
}
