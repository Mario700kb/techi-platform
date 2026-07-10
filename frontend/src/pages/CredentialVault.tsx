import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, RefreshCcw, Trash2, Eye } from "lucide-react";

import {
  VaultCredential,
  VaultCredentialType,
  VaultScopeType,
  createVaultCredential,
  deleteVaultCredential,
  listVaultCredentials,
  revealVaultCredential,
} from "../api/vault";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Badge, Button } from "../components/ui";
import ConfirmationModal from "../components/ConfirmationModal";
import { parseUTC } from "../utils/time";

const INPUT_CLS =
  "th-input rounded-lg border px-3 py-2 text-sm font-medium outline-none focus:border-techi-orange/60";

const TYPES: VaultCredentialType[] = [
  "password",
  "ssh_key",
  "api_token",
  "snmp",
  "winbox",
  "certificate",
];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return parseUTC(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CredentialVault() {
  const { can } = useAuth();
  const canManage = can("admin");

  const [items, setItems] = useState<VaultCredential[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [type, setType] = useState<VaultCredentialType>("password");
  const [scope, setScope] = useState<VaultScopeType>("global");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<VaultCredential | null>(null);
  const [blockedDelete, setBlockedDelete] = useState<{ target: VaultCredential; message: string } | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; secret: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listVaultCredentials());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load vault");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    if (!name.trim() || !secret) return;
    setSaving(true);
    setError(null);
    try {
      await createVaultCredential({
        name: name.trim(),
        credential_type: type,
        scope_type: scope,
        username: username.trim() || null,
        secret,
      });
      setName("");
      setUsername("");
      setSecret("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create credential");
    } finally {
      setSaving(false);
    }
  }

  async function handleReveal(cred: VaultCredential) {
    const reason = window.prompt(
      `Reason for revealing "${cred.name}" (required, written to audit):`,
    );
    if (!reason || reason.trim().length < 5) return;
    try {
      const res = await revealVaultCredential(cred.id, reason.trim());
      setRevealed({ name: res.name, secret: res.secret });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reveal failed");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    try {
      await deleteVaultCredential(target.id);
      setDeleteTarget(null);
      await load();
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
      setBlockedDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
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
          <Button onClick={() => void load()}>
            <RefreshCcw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      )}

      {canManage && (
        <div className="premium-card p-4">
          <p className="premium-kicker mb-3">New credential</p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <input
              className={INPUT_CLS}
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <select className={INPUT_CLS} value={type} onChange={(e) => setType(e.target.value as VaultCredentialType)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select className={INPUT_CLS} value={scope} onChange={(e) => setScope(e.target.value as VaultScopeType)}>
              <option value="global">Global</option>
            </select>
            <input
              className={INPUT_CLS}
              placeholder="Username (optional)"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              className={INPUT_CLS}
              type="password"
              placeholder="Secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
          <div className="mt-3">
            <Button onClick={() => void handleCreate()} disabled={saving || !name.trim() || !secret}>
              <Plus className="h-4 w-4" />
              {saving ? "Saving…" : "Add credential"}
            </Button>
          </div>
        </div>
      )}

      <div className="premium-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/5 text-[10px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Scope</th>
                <th className="px-4 py-3">Username</th>
                <th className="px-4 py-3">Secret</th>
                <th className="px-4 py-3">Last used</th>
                <th className="px-4 py-3">Rotated</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                    Loading…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                    No credentials yet.
                  </td>
                </tr>
              ) : (
                items.map((c) => (
                  <tr key={c.id} className="border-b border-white/5">
                    <td className="px-4 py-3 font-semibold text-white">{c.name}</td>
                    <td className="px-4 py-3">
                      <Badge variant="ghost">{c.credential_type}</Badge>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{c.scope_type}</td>
                    <td className="px-4 py-3 font-mono text-slate-400">{c.username || "—"}</td>
                    <td className="px-4 py-3 font-mono text-slate-500">{c.secret_hint || "••••"}</td>
                    <td className="px-4 py-3 text-slate-400">{formatDate(c.last_used_at)}</td>
                    <td className="px-4 py-3 text-slate-400">{formatDate(c.rotated_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {canManage && (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleReveal(c)}
                              className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.06]"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              Reveal
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(c)}
                              className="inline-flex items-center gap-1 rounded-md border border-red-400/30 px-2.5 py-1 text-xs font-semibold text-red-200 transition hover:bg-red-400/10"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {revealed && (
        <ConfirmationModal
          title={`Secret — ${revealed.name}`}
          confirmLabel="Close"
          destructive={false}
          onConfirm={() => setRevealed(null)}
          onClose={() => setRevealed(null)}
        >
          <p className="break-all font-mono text-sm" style={{ color: "var(--th-text-primary)" }}>
            {revealed.secret}
          </p>
        </ConfirmationModal>
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
    </section>
  );
}
