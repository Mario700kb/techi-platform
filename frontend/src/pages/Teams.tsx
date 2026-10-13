import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Building2,
  ChevronRight,
  Layers,
  Monitor,
  Pencil,
  Plus,
  RefreshCcw,
  Search,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { TeamWithStats, listTeams, createTeam, updateTeam, deleteTeam } from "../api/teams";
import { Button, EmptyState, PageHeader } from "../components/ui";
import { CardHead } from "../components/ui/PanelCard";
import Modal from "../components/ui/Modal";
import TablePagination from "../components/ui/TablePagination";
import { useAuth } from "../auth/AuthContext";
import ConfirmationModal from "../components/ConfirmationModal";
import { TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { formatLocalDateTime } from "../utils/time";
import { TEAM_COLOR_PRESETS } from "../utils/teamColors";
import { useCachedQuery } from "../hooks/useCachedQuery";

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Team colour">
      {TEAM_COLOR_PRESETS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className="th-onb-swatch"
          style={{ "--swatch": c } as CSSProperties}
        />
      ))}
    </div>
  );
}

// ── Permission templates ──────────────────────────────────────────────────── //

const PERMISSION_TEMPLATES: Record<string, { label: string; description: string; permissions: string[] }> = {
  helpdesk_l1: {
    label: "Helpdesk L1",
    description: "Basic remote support and diagnostics",
    permissions: [
      "view_devices",
      "remote_support_connect",
      "diagnostics",
      "view_notes",
      "view_inventory",
      "view_patch",
    ],
  },
  helpdesk_l2: {
    label: "Helpdesk L2",
    description: "Helpdesk L1 + restart, maintenance, notes editing",
    permissions: [
      "view_devices",
      "remote_support_connect",
      "diagnostics",
      "view_notes",
      "edit_notes",
      "view_inventory",
      "view_patch",
      "restart_agent",
      "restart_device",
      "maintenance_mode",
    ],
  },
  server_admin: {
    label: "Server Admin",
    description: "Full operational permissions, no operator management",
    permissions: [
      "view_devices",
      "remote_support_connect",
      "remote_support_manage",
      "diagnostics",
      "restart_device",
      "restart_agent",
      "reinstall_remote_support",
      "maintenance_mode",
      "view_notes",
      "edit_notes",
      "view_inventory",
      "view_patch",
      "deployment",
      "manage_clients",
      "manage_groups",
      "audit_log",
    ],
  },
  deployment_operator: {
    label: "Deployment Operator",
    description: "Deploy packages, manage remote support software",
    permissions: [
      "view_devices",
      "deployment",
      "reinstall_remote_support",
      "restart_agent",
      "diagnostics",
      "view_inventory",
      "view_patch",
    ],
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
    <div className="th-onb-field">
      <span>
        Permission template <span style={{ color: "var(--th-text-faint)" }}>(optional)</span>
      </span>
      <div className="grid grid-cols-2 gap-2">
        {Object.entries(PERMISSION_TEMPLATES).map(([key, tmpl]) => (
          <button
            key={key}
            type="button"
            aria-pressed={active === key}
            onClick={() => {
              setActive(key);
              onSelect(tmpl.permissions);
            }}
            className="th-onb-option"
          >
            <span className="block text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
              {tmpl.label}
            </span>
            <span className="mt-0.5 block text-[12px] leading-4" style={{ color: "var(--th-text-muted)" }}>
              {tmpl.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TeamFormFields({
  form,
  onChange,
  error,
}: {
  form: { name: string; description: string; color: string };
  onChange: (u: Partial<typeof form>) => void;
  error: string | null;
}) {
  return (
    <>
      {error && (
        <div
          className="th-onb-note th-onb-reveal"
          style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
          role="alert"
        >
          <AlertTriangle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      )}
      <label className="th-onb-field">
        Name
        <input value={form.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="e.g. IT Support" />
      </label>
      <label className="th-onb-field">
        Description
        <textarea
          value={form.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="What does this team look after?"
          rows={2}
        />
      </label>
      <div className="th-onb-field">
        Colour
        <ColorPicker value={form.color} onChange={(c) => onChange({ color: c })} />
      </div>
    </>
  );
}

const EMPTY_FORM = { name: "", description: "", color: "#E85A3C", permissions: [] as string[] };

function Count({ value, faintWhenZero = true }: { value: number; faintWhenZero?: boolean }) {
  return (
    <span
      className="th-alerts-primary tabular-nums"
      style={value === 0 && faintWhenZero ? { color: "var(--th-text-faint)" } : undefined}
    >
      {formatCount(value)}
    </span>
  );
}

export default function Teams() {
  const { can } = useAuth();
  const canManage = can("admin");
  const navigate = useNavigate();

  const {
    data: teams = [],
    loading,
    refreshing,
    error: loadError,
    reload: loadData,
    setData,
  } = useCachedQuery("page.teams", listTeams);
  const setTeams = (update: (prev: TeamWithStats[]) => TeamWithStats[]) => setData((prev) => update(prev ?? []));
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

  useEffect(() => {
    setError(loadError);
  }, [loadError]);

  const filtered = teams.filter(
    (t) =>
      search === "" ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      (t.description ?? "").toLowerCase().includes(search.toLowerCase()),
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);
  const memberSeats = teams.reduce((sum, t) => sum + t.member_count, 0);
  const grantedClients = teams.reduce((sum, t) => sum + t.client_count, 0);
  const grantedGroups = teams.reduce((sum, t) => sum + t.group_count, 0);
  const widest = teams.reduce<TeamWithStats | null>(
    (best, t) => (!best || t.effective_device_count > best.effective_device_count ? t : best),
    null,
  );

  const handleCreate = async () => {
    const name = createForm.name.trim();
    if (!name) {
      setCreateError("Team name is required");
      return;
    }
    if (teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      setCreateError("A team with this name already exists");
      return;
    }
    try {
      setCreateLoading(true);
      setCreateError(null);
      const created = await createTeam({
        name,
        description: createForm.description.trim() || null,
        color: createForm.color,
        permissions: createForm.permissions.length > 0 ? createForm.permissions : null,
      });
      setTeams((prev) => [
        ...prev,
        {
          ...created,
          member_count: 0,
          client_count: 0,
          group_count: 0,
          explicit_device_count: 0,
          effective_device_count: 0,
        },
      ]);
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
    setEditForm({
      name: team.name,
      description: team.description ?? "",
      color: team.color ?? "#E85A3C",
      permissions: [],
    });
    setEditError(null);
  };

  const handleEdit = async () => {
    if (!editTarget) return;
    const name = editForm.name.trim();
    if (!name) {
      setEditError("Team name is required");
      return;
    }
    try {
      setEditLoading(true);
      setEditError(null);
      const updated = await updateTeam(editTarget.id, {
        name,
        description: editForm.description.trim() || null,
        color: editForm.color,
      });
      setTeams((prev) =>
        prev.map((t) =>
          t.id === editTarget.id
            ? {
                ...updated,
                member_count: editTarget.member_count,
                client_count: editTarget.client_count,
                group_count: editTarget.group_count,
                explicit_device_count: editTarget.explicit_device_count,
                effective_device_count: editTarget.effective_device_count,
              }
            : t,
        ),
      );
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
    <section className="premium-page th-onb space-y-4">
      <PageHeader
        title="Teams"
        description="Teams group operators and grant them visibility over clients, device groups or single devices."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void loadData()} disabled={refreshing}>
              <RefreshCcw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {canManage && (
              <Button
                size="sm"
                onClick={() => {
                  setCreateError(null);
                  setShowCreate(true);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                New team
              </Button>
            )}
          </>
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
            label: "Teams",
            value: formatCount(teams.length),
            hint: `${formatCount(memberSeats)} memberships`,
            icon: UsersRound,
            tone: "var(--th-accent)",
          },
          {
            label: "Clients granted",
            value: formatCount(grantedClients),
            hint: "Whole clients, across teams",
            icon: Building2,
            tone: TONE.info,
          },
          {
            label: "Groups granted",
            value: formatCount(grantedGroups),
            hint: "Device groups, across teams",
            icon: Layers,
            tone: TONE.maintenance,
          },
          {
            label: "Widest reach",
            value: widest ? formatCount(widest.effective_device_count) : "—",
            hint: widest ? `${widest.name} · devices` : "No teams yet",
            icon: Monitor,
            tone: TONE.online,
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

      {/* ── teams ───────────────────────────────────────────────────────── */}
      <div className="th-alerts-card th-onb-tokens th-onb-enter" style={{ "--i": 4 } as CSSProperties}>
        <CardHead
          icon={UsersRound}
          tone="var(--th-accent)"
          title="Teams"
          subtitle={
            loading
              ? "Loading…"
              : `${formatCount(teams.length)} team${teams.length === 1 ? "" : "s"} · open one to manage its members and access`
          }
          aside={
            <div className="w-[260px] flex-none">
              <label className="th-search th-search-sm">
                <Search className="h-3.5 w-3.5 flex-none" />
                <input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search teams"
                  aria-label="Search teams"
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
          }
        />

        {loading ? (
          <div className="th-alerts-scroll" aria-busy="true" aria-label="Loading teams">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.15 }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          search ? (
            <EmptyState
              className="th-fade-in py-10"
              icon={<Search className="h-5 w-5" />}
              title="No teams match your search"
              action={
                <Button size="sm" variant="secondary" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <EmptyState
              className="th-fade-in py-10"
              icon={<UsersRound className="h-5 w-5" />}
              title="No teams yet"
              description="Teams give a group of operators access to specific clients, device groups or devices."
              action={
                canManage ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setCreateError(null);
                      setShowCreate(true);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New team
                  </Button>
                ) : undefined
              }
            />
          )
        ) : (
          <div className="th-alerts-scroll th-table-scroll">
            <table className="th-alerts-table">
              <colgroup>
                <col />
                <col className="w-[110px]" />
                <col className="w-[110px]" />
                <col className="w-[110px]" />
                <col className="w-[150px]" />
                <col className="w-[130px]" />
                <col className="w-[112px]" />
              </colgroup>
              <thead>
                <tr>
                  <th>Team</th>
                  <th className="text-right">Members</th>
                  <th className="text-right">Clients</th>
                  <th className="text-right">Groups</th>
                  <th className="text-right">Devices reached</th>
                  <th>Created</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((team, index) => (
                  <tr
                    key={team.id}
                    className="th-alerts-row"
                    data-clickable="true"
                    style={{ "--row": index, "--row-tone": team.color ?? undefined } as CSSProperties}
                    onClick={() => navigate(`/teams/${team.id}`)}
                  >
                    <td>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span
                          className="th-onb-dot"
                          style={{ "--swatch": team.color ?? "var(--th-accent)" } as CSSProperties}
                          aria-hidden="true"
                        />
                        <span className="min-w-0">
                          <span className="th-alerts-primary">{team.name}</span>
                          <span className="th-alerts-secondary">{team.description || "No description"}</span>
                        </span>
                      </span>
                    </td>
                    <td className="text-right">
                      <Count value={team.member_count} />
                    </td>
                    <td className="text-right">
                      <Count value={team.client_count} />
                    </td>
                    <td className="text-right">
                      <Count value={team.group_count} />
                    </td>
                    <td className="text-right">
                      <Count value={team.effective_device_count} />
                      {team.explicit_device_count > 0 && (
                        <span className="th-alerts-secondary">
                          {formatCount(team.explicit_device_count)} granted one by one
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="th-alerts-secondary !mt-0 tabular-nums">
                        {formatLocalDateTime(team.created_at, { day: "numeric", month: "short", year: "numeric" })}
                      </span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="th-onb-actions">
                        <button
                          type="button"
                          className="th-onb-action"
                          onClick={() => navigate(`/teams/${team.id}`)}
                          title="Open team"
                          aria-label={`Open ${team.name}`}
                        >
                          <ChevronRight className="h-4 w-4" />
                        </button>
                        {canManage && (
                          <>
                            <button
                              type="button"
                              className="th-onb-action"
                              onClick={() => openEdit(team)}
                              title="Edit"
                              aria-label={`Edit ${team.name}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              className="th-onb-action"
                              data-tone="danger"
                              onClick={() => setDeleteTarget(team)}
                              title="Delete"
                              aria-label={`Delete ${team.name}`}
                            >
                              <Trash2 className="h-4 w-4" />
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
        )}

        {filtered.length > 0 && (
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={filtered.length}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            pageSizeOptions={[25, 50, 100]}
            itemLabel="teams"
          />
        )}
      </div>

      {showCreate && (
        <Modal
          title="New team"
          subtitle="Add members and access after creating it"
          icon={UsersRound}
          size="lg"
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <Button variant="secondary" type="button" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleCreate()} disabled={createLoading}>
                {createLoading ? "Creating…" : "Create team"}
              </Button>
            </>
          }
        >
          <TeamFormFields
            form={createForm}
            onChange={(u) => setCreateForm((f) => ({ ...f, ...u }))}
            error={createError}
          />
          <TemplateSelector onSelect={(perms) => setCreateForm((f) => ({ ...f, permissions: perms }))} />
        </Modal>
      )}

      {editTarget && (
        <Modal
          title="Edit team"
          subtitle={editTarget.name}
          icon={Pencil}
          onClose={() => setEditTarget(null)}
          footer={
            <>
              <Button variant="secondary" type="button" onClick={() => setEditTarget(null)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleEdit()} disabled={editLoading}>
                {editLoading ? "Saving…" : "Save changes"}
              </Button>
            </>
          }
        >
          <TeamFormFields form={editForm} onChange={(u) => setEditForm((f) => ({ ...f, ...u }))} error={editError} />
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmationModal
          title="Delete team"
          confirmLabel={deleteLoading ? "Deleting" : "Delete"}
          loading={deleteLoading}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void handleDelete()}
        >
          Permanently delete team{" "}
          <span className="font-semibold" style={{ color: "var(--th-text-primary)" }}>
            {deleteTarget.name}
          </span>
          ? Operators lose the access granted through it.
        </ConfirmationModal>
      )}
    </section>
  );
}
