import { useEffect, useState } from "react";
import { KeySquare, Lock, Pencil, Plus, RefreshCcw, Shield, Trash2, Users, X } from "lucide-react";
import OperatorScopeModal from "../components/OperatorScopeModal";
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
import { UserRole } from "../api/auth";
import { Button } from "../components/ui";
import { useAuth } from "../auth/AuthContext";

const ROLES: UserRole[] = ["owner", "admin", "operator", "readonly"];

const roleBadgeClass: Record<UserRole, string> = {
  owner: "border-orange-300/25 bg-gradient-to-r from-techi-orange to-techi-pink text-white",
  admin: "border-red-300/25 bg-techi-pink/15 text-red-100",
  operator: "border-white/[0.12] bg-white/[0.07] text-slate-100",
  readonly: "border-slate-500/50 bg-slate-900/85 text-slate-300",
};

const statusBadgeClass = {
  active: "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300",
  inactive: "border-slate-500/30 bg-slate-800/60 text-slate-400",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const INPUT_CLS =
  "w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none focus:border-techi-orange/60";
const LABEL_CLS = "block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1";

interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  title: string;
}

function Modal({ onClose, children, title }: ModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-slate-950 p-5 shadow-2xl">
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
  const isOwner = user?.role === "owner";
  const canManage = can("admin");

  const [operators, setOperators] = useState<OperatorRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<OperatorCreate>({
    username: "",
    email: "",
    display_name: "",
    password: "",
    role: "readonly",
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

  const [scopeTarget, setScopeTarget] = useState<OperatorRecord | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      setOperators(await getOperators());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load operators");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const canEditRole = (targetRole: UserRole) => {
    if (isOwner) return true;
    if (user?.role === "admin" && (targetRole === "owner" || targetRole === "admin")) return false;
    return canManage;
  };

  const handleCreate = async () => {
    if (!createForm.username.trim() || !createForm.email.trim() || !createForm.password.trim()) return;
    try {
      setCreateLoading(true);
      setCreateError(null);
      const created = await createOperator({
        ...createForm,
        display_name: createForm.display_name || undefined,
      });
      setOperators((prev) => [...prev, created]);
      setShowCreate(false);
      setCreateForm({ username: "", email: "", display_name: "", password: "", role: "readonly" });
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
      role: op.role,
      is_active: op.is_active,
    });
    setEditError(null);
  };

  const handleEdit = async () => {
    if (!editTarget) return;
    try {
      setEditLoading(true);
      setEditError(null);
      const updated = await updateOperator(editTarget.id, {
        ...editForm,
        display_name: editForm.display_name || null,
      });
      setOperators((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
      setEditTarget(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update operator");
    } finally {
      setEditLoading(false);
    }
  };

  const handleToggleActive = async (op: OperatorRecord) => {
    try {
      setError(null);
      const updated = await updateOperator(op.id, { is_active: !op.is_active });
      setOperators((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
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
    try {
      setDeleteLoading(true);
      await deleteOperator(deleteTarget.id);
      setOperators((prev) => prev.filter((o) => o.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete operator");
      setDeleteTarget(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const availableRoles = (): UserRole[] => {
    if (isOwner) return ROLES;
    return ["operator", "readonly"];
  };

  return (
    <section className="premium-page space-y-5">
      <div className="premium-card overflow-hidden p-5 md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="premium-kicker">Access Control</p>
            <h1 className="mt-1.5 text-3xl font-semibold text-white">Operators</h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-400">
              Manage platform users, roles, and access permissions.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void loadData()} disabled={loading}>
              <RefreshCcw className="h-3.5 w-3.5" />
              Refresh
            </Button>
            {canManage && (
              <Button size="sm" onClick={() => setShowCreate(true)}>
                <Plus className="h-3.5 w-3.5" />
                Add Operator
              </Button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-sm font-medium text-red-100">
          {error}
        </div>
      )}

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
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Last Login</th>
                <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Created</th>
                <th className="px-5 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {operators.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-sm font-medium text-slate-500">
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
                          <span className="rounded-full border border-techi-orange/30 bg-techi-orange/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-techi-orange">
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
                    <td className="px-5 py-3.5 text-[12px] text-slate-400">
                      {formatDateTime(op.last_login_at)}
                    </td>
                    <td className="px-5 py-3.5 text-[12px] text-slate-400">
                      {formatDate(op.created_at)}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-1">
                        {canManage && (op.role === "operator" || op.role === "readonly") && (
                          <button
                            type="button"
                            onClick={() => setScopeTarget(op)}
                            title="Manage access scope"
                            className="rounded-md p-1.5 text-slate-500 transition hover:bg-white/[0.06] hover:text-violet-300"
                          >
                            <Lock className="h-3.5 w-3.5" />
                          </button>
                        )}
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
                            className={`rounded-md p-1.5 text-[11px] font-bold transition hover:bg-white/[0.06] ${
                              op.is_active ? "text-slate-500 hover:text-amber-300" : "text-emerald-500 hover:text-emerald-300"
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
                            className="rounded-md p-1.5 text-slate-500 transition hover:bg-white/[0.06] hover:text-red-300"
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

      {showCreate && (
        <Modal title="Add Operator" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            {createError && (
              <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-2.5 text-xs font-medium text-red-100">
                {createError}
              </div>
            )}
            <div>
              <label className={LABEL_CLS}>Display name</label>
              <input
                value={createForm.display_name ?? ""}
                onChange={(e) => setCreateForm((f) => ({ ...f, display_name: e.target.value }))}
                placeholder="Full name (optional)"
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
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Role *</label>
              <select
                value={createForm.role}
                onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value as UserRole }))}
                className={INPUT_CLS}
              >
                {availableRoles().map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:bg-white/[0.04] hover:text-white"
              >
                Cancel
              </button>
              <Button type="button" onClick={handleCreate} disabled={createLoading}>
                {createLoading ? "Creating…" : "Create Operator"}
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
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Email</label>
              <input
                type="email"
                value={editForm.email ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Role</label>
              <select
                value={editForm.role ?? editTarget.role}
                onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value as UserRole }))}
                className={INPUT_CLS}
                disabled={!canEditRole(editTarget.role)}
              >
                {availableRoles().map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setEditTarget(null)}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:bg-white/[0.04] hover:text-white"
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
                className="rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:bg-white/[0.04] hover:text-white"
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

      {scopeTarget && (
        <OperatorScopeModal
          operator={scopeTarget}
          onClose={() => setScopeTarget(null)}
        />
      )}

      {deleteTarget && (
        <Modal title="Delete Operator" onClose={() => setDeleteTarget(null)}>
          <div className="space-y-4">
            <p className="text-sm text-slate-300">
              Permanently delete{" "}
              <span className="font-semibold text-white">{deleteTarget.display_name ?? deleteTarget.username}</span>?
              This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:bg-white/[0.04] hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={deleteLoading}
                className="rounded-lg border border-red-500/30 bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-200 transition hover:bg-red-500/25 disabled:opacity-50"
              >
                {deleteLoading ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
