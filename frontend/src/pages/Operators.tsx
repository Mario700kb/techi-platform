import { useEffect, useState } from "react";
import { appCache, CACHE_KEYS, CACHE_TTL } from "../store/appCache";
import { KeySquare, Pencil, Plus, RefreshCcw, Shield, Trash2, Users, UsersRound, X } from "lucide-react";
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
import { Button, PageHeader, SelectField } from "../components/ui";
import { useAuth } from "../auth/AuthContext";
import { APP_TIME_ZONE, parseUTC } from "../utils/time";
import ConfirmationModal from "../components/ConfirmationModal";

const ROLES: UserRole[] = ["owner", "admin", "operator"];

const roleBadgeClass: Record<UserRole, string> = {
  owner: "th-btn-primary border-orange-300/25 bg-gradient-to-r from-techi-orange to-techi-pink text-white",
  admin: "border-red-300/25 bg-techi-pink/15 text-red-100",
  operator: "border-white/[0.12] bg-white/[0.07] text-slate-100",
  readonly: "border-slate-500/50 bg-slate-500/10 text-slate-300",
};

const statusBadgeClass = {
  active: "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300",
  inactive: "border-slate-500/30 bg-slate-800/60 text-slate-400",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return parseUTC(iso).toLocaleDateString("en-GB", { timeZone: APP_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "Never";
  return parseUTC(iso).toLocaleString("en-GB", { timeZone: APP_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex min-h-dvh items-center justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="th-elevated w-full max-w-md rounded-xl border p-5 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 transition hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function Operators() {
  const { user, can } = useAuth();
  const canManage = can("admin");

  const [operators, setOperators] = useState<OperatorRecord[]>(() => appCache.peek<OperatorRecord[]>(CACHE_KEYS.operatorsList) ?? []);
  const [teams, setTeams] = useState<TeamWithStats[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const teamsForOperator = (opId: number): TeamWithStats[] =>
    teams.filter((t) => t.operator_ids?.includes(opId));

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

  const activePrivilegedCount = operators.filter((op) => op.is_active && (op.role === "owner" || op.role === "admin")).length;

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
      setOperators((prev) => { const next = [...prev, created]; appCache.set(CACHE_KEYS.operatorsList, next); return next; });
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
      setOperators((prev) => { const next = prev.map((o) => (o.id === updated.id ? updated : o)); appCache.set(CACHE_KEYS.operatorsList, next); return next; });
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
      setOperators((prev) => { const next = prev.map((o) => (o.id === updated.id ? updated : o)); appCache.set(CACHE_KEYS.operatorsList, next); return next; });
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
      setOperators((prev) => { const next = prev.filter((o) => o.id !== deleteTarget.id); appCache.set(CACHE_KEYS.operatorsList, next); return next; });
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

  return (
    <section className="premium-page space-y-5">
      <PageHeader
        title="Operators"
        description="Manage platform users, roles, and access permissions."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void loadData(true)} disabled={loading}>
              <RefreshCcw className="h-3.5 w-3.5" />
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
                Add User
              </Button>
            )}
          </>
        }
      />

      {error && !/Permission denied|Insufficient role/.test(error) && (
        <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-sm font-medium text-red-100">
          {error}
        </div>
      )}

      {error && /Permission denied|Insufficient role/.test(error) && (
        <div className="rounded-lg border border-amber-400/15 bg-amber-500/[0.06] px-5 py-6 text-center">
          <p className="text-sm font-semibold text-amber-300">Access Denied</p>
          <p className="mt-1 text-xs text-slate-400">You don't have permission to manage operators.</p>
        </div>
      )}

      {!/Permission denied|Insufficient role/.test(error ?? "") && (
      <div className="premium-card-soft overflow-hidden">
        <div className="border-b border-white/[0.08] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-techi-orange" />
            <h2 className="text-sm font-semibold text-white">
              {operators.length} operator{operators.length !== 1 ? "s" : ""}
            </h2>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Name</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Username</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Role</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Status</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Teams</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Last Login</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Created</th>
                <th className="px-5 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {operators.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-center text-sm font-medium text-slate-500">
                    {loading ? "Loading…" : "No operators found."}
                  </td>
                </tr>
              )}
              {operators.map((op) => {
                const isSelf = op.id === user?.id;
                const canEdit = canEditRole(op.role);
                const displayLabel = op.display_name || op.username;
                return (
                  <tr key={op.id} className={`transition hover:bg-white/[0.02] ${isSelf ? "bg-techi-orange/[0.03]" : ""}`}>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white">{displayLabel}</span>
                        {isSelf && (
                          <span className="rounded-full border border-techi-orange/30 bg-techi-orange/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-techi-orange">
                            you
                          </span>
                        )}
                      </div>
                      {op.display_name && (
                        <p className="mt-0.5 text-[11px] font-medium text-slate-500">{op.email}</p>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="font-mono text-[13px] text-slate-300">{op.username}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${roleBadgeClass[op.role]}`}
                      >
                        <Shield className="h-2.5 w-2.5" />
                        {op.role}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                          op.is_active ? statusBadgeClass.active : statusBadgeClass.inactive
                        }`}
                      >
                        {op.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex flex-wrap gap-1">
                        {teamsForOperator(op.id).length === 0 ? (
                          <span className="text-[11px] text-slate-600">—</span>
                        ) : (
                          teamsForOperator(op.id).map((team) => (
                            <span key={team.id} className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[11px] font-semibold text-slate-300">
                              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: team.color ?? "var(--th-accent)" }} />
                              {team.name}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-[12px] text-slate-400">
                      {formatDateTime(op.last_login_at)}
                    </td>
                    <td className="px-5 py-3.5 text-[12px] text-slate-400">
                      {formatDate(op.created_at)}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-1">
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => openEdit(op)}
                            title="Edit operator"
                            className="rounded-md p-1.5 text-slate-500 transition hover:bg-white/[0.06] hover:text-orange-200"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => {
                              setPasswordTarget(op);
                              setNewPassword("");
                              setPasswordError(null);
                            }}
                            title="Reset password"
                            className="rounded-md p-1.5 text-slate-500 transition hover:bg-white/[0.06] hover:text-blue-300"
                          >
                            <KeySquare className="h-3.5 w-3.5" />
                          </button>
                        )}
                      {canEdit && !isSelf && (
                          <button
                            type="button"
                            onClick={() => void handleToggleActive(op)}
                            title={op.is_active ? "Deactivate" : "Activate"}
                            disabled={op.is_active && isLastActivePrivileged(op)}
                            className={`rounded-md p-1.5 text-[11px] font-bold transition hover:bg-white/[0.06] ${
                              op.is_active && isLastActivePrivileged(op)
                              ? "cursor-not-allowed text-slate-500 opacity-60"
                                : op.is_active
                                ? "text-slate-500 hover:text-amber-300"
                                : "text-emerald-500 hover:text-emerald-300"
                            }`}
                          >
                            {op.is_active ? "Deact." : "Act."}
                          </button>
                        )}
                        {canEdit && !isSelf && (
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(op)}
                            title="Delete operator"
                            disabled={isLastActivePrivileged(op)}
                            className={`rounded-md p-1.5 transition hover:bg-white/[0.06] ${
                              isLastActivePrivileged(op)
                                ? "cursor-not-allowed text-slate-500 opacity-60"
                                : "text-slate-500 hover:text-red-300"
                            }`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
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
      </div>
      )}

      {showCreate && (
        <Modal title="Add Operator" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            {createError && (
              <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-2.5 text-xs font-medium text-red-100">
                {createError}
              </div>
            )}
            <div>
              <label className={LABEL_CLS}>Display name *</label>
              <input
                value={createForm.display_name ?? ""}
                onChange={(e) => setCreateForm((f) => ({ ...f, display_name: e.target.value }))}
                placeholder="Full name"
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Username *</label>
              <input
                value={createForm.username}
                onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))}
                placeholder="login_name"
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Email *</label>
              <input
                type="email"
                value={createForm.email}
                onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="user@example.com"
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Password *</label>
              <input
                type="password"
                value={createForm.password}
                onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="Min. 8 characters"
                className={INPUT_CLS}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Role *</label>
              <SelectField
                value={createForm.role}
                onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value as UserRole }))}
                id="create-role"
                name="create-role"
                aria-label="Role"
                className={INPUT_CLS}
              >
                {availableRoles().map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </SelectField>
            </div>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm font-semibold text-slate-200">
              <span>Enabled</span>
              <input
                type="checkbox"
                checked={createForm.is_active}
                onChange={(e) => setCreateForm((f) => ({ ...f, is_active: e.target.checked }))}
                className="h-4 w-4 rounded border-white/15 accent-orange-500"
              />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="th-btn-secondary rounded-lg border px-4 py-2 text-sm font-semibold transition hover:bg-white/[0.04]"
              >
                Cancel
              </button>
              <Button type="button" onClick={handleCreate} disabled={createLoading}>
                {createLoading ? "Creating…" : "Create User"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {editTarget && (
        <Modal title="Edit Operator" onClose={() => setEditTarget(null)}>
          <div className="space-y-3">
            {editError && (
              <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-2.5 text-xs font-medium text-red-100">
                {editError}
              </div>
            )}
            <div>
              <label className={LABEL_CLS}>Display name</label>
              <input
                value={editForm.display_name ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, display_name: e.target.value }))}
                placeholder="Full name (optional)"
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Username</label>
              <input
                value={editForm.username ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, username: e.target.value }))}
                id="edit-username"
                name="edit-username"
                aria-label="Username"
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Email</label>
              <input
                type="email"
                value={editForm.email ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                id="edit-email"
                name="edit-email"
                aria-label="Email"
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Role</label>
              <SelectField
                value={editForm.role ?? editTarget.role}
                onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value as UserRole }))}
                id="edit-role"
                name="edit-role"
                aria-label="Role"
                className={INPUT_CLS}
                disabled={!canEditRole(editTarget.role)}
              >
                {availableRoles().map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </SelectField>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setEditTarget(null)}
                className="th-btn-secondary rounded-lg border px-4 py-2 text-sm font-semibold transition hover:bg-white/[0.04]"
              >
                Cancel
              </button>
              <Button type="button" onClick={handleEdit} disabled={editLoading}>
                {editLoading ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {passwordTarget && (
        <Modal title={`Reset password — ${passwordTarget.display_name ?? passwordTarget.username}`} onClose={() => setPasswordTarget(null)}>
          <div className="space-y-3">
            {passwordError && (
              <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-2.5 text-xs font-medium text-red-100">
                {passwordError}
              </div>
            )}
            <p className="text-xs text-slate-400">
              Enter a new password for <span className="font-semibold text-slate-200">{passwordTarget.username}</span>.
            </p>
            <div>
              <label className={LABEL_CLS}>New password *</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min. 8 characters"
                className={INPUT_CLS}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPasswordTarget(null)}
                className="th-btn-secondary rounded-lg border px-4 py-2 text-sm font-semibold transition hover:bg-white/[0.04]"
              >
                Cancel
              </button>
              <Button type="button" onClick={handlePasswordReset} disabled={passwordLoading || newPassword.length < 8}>
                {passwordLoading ? "Updating…" : "Update Password"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmationModal
          title="Delete Operator"
          confirmLabel={deleteLoading ? "Deleting" : "Delete"}
          loading={deleteLoading}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void handleDelete()}
        >
          Permanently delete{" "}
          <span className="font-semibold text-white">{deleteTarget.display_name ?? deleteTarget.username}</span>?
          This action cannot be undone.
        </ConfirmationModal>
      )}
    </section>
  );
}
