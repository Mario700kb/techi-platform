import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  AlertTriangle,
  KeySquare,
  Pencil,
  Plus,
  Power,
  RefreshCcw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { appCache, CACHE_KEYS, CACHE_TTL } from "../store/appCache";
import {
  OperatorRecord,
  OperatorCreate,
  OperatorUpdate,
  createOperator,
  deleteOperator,
  getOperators,
  resetOperatorPassword,
  updateOperator,
} from "../api/operators";
import { listTeams, TeamWithStats } from "../api/teams";
import { UserRole } from "../api/auth";
import { Button, EmptyState, PageHeader, Select } from "../components/ui";
import { CardHead } from "../components/ui/PanelCard";
import Modal from "../components/ui/Modal";
import TablePagination from "../components/ui/TablePagination";
import { useAuth } from "../auth/AuthContext";
import { useTabIndicator } from "../hooks/useTabIndicator";
import ConfirmationModal from "../components/ConfirmationModal";
import { TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { formatLocalDateTime, timeAgo } from "../utils/time";

const ROLES: UserRole[] = ["owner", "admin", "operator"];

const ROLE_INFO: Record<UserRole, { label: string; tone: string; hint: string }> = {
  owner: { label: "Owner", tone: "var(--th-accent)", hint: "Everything, including operators and teams" },
  admin: { label: "Admin", tone: TONE.warning, hint: "Manages devices, clients and deployment" },
  operator: { label: "Operator", tone: TONE.info, hint: "Works on the devices their teams reach" },
  readonly: { label: "Read-only", tone: TONE.neutral, hint: "Views only" },
};

type OperatorFilter = "all" | "privileged" | "operator" | "inactive";

const OPERATOR_FILTERS: { id: OperatorFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "privileged", label: "Owners & admins" },
  { id: "operator", label: "Operators" },
  { id: "inactive", label: "Inactive" },
];

function matchesFilter(op: OperatorRecord, filter: OperatorFilter): boolean {
  if (filter === "privileged") return op.role === "owner" || op.role === "admin";
  if (filter === "operator") return op.role === "operator" || op.role === "readonly";
  if (filter === "inactive") return !op.is_active;
  return true;
}

function RoleChip({ role }: { role: UserRole }) {
  const info = ROLE_INFO[role];
  return (
    <span className="th-status-chip" style={{ "--chip-tone": info.tone } as CSSProperties}>
      <Shield className="h-3 w-3" style={{ color: info.tone }} />
      {info.label}
    </span>
  );
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      className="th-onb-note th-onb-reveal"
      style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
      role="alert"
    >
      <AlertTriangle className="h-4 w-4" />
      <span>{message}</span>
    </div>
  );
}

export default function Operators() {
  const { user, can } = useAuth();
  const canManage = can("admin");

  const [operators, setOperators] = useState<OperatorRecord[]>(
    () => appCache.peek<OperatorRecord[]>(CACHE_KEYS.operatorsList) ?? [],
  );
  const [teams, setTeams] = useState<TeamWithStats[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const teamsForOperator = (opId: number): TeamWithStats[] => teams.filter((t) => t.operator_ids?.includes(opId));

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<OperatorCreate>({
    username: "",
    email: "",
    display_name: "",
    password: "",
    role: "operator",
    is_active: true,
  });
  const [createError, setCreateError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);

  const [editTarget, setEditTarget] = useState<OperatorRecord | null>(null);
  const [editForm, setEditForm] = useState<OperatorUpdate>({});
  const [editError, setEditError] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);

  const [passwordTarget, setPasswordTarget] = useState<OperatorRecord | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordLoading, setPasswordLoading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<OperatorRecord | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const [filter, setFilter] = useState<OperatorFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const filterTabsRef = useTabIndicator<HTMLDivElement>(filter);

  const loadData = async (force = false) => {
    if (!force && appCache.get(CACHE_KEYS.operatorsList, CACHE_TTL.operatorsList)) return;
    try {
      setLoading(true);
      setError(null);
      const [ops, tms] = await Promise.all([getOperators(), listTeams()]);
      appCache.set(CACHE_KEYS.operatorsList, ops);
      setOperators(ops);
      setTeams(tms);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load operators");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const activePrivilegedCount = operators.filter(
    (op) => op.is_active && (op.role === "owner" || op.role === "admin"),
  ).length;

  const isLastActivePrivileged = (op: OperatorRecord) =>
    op.is_active && (op.role === "owner" || op.role === "admin") && activePrivilegedCount <= 1;

  const canEditRole = (_targetRole: UserRole) => canManage;

  const handleCreate = async () => {
    const username = createForm.username.trim();
    const email = createForm.email.trim();
    const displayName = createForm.display_name?.trim() ?? "";
    const password = createForm.password;
    if (!username || !email || !displayName || !password || !createForm.role) {
      setCreateError("Username, display name, email, password, and role are required");
      return;
    }
    if (password.length < 8) {
      setCreateError("Password must be at least 8 characters");
      return;
    }
    if (password.trim() !== password) {
      setCreateError("Password cannot start or end with spaces");
      return;
    }
    if (operators.some((op) => op.username.toLowerCase() === username.toLowerCase())) {
      setCreateError("Username already exists");
      return;
    }
    try {
      setCreateLoading(true);
      setCreateError(null);
      const created = await createOperator({
        ...createForm,
        username,
        email,
        display_name: displayName,
      });
      setOperators((prev) => {
        const next = [...prev, created];
        appCache.set(CACHE_KEYS.operatorsList, next);
        return next;
      });
      setShowCreate(false);
      setCreateForm({ username: "", email: "", display_name: "", password: "", role: "operator", is_active: true });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create operator");
    } finally {
      setCreateLoading(false);
    }
  };

  const openEdit = (op: OperatorRecord) => {
    setEditTarget(op);
    setEditForm({
      username: op.username,
      email: op.email,
      display_name: op.display_name ?? "",
      role: op.role === "readonly" ? "operator" : op.role,
      is_active: op.is_active,
    });
    setEditError(null);
  };

  const handleEdit = async () => {
    if (!editTarget) return;
    const nextRole = editForm.role ?? editTarget.role;
    if (isLastActivePrivileged(editTarget) && nextRole !== "owner" && nextRole !== "admin") {
      setEditError("Cannot remove the last active owner/admin capable account");
      return;
    }
    try {
      setEditLoading(true);
      setEditError(null);
      const updated = await updateOperator(editTarget.id, {
        ...editForm,
        display_name: editForm.display_name || null,
      });
      setOperators((prev) => {
        const next = prev.map((o) => (o.id === updated.id ? updated : o));
        appCache.set(CACHE_KEYS.operatorsList, next);
        return next;
      });
      setEditTarget(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update operator");
    } finally {
      setEditLoading(false);
    }
  };

  const handleToggleActive = async (op: OperatorRecord) => {
    if (op.is_active && isLastActivePrivileged(op)) {
      setError("Cannot deactivate the last active owner/admin capable account");
      return;
    }
    try {
      setError(null);
      const updated = await updateOperator(op.id, { is_active: !op.is_active });
      setOperators((prev) => {
        const next = prev.map((o) => (o.id === updated.id ? updated : o));
        appCache.set(CACHE_KEYS.operatorsList, next);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    }
  };

  const handlePasswordReset = async () => {
    if (!passwordTarget || !newPassword.trim()) return;
    try {
      setPasswordLoading(true);
      setPasswordError(null);
      await resetOperatorPassword(passwordTarget.id, { new_password: newPassword });
      setPasswordTarget(null);
      setNewPassword("");
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Failed to reset password");
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    if (isLastActivePrivileged(deleteTarget)) {
      setError("Cannot delete the last active owner/admin capable account");
      setDeleteTarget(null);
      return;
    }
    try {
      setDeleteLoading(true);
      await deleteOperator(deleteTarget.id);
      setOperators((prev) => {
        const next = prev.filter((o) => o.id !== deleteTarget.id);
        appCache.set(CACHE_KEYS.operatorsList, next);
        return next;
      });
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete operator");
      setDeleteTarget(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const availableRoles = (): UserRole[] => {
    return canManage ? ROLES : ["operator"];
  };
  const roleOptions = availableRoles().map((r) => ({ value: r, label: ROLE_INFO[r].label, hint: ROLE_INFO[r].hint }));

  const filterCounts = useMemo(() => {
    const counts = { all: 0, privileged: 0, operator: 0, inactive: 0 } as Record<OperatorFilter, number>;
    for (const op of operators) for (const f of OPERATOR_FILTERS) if (matchesFilter(op, f.id)) counts[f.id] += 1;
    return counts;
  }, [operators]);
  const visibleOperators = useMemo(() => {
    const q = search.trim().toLowerCase();
    return operators.filter((op) => {
      if (!matchesFilter(op, filter)) return false;
      if (!q) return true;
      const teamNames = teamsForOperator(op.id)
        .map((t) => t.name)
        .join(" ");
      return [op.display_name ?? "", op.username, op.email, op.role, teamNames].some((v) =>
        v.toLowerCase().includes(q),
      );
    });
  }, [operators, filter, search, teams]); // eslint-disable-line react-hooks/exhaustive-deps
  const pagedOperators = useMemo(
    () => visibleOperators.slice((page - 1) * pageSize, page * pageSize),
    [visibleOperators, page, pageSize],
  );
  const activeCount = operators.filter((op) => op.is_active).length;
  const neverLoggedIn = operators.filter((op) => !op.last_login_at).length;
  const denied = /Permission denied|Insufficient role/.test(error ?? "");

  if (denied) {
    return (
      <section className="premium-page th-onb space-y-4">
        <PageHeader title="Operators" description="Platform users, their roles and their access." />
        <div className="th-onb-card th-onb-enter">
          <EmptyState
            icon={<ShieldAlert className="h-5 w-5" />}
            title="Access denied"
            description="Your role does not include managing operators."
          />
        </div>
      </section>
    );
  }

  return (
    <section className="premium-page th-onb space-y-4">
      <PageHeader
        title="Operators"
        description="Platform users, their roles and their access."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void loadData(true)} disabled={loading}>
              <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
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
                Add operator
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
            label: "Operators",
            value: formatCount(operators.length),
            hint: `${formatCount(teams.length)} teams`,
            icon: Users,
            tone: "var(--th-accent)",
          },
          {
            label: "Active",
            value: formatCount(activeCount),
            hint: `${formatCount(operators.length - activeCount)} inactive`,
            icon: UserCheck,
            tone: TONE.online,
          },
          {
            label: "Owners & admins",
            value: formatCount(filterCounts.privileged),
            hint: `${formatCount(activePrivilegedCount)} active`,
            icon: ShieldCheck,
            tone: TONE.warning,
          },
          {
            label: "Never signed in",
            value: formatCount(neverLoggedIn),
            hint: neverLoggedIn ? "Created but not used yet" : "Everyone has signed in",
            icon: UserPlus,
            tone: neverLoggedIn ? TONE.info : TONE.neutral,
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

      {/* ── operators ───────────────────────────────────────────────────── */}
      <div className="th-alerts-card th-onb-tokens th-onb-enter" style={{ "--i": 4 } as CSSProperties}>
        <CardHead
          icon={Users}
          tone="var(--th-accent)"
          title="Operators"
          subtitle={loading && operators.length === 0 ? "Loading…" : `${formatCount(operators.length)} accounts`}
        />
        <div className="th-alerts-toolbar">
          <div ref={filterTabsRef} role="tablist" aria-label="Operator role" className="th-tabs">
            {OPERATOR_FILTERS.map(({ id, label }) => (
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
                <span className="th-tab-count">{formatCount(filterCounts[id])}</span>
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
        </div>

        {loading && operators.length === 0 ? (
          <div className="th-alerts-scroll" aria-busy="true" aria-label="Loading operators">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.12 }} />
            ))}
          </div>
        ) : visibleOperators.length === 0 ? (
          <EmptyState
            className="th-fade-in py-10"
            icon={<Users className="h-5 w-5" />}
            title={operators.length === 0 ? "No operators yet" : "No operators match these filters"}
            action={
              operators.length > 0 ? (
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
            <table className="th-alerts-table">
              <colgroup>
                <col />
                <col className="w-[120px]" />
                <col className="w-[110px]" />
                <col className="w-[20%]" />
                <col className="w-[160px]" />
                <col className="w-[120px]" />
                {canManage && <col className="w-[148px]" />}
              </colgroup>
              <thead>
                <tr>
                  <th>Operator</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Teams</th>
                  <th>Last sign-in</th>
                  <th>Created</th>
                  {canManage && <th className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {pagedOperators.map((op, index) => {
                  const isSelf = op.id === user?.id;
                  const lastPrivileged = isLastActivePrivileged(op);
                  const displayLabel = op.display_name || op.username;
                  const opTeams = teamsForOperator(op.id);
                  const lockReason = isSelf
                    ? "You cannot do this to your own account"
                    : lastPrivileged
                      ? "The last active owner or admin must stay"
                      : undefined;
                  return (
                    <tr
                      key={op.id}
                      className="th-alerts-row"
                      data-selected={isSelf || undefined}
                      style={{ "--row": index } as CSSProperties}
                    >
                      <td>
                        <span className="flex min-w-0 items-center gap-2.5">
                          <span className="th-onb-avatar !h-8 !w-8 !text-[12px]" aria-hidden="true">
                            {displayLabel.charAt(0).toUpperCase()}
                          </span>
                          <span className="min-w-0">
                            <span className="th-alerts-primary flex items-center gap-1.5">
                              <span className="truncate">{displayLabel}</span>
                              {isSelf && (
                                <span
                                  className="th-status-chip !h-5 !px-2 !text-[11px]"
                                  style={{ "--chip-tone": "var(--th-accent)" } as CSSProperties}
                                >
                                  You
                                </span>
                              )}
                            </span>
                            <span className="th-alerts-secondary">
                              <span className="font-mono">{op.username}</span>
                              {op.email ? ` · ${op.email}` : ""}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td>
                        <RoleChip role={op.role} />
                      </td>
                      <td>
                        <span
                          className="th-status-chip"
                          style={{ "--chip-tone": op.is_active ? TONE.online : TONE.neutral } as CSSProperties}
                        >
                          <i />
                          {op.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td>
                        {opTeams.length === 0 ? (
                          <span className="th-alerts-secondary">No team</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {opTeams.map((team) => (
                              <span
                                key={team.id}
                                className="th-status-chip !h-6"
                                style={{ "--chip-tone": team.color ?? "var(--th-accent)" } as CSSProperties}
                              >
                                <i />
                                {team.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        {op.last_login_at ? (
                          <>
                            <span className="th-alerts-primary">{timeAgo(op.last_login_at)}</span>
                            <span className="th-alerts-secondary tabular-nums">
                              {formatLocalDateTime(op.last_login_at)}
                            </span>
                          </>
                        ) : (
                          <span className="th-alerts-secondary">Never</span>
                        )}
                      </td>
                      <td>
                        <span className="th-alerts-secondary !mt-0 tabular-nums">
                          {formatLocalDateTime(op.created_at, { day: "numeric", month: "short", year: "numeric" })}
                        </span>
                      </td>
                      {canManage && (
                        <td>
                          <div className="th-onb-actions">
                            <button
                              type="button"
                              className="th-onb-action"
                              onClick={() => openEdit(op)}
                              title="Edit"
                              aria-label={`Edit ${displayLabel}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              className="th-onb-action"
                              onClick={() => {
                                setPasswordTarget(op);
                                setNewPassword("");
                                setPasswordError(null);
                              }}
                              title="Reset password"
                              aria-label={`Reset password for ${displayLabel}`}
                            >
                              <KeySquare className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              className="th-onb-action"
                              data-active={op.is_active || undefined}
                              onClick={() => void handleToggleActive(op)}
                              disabled={isSelf || (op.is_active && lastPrivileged)}
                              title={
                                isSelf || (op.is_active && lastPrivileged)
                                  ? lockReason
                                  : op.is_active
                                    ? "Deactivate"
                                    : "Activate"
                              }
                              aria-label={`${op.is_active ? "Deactivate" : "Activate"} ${displayLabel}`}
                            >
                              <Power className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              className="th-onb-action"
                              data-tone="danger"
                              onClick={() => setDeleteTarget(op)}
                              disabled={isSelf || lastPrivileged}
                              title={lockReason ?? "Delete"}
                              aria-label={`Delete ${displayLabel}`}
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

        {visibleOperators.length > 0 && (
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={visibleOperators.length}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            pageSizeOptions={[25, 50, 100]}
            itemLabel="operators"
          />
        )}
      </div>

      {showCreate && (
        <Modal
          title="Add operator"
          subtitle="They sign in with the username and password set here"
          icon={UserPlus}
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <Button variant="secondary" type="button" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleCreate()} disabled={createLoading}>
                {createLoading ? "Creating…" : "Create operator"}
              </Button>
            </>
          }
        >
          <FormError message={createError} />
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="th-onb-field">
              Display name
              <input
                value={createForm.display_name ?? ""}
                onChange={(e) => setCreateForm((f) => ({ ...f, display_name: e.target.value }))}
                placeholder="Full name"
              />
            </label>
            <label className="th-onb-field">
              Username
              <input
                value={createForm.username}
                onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))}
                placeholder="login name"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          </div>
          <label className="th-onb-field">
            Email
            <input
              type="email"
              value={createForm.email}
              onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="user@example.com"
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="th-onb-field">
              Password
              <input
                type="password"
                value={createForm.password}
                onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="At least 8 characters"
                autoComplete="new-password"
              />
            </label>
            <div className="th-onb-field">
              Role
              <Select
                id="create-role"
                aria-label="Role"
                value={createForm.role}
                onChange={(value) => setCreateForm((f) => ({ ...f, role: value as UserRole }))}
                options={roleOptions}
              />
            </div>
          </div>
          <label className="th-onb-check">
            <input
              type="checkbox"
              checked={createForm.is_active}
              onChange={(e) => setCreateForm((f) => ({ ...f, is_active: e.target.checked }))}
            />
            <span>
              Active<small>Inactive accounts cannot sign in</small>
            </span>
          </label>
        </Modal>
      )}

      {editTarget && (
        <Modal
          title="Edit operator"
          subtitle={editTarget.display_name ?? editTarget.username}
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
          <FormError message={editError} />
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="th-onb-field">
              Display name
              <input
                value={editForm.display_name ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, display_name: e.target.value }))}
                placeholder="Full name (optional)"
              />
            </label>
            <label className="th-onb-field">
              Username
              <input
                value={editForm.username ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, username: e.target.value }))}
                id="edit-username"
                aria-label="Username"
                spellCheck={false}
              />
            </label>
          </div>
          <label className="th-onb-field">
            Email
            <input
              type="email"
              value={editForm.email ?? ""}
              onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
              id="edit-email"
              aria-label="Email"
            />
          </label>
          <div className="th-onb-field">
            Role
            <Select
              id="edit-role"
              aria-label="Role"
              value={editForm.role ?? editTarget.role}
              onChange={(value) => setEditForm((f) => ({ ...f, role: value as UserRole }))}
              options={roleOptions}
              disabled={!canEditRole(editTarget.role)}
            />
            <span className="th-onb-hint">{ROLE_INFO[(editForm.role ?? editTarget.role) as UserRole].hint}.</span>
          </div>
        </Modal>
      )}

      {passwordTarget && (
        <Modal
          title="Reset password"
          subtitle={passwordTarget.display_name ?? passwordTarget.username}
          icon={KeySquare}
          onClose={() => setPasswordTarget(null)}
          footer={
            <>
              <Button variant="secondary" type="button" onClick={() => setPasswordTarget(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void handlePasswordReset()}
                disabled={passwordLoading || newPassword.length < 8}
              >
                {passwordLoading ? "Updating…" : "Update password"}
              </Button>
            </>
          }
        >
          <FormError message={passwordError} />
          <label className="th-onb-field">
            New password for <span className="font-mono">{passwordTarget.username}</span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
          </label>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmationModal
          title="Delete operator"
          confirmLabel={deleteLoading ? "Deleting" : "Delete"}
          loading={deleteLoading}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void handleDelete()}
        >
          Permanently delete{" "}
          <span className="font-semibold" style={{ color: "var(--th-text-primary)" }}>
            {deleteTarget.display_name ?? deleteTarget.username}
          </span>
          ? This cannot be undone.
        </ConfirmationModal>
      )}
    </section>
  );
}
