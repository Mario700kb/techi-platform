import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clipboard,
  Copy,
  Download,
  Eye,
  Info,
  LoaderCircle,
  Plus,
  RefreshCcw,
  RotateCcw,
  Server,
  Shield,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  AvailabilityProfile,
  CreateTokenRequest,
  CreateTokenResponse,
  EnrollmentBootstrapMode,
  EnrollmentBootstrapPlatform,
  EnrollmentBootstrapResponse,
  EnrollmentAuditEvent,
  EnrollmentToken,
  EnrollmentTokenDiagnostics,
  createEnrollmentToken,
  deleteEnrollmentToken,
  generateEnrollmentBootstrap,
  getEnrollmentTokenDiagnostics,
  getEnrollmentTokenEvents,
  getEnrollmentTokens,
  regenerateDefaultToken,
  revokeEnrollmentToken,
  updateEnrollmentToken,
} from "../api/enrollmentBootstrap";
import { Client, DeviceGroup, getClients, getGroups } from "../api/clients";
import { useAuth } from "../auth/AuthContext";
import ConfirmationModal from "../components/ConfirmationModal";
import { Badge, Button } from "../components/ui";
import { formatLocalDateTime, timeAgo, tiranaInputToUtcIso } from "../utils/time";

function getDefaultBackendUrl(): string {
  if (typeof window === "undefined") return "http://localhost:8000";
  const { protocol, hostname } = window.location;
  if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1") {
    return `${protocol}//${hostname}:8000`;
  }
  return `${protocol}//${hostname}:8000`;
}

async function validateBackendReachable(url: string): Promise<void> {
  const base = url.trim().replace(/\/+$/, "");
  const response = await fetch(`${base}/health`, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Backend health check failed (${response.status})`);
  }
}

type Toast = { id: number; message: string; type: "success" | "error" };

function tokenStatusBadge(token: EnrollmentToken) {
  if (token.status === "revoked")
    return <Badge variant="neutral" className="border-red-400/25 bg-red-500/10 text-red-300">Revoked</Badge>;
  if (token.status === "expired")
    return <Badge variant="neutral" className="border-slate-600/30 text-slate-500">Expired</Badge>;
  if (token.status === "used")
    return <Badge variant="neutral" className="border-amber-400/25 bg-amber-400/10 text-amber-300">Exhausted</Badge>;
  if (token.use_count === 0)
    return <Badge variant="neutral" className="border-blue-400/25 bg-blue-400/10 text-blue-300">Unused</Badge>;
  return <Badge variant="ghost" className="border-emerald-400/25 bg-emerald-400/10 text-emerald-300">Active</Badge>;
}

function isRevocable(token: EnrollmentToken): boolean {
  return token.status === "active" || token.status === "used";
}

function usagePercent(token: EnrollmentToken): number {
  if (!token.max_uses) return 0;
  return Math.round((100 * token.use_count) / token.max_uses);
}

function usageWarningBadge(token: EnrollmentToken, onClick?: () => void) {
  if (!token.usage_warning) return null;
  const critical = token.usage_warning === "critical";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={
        critical
          ? `Token exhausted (${token.use_count}/${token.max_uses})${onClick ? " — click to raise max uses" : ""}`
          : `Token at ${usagePercent(token)}% of max uses${onClick ? " — click to raise max uses" : ""}`
      }
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${
        critical
          ? "border-red-400/30 bg-red-500/15 text-red-300"
          : "border-amber-400/30 bg-amber-400/15 text-amber-300"
      } ${onClick ? "cursor-pointer transition hover:brightness-125" : "cursor-default"}`}
    >
      {critical ? "🔴 FULL" : `⚠️ ${usagePercent(token)}%`}
    </button>
  );
}

function formatTokenPrefix(tokenPrefix: EnrollmentToken["token_prefix"]): string {
  if (typeof tokenPrefix !== "string") return "legacy";
  const prefix = tokenPrefix.trim();
  return prefix ? `${prefix}…` : "legacy";
}

function downloadTextFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Guard: reject scripts that still use the legacy here-string / hostname-replace approach.
// These patterns indicate the old dedent-based generator is running.
const FORBIDDEN_SCRIPT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /@'/m, label: "legacy here-string opener (@')" },
  { pattern: /'@/m, label: "legacy here-string terminator ('@)" },
  { pattern: /-replace\s+'<HOSTNAME>'/i, label: "legacy hostname replace" },
];

function validateBootstrapScript(script: string): string | null {
  for (const { pattern, label } of FORBIDDEN_SCRIPT_PATTERNS) {
    if (pattern.test(script)) {
      return `Generated script contains ${label} — backend may be running old code. Refresh and try again.`;
    }
  }
  return null;
}

const PROFILE_INFO: Record<AvailabilityProfile, { label: string; description: string }> = {
  server: {
    label: "Server",
    description: "Sleep and hibernate disabled on AC. Lock screen stays enabled. TECHI Remote Support works on lock screen via service.",
  },
  workstation: {
    label: "Workstation",
    description: "Sleep/hibernate follow your explicit settings below. Lock screen stays enabled. Device goes offline when it sleeps.",
  },
  custom: {
    label: "Custom",
    description: "All power flags set manually. Lock screen is always preserved.",
  },
};

export default function EnrollmentBootstrap() {
  const { can } = useAuth();
  const canManage = can("admin");

  // ── generator state ──────────────────────────────────────────────────────
  const [tokens, setTokens] = useState<EnrollmentToken[]>([]);
  const [mode, setMode] = useState<EnrollmentBootstrapMode>("token");
  const [tokenId, setTokenId] = useState("");
  const [plaintextToken, setPlaintextToken] = useState("");
  const [backendUrl, setBackendUrl] = useState(getDefaultBackendUrl);
  const [platform, setPlatform] = useState<EnrollmentBootstrapPlatform>("windows");
  const [rustdeskEnabled, setRustdeskEnabled] = useState(false);
  const [rustdeskMsiUrl, setRustdeskMsiUrl] = useState("");
  const [rustdeskRendezvous, setRustdeskRendezvous] = useState("");
  const [rustdeskRelay, setRustdeskRelay] = useState("");
  const [rustdeskApi, setRustdeskApi] = useState("");
  const [rustdeskKey, setRustdeskKey] = useState("");
  const [rustdeskPassword, setRustdeskPassword] = useState("");

  // ── availability profile state ───────────────────────────────────────────
  const [availProfile, setAvailProfile] = useState<AvailabilityProfile>("workstation");
  const [managePower, setManagePower] = useState(false);
  const [preventSleepAC, setPreventSleepAC] = useState(false);
  const [preventHibernate, setPreventHibernate] = useState(false);
  const [allowDisplayOff, setAllowDisplayOff] = useState(true);

  const [bootstrap, setBootstrap] = useState<EnrollmentBootstrapResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // ── flash plaintext (only immediately after create / regenerate) ─────────
  const [flashToken, setFlashToken] = useState<{ id: number; plaintext: string } | null>(null);

  // ── create token modal ───────────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMaxUses, setNewMaxUses] = useState(10);
  const [newExpiry, setNewExpiry] = useState("");
  const [newClientId, setNewClientId] = useState<number | "">("");
  const [newGroupId, setNewGroupId] = useState<number | "">("");
  const [creating, setCreating] = useState(false);
  const [clients, setClients] = useState<Client[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);

  // ── table actions ────────────────────────────────────────────────────────
  const [revoking, setRevoking] = useState<Set<number>>(new Set());
  const [revokeTarget, setRevokeTarget] = useState<EnrollmentToken | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EnrollmentToken | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [editMaxUsesTarget, setEditMaxUsesTarget] = useState<EnrollmentToken | null>(null);
  const [editMaxUses, setEditMaxUses] = useState(0);
  const [savingMaxUses, setSavingMaxUses] = useState(false);
  const [diagnosticsToken, setDiagnosticsToken] = useState<EnrollmentToken | null>(null);
  const [diagnostics, setDiagnostics] = useState<EnrollmentTokenDiagnostics | null>(null);
  const [diagnosticsCache, setDiagnosticsCache] = useState<Record<number, EnrollmentTokenDiagnostics>>({});
  const [diagnosticsEvents, setDiagnosticsEvents] = useState<EnrollmentAuditEvent[]>([]);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);

  // ── toasts ───────────────────────────────────────────────────────────────
  const [toasts, setToasts] = useState<Toast[]>([]);

  function showToast(message: string, type: Toast["type"] = "success") {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }

  // ── derived ──────────────────────────────────────────────────────────────
  const activeTokens = useMemo(() => tokens.filter((t) => t.status === "active"), [tokens]);
  const warningTokens = useMemo(() => tokens.filter((t) => t.usage_warning), [tokens]);
  const defaultToken = useMemo(() => tokens.find((t) => t.is_default) ?? null, [tokens]);
  const activeDefault = useMemo(() => tokens.find((t) => t.is_default && t.status === "active") ?? null, [tokens]);
  const selectedToken = useMemo(
    () => activeTokens.find((t) => String(t.id) === tokenId) ?? null,
    [activeTokens, tokenId]
  );
  const isLocalhost = backendUrl.includes("localhost") || backendUrl.includes("127.0.0.1");
  const canGenerate = mode === "gpo" || (mode === "token" && activeTokens.length > 0 && !!tokenId);

  // ── load tokens ──────────────────────────────────────────────────────────
  const loadTokens = async () => {
    try {
      setTokensLoading(true);
      setError(null);
      const data = await getEnrollmentTokens();
      setTokens(data);
      // Auto-select default active token when no selection exists
      if (!tokenId) {
        const def = data.find((t) => t.is_default && t.status === "active");
        const first = data.find((t) => t.status === "active");
        const pick = def ?? first;
        if (pick) setTokenId(String(pick.id));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tokens");
    } finally {
      setTokensLoading(false);
    }
  };

  const openDiagnostics = async (token: EnrollmentToken) => {
    setDiagnosticsToken(token);
    setDiagnostics(null);
    setDiagnosticsEvents([]);
    setDiagnosticsError(null);
    setDiagnosticsLoading(true);
    try {
      const [summary, events] = await Promise.all([
        getEnrollmentTokenDiagnostics(token.id),
        getEnrollmentTokenEvents(token.id, { limit: 50 }),
      ]);
      setDiagnostics(summary);
      setDiagnosticsEvents(events);
      setDiagnosticsCache((current) => ({ ...current, [token.id]: summary }));
    } catch (err) {
      setDiagnosticsError(err instanceof Error ? err.message : "Failed to load token diagnostics");
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  const loadMoreEvents = async () => {
    if (!diagnosticsToken || eventsLoading) return;
    setEventsLoading(true);
    try {
      const next = await getEnrollmentTokenEvents(diagnosticsToken.id, {
        limit: 50,
        offset: diagnosticsEvents.length,
      });
      setDiagnosticsEvents((current) => [...current, ...next]);
    } catch (err) {
      setDiagnosticsError(err instanceof Error ? err.message : "Failed to load more enrollment events");
    } finally {
      setEventsLoading(false);
    }
  };

  useEffect(() => {
    void loadTokens();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── open create modal ────────────────────────────────────────────────────
  const openCreateModal = async () => {
    setNewName("");
    setNewMaxUses(10);
    setNewExpiry("");
    setNewClientId("");
    setNewGroupId("");
    setGroups([]);
    setCreateOpen(true);
    try {
      const cl = await getClients();
      setClients(cl.filter((c) => c.is_active));
    } catch {
      setClients([]);
    }
  };

  useEffect(() => {
    if (newClientId === "") {
      setGroups([]);
      setNewGroupId("");
      return;
    }
    getGroups(newClientId as number)
      .then((g) => setGroups(g))
      .catch(() => setGroups([]));
  }, [newClientId]);

  // ── create token ─────────────────────────────────────────────────────────
  const handleCreateToken = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const payload: CreateTokenRequest = {
        name: newName.trim(),
        max_uses: Math.max(1, Number(newMaxUses) || 1),
        expires_at: newExpiry ? tiranaInputToUtcIso(newExpiry) : null,
        client_id: newClientId !== "" ? Number(newClientId) : null,
        group_id: newGroupId !== "" ? Number(newGroupId) : null,
      };
      const result = await createEnrollmentToken(payload);
      setFlashToken({ id: result.id, plaintext: result.token });
      await loadTokens();
      setTokenId(String(result.id));
      setPlaintextToken(result.token);
      setCreateOpen(false);
      showToast(`Token "${result.name}" created`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create token", "error");
    } finally {
      setCreating(false);
    }
  };

  // ── raise max_uses (quick action from usage warnings) ───────────────────
  const openMaxUsesEditor = (token: EnrollmentToken) => {
    setEditMaxUses(token.max_uses);
    setEditMaxUsesTarget(token);
  };

  const handleSaveMaxUses = async () => {
    if (!editMaxUsesTarget) return;
    setSavingMaxUses(true);
    try {
      await updateEnrollmentToken(editMaxUsesTarget.id, {
        max_uses: Math.max(1, Number(editMaxUses) || 1),
      });
      await loadTokens();
      showToast(`Token "${editMaxUsesTarget.name}" max uses set to ${Math.max(1, Number(editMaxUses) || 1)}`);
      setEditMaxUsesTarget(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update max uses", "error");
    } finally {
      setSavingMaxUses(false);
    }
  };

  // ── use default token ─────────────────────────────────────────────────────
  const handleUseDefault = () => {
    if (!activeDefault) return;
    setTokenId(String(activeDefault.id));
    const pt = flashToken?.id === activeDefault.id ? flashToken.plaintext : "";
    setPlaintextToken(pt);
  };

  // ── revoke token ──────────────────────────────────────────────────────────
  const handleRevoke = async (token: EnrollmentToken) => {
    setRevoking((prev) => new Set(prev).add(token.id));
    try {
      await revokeEnrollmentToken(token.id);
      await loadTokens();
      if (tokenId === String(token.id)) setTokenId("");
      showToast(`Token "${token.name}" revoked`);
      setRevokeTarget(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Revoke failed", "error");
    } finally {
      setRevoking((prev) => { const n = new Set(prev); n.delete(token.id); return n; });
    }
  };

  const handleDeleteToken = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteEnrollmentToken(deleteTarget.id, {
        confirmActive: deleteTarget.status === "active",
        confirmDefault: deleteTarget.is_default && deleteTarget.status === "active",
      });
      await loadTokens();
      if (tokenId === String(deleteTarget.id)) setTokenId("");
      if (flashToken?.id === deleteTarget.id) setFlashToken(null);
      showToast(`Token "${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Delete failed", "error");
    } finally {
      setDeleting(false);
    }
  };

  // ── regenerate default token ──────────────────────────────────────────────
  const handleRegenerateDefault = async () => {
    setRegenerating(true);
    try {
      const result = await regenerateDefaultToken();
      setFlashToken({ id: result.id, plaintext: result.token });
      await loadTokens();
      setTokenId(String(result.id));
      setPlaintextToken(result.token);
      showToast("Default Deployment token regenerated — copy the new plaintext now");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Regenerate failed", "error");
    } finally {
      setRegenerating(false);
    }
  };

  // ── generate bootstrap ───────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (mode === "token" && !tokenId) {
      setError("Select an active enrollment token");
      return;
    }
    try {
      setLoading(true);
      setError(null);
      await validateBackendReachable(backendUrl);
      const result = await generateEnrollmentBootstrap({
        mode,
        enrollment_token_id: mode === "token" ? Number(tokenId) : undefined,
        backend_url: backendUrl,
        platform,
        enrollment_token:
          mode === "token" && plaintextToken.trim() ? plaintextToken.trim() : undefined,
        rustdesk_manage_enabled: rustdeskEnabled,
        rustdesk_msi_url: rustdeskMsiUrl,
        rustdesk_rendezvous_server: rustdeskRendezvous,
        rustdesk_relay_server: rustdeskRelay,
        rustdesk_api_server: rustdeskApi,
        rustdesk_key: rustdeskKey,
        rustdesk_default_password: rustdeskPassword,
        availability_profile: availProfile,
        manage_power_policy: managePower,
        prevent_sleep_on_ac: preventSleepAC,
        prevent_hibernate: preventHibernate,
        allow_display_off_on_ac: allowDisplayOff,
      });
      const scriptError = validateBootstrapScript(result.bootstrap_script);
      if (scriptError) {
        setError(scriptError);
        showToast(scriptError, "error");
        return;
      }
      setBootstrap(result);
      showToast("Bootstrap generated successfully");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to generate bootstrap";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setLoading(false);
    }
  };

  const copyText = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1600);
  };

  const handleDownloadScript = () => {
    if (!bootstrap) return;
    const filename = bootstrap.installer_filename || (bootstrap.mode === "gpo" ? "techi-gpo-bootstrap.ps1" : "techi-installer.ps1");
    downloadTextFile(bootstrap.bootstrap_script, filename);
  };

  return (
    <section className="premium-page space-y-5">
      {/* ── header ───────────────────────────────────────────────────────── */}
      <div className="premium-card overflow-hidden p-5 md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="premium-kicker">Enrollment</p>
            <h1 className="mt-2 text-2xl font-semibold text-white">Enrollment Bootstrap</h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-slate-300">
              Generate a one-click PowerShell installer for Windows endpoints.
              Use <strong>Token Enrollment</strong> for manual/test installs or
              <strong> Trusted Domain / GPO</strong> for domain-joined PCs.
            </p>
          </div>
          <Button size="sm" type="button" onClick={() => void loadTokens()} disabled={tokensLoading}>
            <RefreshCcw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {/* ── token usage warnings ──────────────────────────────────────────── */}
      {warningTokens.length > 0 && (
        <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-4">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-200">
                {warningTokens.length} token{warningTokens.length === 1 ? "" : "s"} need
                {warningTokens.length === 1 ? "s" : ""} attention
                {canManage && " — click a token to raise its limit"}
              </p>
              <ul className="mt-2 space-y-1">
                {warningTokens.map((token) => (
                  <li key={token.id} className="flex flex-wrap items-center gap-2 text-xs text-amber-100/90">
                    {usageWarningBadge(token, canManage ? () => openMaxUsesEditor(token) : undefined)}
                    {canManage ? (
                      <button
                        type="button"
                        onClick={() => openMaxUsesEditor(token)}
                        className="font-semibold text-white transition hover:text-amber-200"
                      >
                        {token.name}
                      </button>
                    ) : (
                      <span className="font-semibold text-white">{token.name}</span>
                    )}
                    <span className="font-mono text-amber-200/80">
                      {token.use_count}/{token.max_uses} ({usagePercent(token)}%)
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ── security model notice ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-blue-400/15 bg-blue-400/[0.05] p-4">
        <div className="flex gap-3">
          <Shield className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
          <div className="text-sm text-blue-100">
            <span className="font-semibold">Security model: </span>
            Lock screen stays enabled at all times — remote access works through Windows services
            (TechiAgent + TECHI Remote Support), not through logged-in user sessions.
            Sleep / hibernate makes the device unreachable unless Wake-on-LAN is used.
            Choose <strong>Server</strong> profile to prevent sleep on AC power.
          </div>
        </div>
      </div>

      {/* ── default token banner ──────────────────────────────────────────── */}
      {defaultToken && (
        <div className={`rounded-xl border p-4 ${
          defaultToken.status === "active"
            ? "border-emerald-400/20 bg-emerald-400/[0.06]"
            : "border-amber-400/20 bg-amber-400/[0.06]"
        }`}>
          <div className="flex flex-wrap items-center gap-3">
            <Shield className={`h-5 w-5 shrink-0 ${defaultToken.status === "active" ? "text-emerald-400" : "text-amber-400"}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-white">Default Deployment Token</span>
                {tokenStatusBadge(defaultToken)}
                <code className="rounded bg-slate-800/60 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                  {formatTokenPrefix(defaultToken.token_prefix)}
                </code>
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                {defaultToken.use_count}/{defaultToken.max_uses} uses
                {defaultToken.status !== "active" && " · Token is inactive — regenerate to create a new one"}
              </p>
            </div>
            <div className="flex gap-2">
              {activeDefault && mode === "token" && (
                <Button size="sm" onClick={handleUseDefault} disabled={tokenId === String(activeDefault.id)}>
                  {tokenId === String(activeDefault.id) ? (
                    <><Check className="mr-1.5 h-3.5 w-3.5 text-emerald-300" />Selected</>
                  ) : (
                    <>Use Default</>
                  )}
                </Button>
              )}
              {canManage && (
                <Button
                  size="sm"
                  onClick={() => void handleRegenerateDefault()}
                  disabled={regenerating}
                  className="th-btn-secondary"
                >
                  <RotateCcw className={`mr-1.5 h-3.5 w-3.5 ${regenerating ? "animate-spin" : ""}`} />
                  {regenerating ? "Regenerating…" : "Regenerate"}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── generator + output ───────────────────────────────────────────── */}
      <div className="grid gap-5 xl:grid-cols-[400px_minmax(0,1fr)]">
        {/* ── left: generator ─────────────────────────────────────────────── */}
        <div className="premium-card-soft p-5">
          <div className="mb-4 flex items-center gap-2">
            <Terminal className="h-4 w-4 text-techi-orange" />
            <h2 className="text-base font-semibold text-white">Generator</h2>
          </div>

          <div className="space-y-4">
            {/* Mode */}
            <div>
              <span className="mb-1.5 block text-xs font-semibold text-slate-200">Deployment mode</span>
              <div className="grid grid-cols-2 gap-2">
                {(["token", "gpo"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                      mode === m
                        ? "border-techi-orange/60 bg-techi-orange/10 text-techi-orange"
                        : "th-btn-secondary hover:border-white/20"
                    }`}
                  >
                    {m === "token" ? "Token Enrollment" : "Trusted Domain / GPO"}
                  </button>
                ))}
              </div>
            </div>

            {/* GPO explanation */}
            {mode === "gpo" && (
              <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 p-3 text-xs text-amber-100 space-y-2">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Domain vs WORKGROUP — important difference
                </div>
                <ul className="ml-5 list-disc space-y-1 font-medium">
                  <li>
                    <strong>Domain-joined PCs</strong> — enroll automatically. No token needed.
                    Requires{" "}
                    <code className="font-mono text-amber-200">TRUSTED_DOMAIN_AUTO_ENROLLMENT=true</code>{" "}
                    on the backend.
                  </li>
                  <li>
                    <strong>WORKGROUP PCs</strong> — will NOT enroll via GPO. Use{" "}
                    <strong>Token Enrollment</strong> for these machines.
                  </li>
                  <li>Script is idempotent — safe to run at every startup via GPO.</li>
                  <li>
                    Backend URL must be reachable from every target PC — use a LAN IP or public
                    domain, not localhost.
                  </li>
                </ul>
              </div>
            )}

            {/* Token mode fields */}
            {mode === "token" && (
              <>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-200">Enrollment token</span>
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => void openCreateModal()}
                        className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs font-semibold text-slate-300 transition hover:border-techi-orange/40 hover:text-techi-orange"
                      >
                        <Plus className="h-3 w-3" />
                        Create
                      </button>
                    )}
                  </div>

                  {/* Default token quick-select */}
                  {activeDefault && tokenId !== String(activeDefault.id) && (
                    <button
                      type="button"
                      onClick={handleUseDefault}
                      className="mb-2 w-full rounded-lg border border-emerald-400/20 bg-emerald-400/[0.07] px-3 py-2 text-left text-xs font-semibold text-emerald-300 transition hover:bg-emerald-400/[0.12]"
                    >
                      <Shield className="mr-1.5 inline h-3.5 w-3.5" />
                      Use Default Deployment Token
                    </button>
                  )}

                  <select
                    value={tokenId}
                    onChange={(e) => { setTokenId(e.target.value); setPlaintextToken(""); }}
                    id="deployment-token"
                    name="deployment-token"
                    aria-label="Deployment token"
                    className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none transition focus:border-techi-orange/60"
                  >
                    {activeTokens.length === 0 && (
                      <option value="">No active tokens — click Create above</option>
                    )}
                    {activeTokens.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.is_default ? "⭐ " : ""}#{t.id} · {t.name} ({t.use_count}/{t.max_uses} uses)
                      </option>
                    ))}
                  </select>
                </div>

                <label className="block">
                  <span className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-slate-200">
                    Plaintext token value
                    {plaintextToken && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                        <Check className="h-2.5 w-2.5" /> auto-filled
                      </span>
                    )}
                  </span>
                  <input
                    value={plaintextToken}
                    onChange={(e) => setPlaintextToken(e.target.value)}
                    placeholder="Auto-filled after Create, or paste manually"
                    className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white placeholder:text-slate-500 outline-none transition focus:border-techi-orange/60"
                  />
                </label>
              </>
            )}

            {/* Backend URL */}
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-200">Backend URL</span>
              <input
                value={backendUrl}
                onChange={(e) => setBackendUrl(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none transition focus:border-techi-orange/60"
              />
              {isLocalhost && (
                <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <strong>Warning:</strong> localhost only works on this machine. For real devices use
                    your server&apos;s IP or domain, e.g.{" "}
                    <code className="font-mono text-amber-200">http://&lt;server-ip&gt;:8000</code>
                  </span>
                </p>
              )}
            </label>

            {/* Platform */}
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-200">Platform</span>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value as EnrollmentBootstrapPlatform)}
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none transition focus:border-techi-orange/60"
              >
                <option value="windows">Windows</option>
                <option value="macos">macOS</option>
                <option value="linux">Linux</option>
              </select>
            </label>

            {/* ── Availability Profile ─────────────────────────────────────── */}
            {platform === "windows" && (
              <div>
                <div className="mb-1.5 flex items-center gap-2">
                  <Server className="h-3.5 w-3.5 text-techi-orange" />
                  <span className="text-xs font-semibold text-slate-200">Availability profile</span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 mb-2">
                  {(["server", "workstation", "custom"] as AvailabilityProfile[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setAvailProfile(p)}
                      className={`th-btn min-h-9 rounded-lg border px-2 py-2 text-xs font-semibold capitalize transition ${
                        availProfile === p
                          ? "th-btn-primary"
                          : "th-btn-secondary"
                      }`}
                    >
                      {PROFILE_INFO[p].label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-400 leading-5 mb-2">
                  {PROFILE_INFO[availProfile].description}
                </p>

                <label className="flex cursor-pointer items-center gap-2 mb-2">
                  <input
                    type="checkbox"
                    checked={managePower}
                    onChange={(e) => setManagePower(e.target.checked)}
                    className="h-4 w-4 rounded accent-techi-orange"
                  />
                  <span className="text-xs font-semibold text-slate-200">
                    Apply power policy on agent startup
                  </span>
                </label>

                {managePower && (availProfile === "workstation" || availProfile === "custom") && (
                  <div className="space-y-2 rounded-lg border border-white/10 bg-slate-950/50 p-3 mt-2">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={preventSleepAC}
                        onChange={(e) => setPreventSleepAC(e.target.checked)}
                        className="h-4 w-4 rounded accent-techi-orange"
                      />
                      <span className="text-xs text-slate-300">Prevent sleep on AC power</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={preventHibernate}
                        onChange={(e) => setPreventHibernate(e.target.checked)}
                        className="h-4 w-4 rounded accent-techi-orange"
                      />
                      <span className="text-xs text-slate-300">Disable hibernate</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={allowDisplayOff}
                        onChange={(e) => setAllowDisplayOff(e.target.checked)}
                        className="h-4 w-4 rounded accent-techi-orange"
                      />
                      <span className="text-xs text-slate-300">Allow display off on AC (recommended)</span>
                    </label>
                  </div>
                )}

                {managePower && availProfile === "server" && (
                  <div className="rounded-lg border border-emerald-400/15 bg-emerald-400/[0.06] p-2.5 text-xs text-emerald-300">
                    <Check className="mr-1.5 inline h-3.5 w-3.5" />
                    Server profile: sleep + hibernate will be disabled on AC. Lock screen stays enabled.
                  </div>
                )}
              </div>
            )}

            {/* TECHI Remote Support */}
            <div>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={rustdeskEnabled}
                  onChange={(e) => setRustdeskEnabled(e.target.checked)}
                  className="h-4 w-4 rounded accent-techi-orange"
                />
                <span className="text-xs font-semibold text-slate-200">
                  TECHI Remote Support self-healing (Windows)
                </span>
              </label>

              {rustdeskEnabled && (
                <div className="mt-3 space-y-3 rounded-lg border border-white/10 bg-slate-950/50 p-3">
                  {(
                    [
                      { label: "MSI URL", value: rustdeskMsiUrl, set: setRustdeskMsiUrl, placeholder: "http://server:8081/TECHI-Remote-Support.msi" },
                      { label: "Rendezvous server", value: rustdeskRendezvous, set: setRustdeskRendezvous, placeholder: "server IP or hostname" },
                      { label: "Relay server", value: rustdeskRelay, set: setRustdeskRelay, placeholder: "relay IP or hostname" },
                      { label: "API server", value: rustdeskApi, set: setRustdeskApi, placeholder: "http://server:21114" },
                      { label: "Public key", value: rustdeskKey, set: setRustdeskKey, placeholder: "base64 key" },
                      { label: "Default password", value: rustdeskPassword, set: setRustdeskPassword, placeholder: "initial TECHI Remote Support password" },
                    ] as const
                  ).map(({ label, value, set, placeholder }) => (
                    <label key={label} className="block">
                      <span className="mb-1 block text-xs text-slate-400">{label}</span>
                      <input
                        value={value}
                        onChange={(e) => set(e.target.value)}
                        placeholder={placeholder}
                        className="w-full rounded-md border border-white/10 bg-slate-900 px-2.5 py-2 text-xs font-medium text-white placeholder:text-slate-500 outline-none transition focus:border-techi-orange/60"
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <div className="flex gap-2 rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-sm font-medium text-red-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button
              className="w-full"
              type="button"
              onClick={() => void handleGenerate()}
              disabled={loading || !canGenerate || !backendUrl.trim()}
            >
              {loading ? "Generating…" : "Generate Installer"}
            </Button>
          </div>
        </div>

        {/* ── right: output ─────────────────────────────────────────────────── */}
        <div className="space-y-5">
          {bootstrap && (
            <>
              {/* Summary card */}
              <div className="premium-card-soft p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="premium-kicker">Generated Target</p>
                    <p className="mt-1 text-sm font-semibold text-white">
                      {bootstrap.mode === "gpo"
                        ? "GPO / Trusted Domain deployment"
                        : bootstrap.platform === "windows"
                        ? "Windows Service install"
                        : `${bootstrap.platform} bootstrap`}
                    </p>
                  </div>
                  <div className="grid gap-2 text-xs font-medium text-slate-300 sm:grid-cols-2">
                    <span className="rounded-md border border-white/10 bg-slate-950/60 px-2.5 py-1.5">
                      backend_url: {bootstrap.backend_url}
                    </span>
                    {bootstrap.mode === "token" && (
                      <span className="rounded-md border border-white/10 bg-slate-950/60 px-2.5 py-1.5">
                        token:{" "}
                        {selectedToken
                          ? `#${selectedToken.id} ${selectedToken.name}`
                          : bootstrap.enrollment_token_id
                          ? `#${bootstrap.enrollment_token_id}`
                          : "—"}
                      </span>
                    )}
                    {bootstrap.mode === "gpo" && (
                      <span className="rounded-md border border-white/10 bg-slate-950/60 px-2.5 py-1.5">
                        mode: Trusted Domain / GPO
                      </span>
                    )}
                  </div>
                </div>
                {bootstrap.platform === "windows" && (
                  <div className="mt-3 flex gap-2 rounded-lg border border-amber-300/20 bg-amber-300/10 p-3 text-sm font-semibold text-amber-100">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {bootstrap.mode === "gpo"
                        ? "Deploy via GPO as Administrator. Domain-joined machines enroll automatically."
                        : "Run as Administrator: powershell -ExecutionPolicy Bypass -File .\\techi-installer.ps1"}
                    </span>
                  </div>
                )}
              </div>

              {/* ── One-click installer section ─────────────────────────────── */}
              <div className="premium-card-soft overflow-hidden">
                <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-3">
                  <h3 className="text-sm font-semibold text-white">
                    One-click installer
                  </h3>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void copyText("script", bootstrap.bootstrap_script)}
                      className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-100 transition hover:bg-white/[0.08]"
                    >
                      {copied === "script" ? (
                        <Check className="h-3.5 w-3.5 text-emerald-300" />
                      ) : (
                        <Clipboard className="h-3.5 w-3.5" />
                      )}
                      {copied === "script" ? "Copied" : "Copy script"}
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadScript}
                      className="inline-flex items-center gap-2 rounded-md border border-techi-orange/40 bg-techi-orange/10 px-3 py-1.5 text-xs font-semibold text-techi-orange transition hover:bg-techi-orange/20"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download .ps1
                    </button>
                  </div>
                </div>
                <div className="border-b border-white/[0.06] bg-slate-950/60 px-4 py-3">
                  <p className="text-[11px] font-semibold text-slate-400 mb-1">Run command (as Administrator):</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-md bg-slate-900 px-3 py-2 font-mono text-xs text-techi-orange">
                      {bootstrap.bootstrap_command}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyText("command", bootstrap.bootstrap_command)}
                      className="shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-2 text-xs text-slate-200 transition hover:bg-white/[0.08]"
                    >
                      {copied === "command" ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
                <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words p-4 text-[12px] leading-5 text-slate-200">
                  {bootstrap.bootstrap_script}
                </pre>
              </div>
            </>
          )}

          {!bootstrap && (
            <div className="premium-card-soft flex h-48 items-center justify-center">
              <p className="text-sm text-slate-500">Configure settings and click Generate Installer</p>
            </div>
          )}

          {bootstrap && (
            <OutputBlock
              title="Config template (agent.config.json)"
              value={bootstrap.config_template}
              copied={copied === "config"}
              onCopy={() => bootstrap && void copyText("config", bootstrap.config_template)}
            />
          )}

          {bootstrap && (
            <div className="rounded-lg border border-blue-400/15 bg-blue-400/[0.05] p-3 text-sm font-medium text-blue-100">
              <Info className="mr-2 inline h-4 w-4 text-blue-400" />
              {bootstrap.preproduction_notice}
            </div>
          )}
        </div>
      </div>

      {/* ── token table ──────────────────────────────────────────────────────── */}
      <div className="premium-card-soft overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-3">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-techi-orange" />
            <span className="text-sm font-semibold text-white">
              {tokensLoading ? "Loading tokens…" : `${tokens.length} enrollment token${tokens.length === 1 ? "" : "s"}`}
            </span>
            <Badge variant="ghost">{activeTokens.length} active</Badge>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => void openCreateModal()}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Create token
            </Button>
          )}
        </div>

        {/* flash plaintext banner */}
        {flashToken && (
          <div className="flex items-start gap-3 border-b border-amber-400/20 bg-amber-400/[0.08] px-4 py-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-amber-200">
                Copy the plaintext token now — it will not be shown again after reload.
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-slate-900/80 px-2 py-1 font-mono text-[11px] text-amber-100">
                  {flashToken.plaintext}
                </code>
                <button
                  type="button"
                  onClick={() => void copyText("flash", flashToken.plaintext)}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.06] px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.12]"
                >
                  {copied === "flash" ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied === "flash" ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={() => setFlashToken(null)}
                  className="rounded p-1 text-slate-500 transition hover:text-slate-300"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="th-table-head">
              <tr className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Prefix</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Uses</th>
                {canManage && <th className="px-4 py-3">Unique</th>}
                {canManage && <th className="px-4 py-3">Duplicates</th>}
                {canManage && <th className="px-4 py-3">Failed</th>}
                <th className="px-4 py-3">Assignment</th>
                <th className="px-4 py-3">Expires</th>
                <th className="px-4 py-3">Last used</th>
                <th className="px-4 py-3">Created</th>
                {canManage && <th className="px-4 py-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {tokens.length === 0 && (
                <tr>
                  <td colSpan={canManage ? 12 : 8} className="px-4 py-10 text-center text-sm font-medium text-slate-500">
                    {tokensLoading ? "Loading…" : "No enrollment tokens yet."}
                  </td>
                </tr>
              )}
              {tokens.map((token) => (
                <tr
                  key={token.id}
                  className={`text-slate-300 hover:bg-white/[0.025] ${tokenId === String(token.id) ? "bg-techi-orange/[0.04]" : ""}`}
                >
                  <td className="whitespace-nowrap px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {token.is_default && (
                        <span title="Default Deployment Token" className="text-techi-orange">⭐</span>
                      )}
                      <code className="font-mono text-[11px] text-slate-400">
                        {formatTokenPrefix(token.token_prefix)}
                      </code>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-white">
                    {canManage ? (
                      <button type="button" onClick={() => void openDiagnostics(token)} className="hover:text-techi-orange">
                        {token.name}
                      </button>
                    ) : token.name}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">{tokenStatusBadge(token)}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-400">
                    <span className="inline-flex items-center gap-1.5">
                      {token.use_count}/{token.max_uses}
                      {usageWarningBadge(token, canManage ? () => openMaxUsesEditor(token) : undefined)}
                    </span>
                  </td>
                  {canManage && (
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-400">
                      {diagnosticsCache[token.id]?.unique_devices ?? "—"}
                    </td>
                  )}
                  {canManage && (
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-400">
                      {diagnosticsCache[token.id]?.duplicate_enrollments ?? "—"}
                    </td>
                  )}
                  {canManage && (
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-400">
                      {diagnosticsCache[token.id]?.failed_events ?? "—"}
                    </td>
                  )}
                  <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                    {token.client_id ? (
                      <span className="rounded-md bg-slate-800 px-2 py-0.5 text-xs">
                        Client #{token.client_id}
                        {token.group_id ? ` / #${token.group_id}` : ""}
                      </span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                    {token.expires_at ? formatLocalDateTime(token.expires_at) : <span className="text-slate-600">Never</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">
                    {token.used_at ? timeAgo(token.used_at) : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">
                    {formatLocalDateTime(token.created_at)}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" onClick={() => void openDiagnostics(token)} className="th-btn-secondary">
                          <Eye className="mr-1 h-3 w-3" />
                          Diagnostics
                        </Button>
                        {flashToken?.id === token.id && (
                          <button
                            type="button"
                            onClick={() => void copyText(`row-${token.id}`, flashToken.plaintext)}
                            title="Copy plaintext token"
                            className="flex items-center gap-1 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-xs font-semibold text-amber-300 transition hover:bg-amber-400/20"
                          >
                            {copied === `row-${token.id}` ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                            {copied === `row-${token.id}` ? "Copied" : "Copy token"}
                          </button>
                        )}
                        {token.is_default && (
                          <Button
                            size="sm"
                            onClick={() => void handleRegenerateDefault()}
                            disabled={regenerating}
                            className="th-btn-secondary"
                          >
                            <RotateCcw className={`mr-1 h-3 w-3 ${regenerating ? "animate-spin" : ""}`} />
                            Regen
                          </Button>
                        )}
                        {isRevocable(token) && (
                          <Button
                            size="sm"
                            onClick={() => setRevokeTarget(token)}
                            disabled={revoking.has(token.id)}
                            className="th-btn-danger hover:bg-red-500/20"
                          >
                            {revoking.has(token.id) ? "Revoking…" : "Revoke"}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          onClick={() => setDeleteTarget(token)}
                          disabled={deleting}
                          className="th-btn-danger hover:bg-red-500/20"
                        >
                          <Trash2 className="mr-1 h-3 w-3" />
                          Delete
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {diagnosticsToken && (
        <TokenDiagnosticsDrawer
          token={diagnosticsToken}
          diagnostics={diagnostics}
          events={diagnosticsEvents}
          loading={diagnosticsLoading}
          eventsLoading={eventsLoading}
          error={diagnosticsError}
          onLoadMore={() => void loadMoreEvents()}
          onClose={() => {
            setDiagnosticsToken(null);
            setDiagnostics(null);
            setDiagnosticsEvents([]);
            setDiagnosticsError(null);
          }}
        />
      )}

      {/* ── Create Token Modal ────────────────────────────────────────────────── */}
      {createOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="premium-card w-full max-w-md p-5">
            <div className="mb-5 flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">Create Enrollment Token</h3>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="rounded-md p-1 text-slate-400 transition hover:bg-white/[0.06] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-slate-200">Token name *</span>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. ADPascucci — Office PCs"
                  autoFocus
                  onKeyDown={(e) => e.key === "Enter" && void handleCreateToken()}
                  className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white placeholder:text-slate-500 outline-none transition focus:border-techi-orange/60"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-slate-200">Max uses</span>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={newMaxUses}
                  onChange={(e) => setNewMaxUses(Math.max(1, Number(e.target.value)))}
                  className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none transition focus:border-techi-orange/60"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-slate-200">Expires at (optional)</span>
                <input
                  type="datetime-local"
                  value={newExpiry}
                  onChange={(e) => setNewExpiry(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none transition focus:border-techi-orange/60"
                />
              </label>

              {clients.length > 0 && (
                <>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold text-slate-200">
                      Assign to client (optional)
                    </span>
                    <select
                      value={newClientId}
                      onChange={(e) => setNewClientId(e.target.value === "" ? "" : Number(e.target.value))}
                      className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none transition focus:border-techi-orange/60"
                    >
                      <option value="">— No assignment —</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>

                  {newClientId !== "" && groups.length > 0 && (
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-semibold text-slate-200">
                        Assign to group (optional)
                      </span>
                      <select
                        value={newGroupId}
                        onChange={(e) => setNewGroupId(e.target.value === "" ? "" : Number(e.target.value))}
                        className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none transition focus:border-techi-orange/60"
                      >
                        <option value="">— No group —</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>{g.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
            </div>

            <div className="mt-5 flex gap-2">
              <Button
                type="button"
                className="flex-1"
                onClick={() => void handleCreateToken()}
                disabled={!newName.trim() || creating}
              >
                {creating ? "Creating…" : "Create & Select"}
              </Button>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                disabled={creating}
                className="th-btn-secondary rounded-lg border px-4 py-2 text-sm font-semibold transition hover:border-white/20 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Raise Max Uses Modal ─────────────────────────────────────────────── */}
      {editMaxUsesTarget && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="premium-card w-full max-w-md p-5">
            <div className="mb-5 flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">Raise Max Uses</h3>
              <button
                type="button"
                onClick={() => setEditMaxUsesTarget(null)}
                className="rounded-md p-1 text-slate-400 transition hover:bg-white/[0.06] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mb-4 text-sm text-slate-300">
              <span className="font-semibold text-white">{editMaxUsesTarget.name}</span> is at{" "}
              <span className="font-mono">
                {editMaxUsesTarget.use_count}/{editMaxUsesTarget.max_uses}
              </span>{" "}
              ({usagePercent(editMaxUsesTarget)}%) of its enrollment limit.
              {editMaxUsesTarget.status === "used" &&
                " Raising the limit above the current use count reactivates the token."}
            </p>

            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-200">Max uses</span>
              <input
                type="number"
                min={1}
                max={1000000}
                value={editMaxUses}
                autoFocus
                onChange={(e) => setEditMaxUses(Math.max(1, Number(e.target.value)))}
                onKeyDown={(e) => e.key === "Enter" && void handleSaveMaxUses()}
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none transition focus:border-techi-orange/60"
              />
            </label>

            <div className="mt-5 flex gap-2">
              <Button
                type="button"
                className="flex-1"
                onClick={() => void handleSaveMaxUses()}
                disabled={savingMaxUses}
              >
                {savingMaxUses ? "Saving…" : "Save"}
              </Button>
              <button
                type="button"
                onClick={() => setEditMaxUsesTarget(null)}
                disabled={savingMaxUses}
                className="th-btn-secondary rounded-lg border px-4 py-2 text-sm font-semibold transition hover:border-white/20 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {revokeTarget && (
        <ConfirmationModal
          title="Revoke enrollment token"
          confirmLabel={revoking.has(revokeTarget.id) ? "Revoking" : "Revoke"}
          loading={revoking.has(revokeTarget.id)}
          onClose={() => setRevokeTarget(null)}
          onConfirm={() => void handleRevoke(revokeTarget)}
        >
          Revoke <span className="font-semibold text-white">{revokeTarget.name}</span>? Existing installers with this token will stop enrolling new devices.
        </ConfirmationModal>
      )}

      {deleteTarget && (
        <ConfirmationModal
          title="Delete enrollment token"
          confirmLabel={deleting ? "Deleting" : "Delete"}
          loading={deleting}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void handleDeleteToken()}
        >
          Permanently delete <span className="font-semibold text-white">{deleteTarget.name}</span>?
          {deleteTarget.status === "active" && " This token is active and this action cannot be undone."}
          {deleteTarget.is_default && deleteTarget.status === "active" && " Regenerate or revoke the Default Deployment token first unless you are intentionally removing it."}
        </ConfirmationModal>
      )}

      {/* ── Toasts ───────────────────────────────────────────────────────────── */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold shadow-xl ${
              toast.type === "success" ? "bg-emerald-600 text-white" : "bg-red-600 text-white"
            }`}
          >
            {toast.type === "success" ? (
              <Check className="h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0" />
            )}
            {toast.message}
          </div>
        ))}
      </div>
    </section>
  );
}

function diagnosticValue(value?: number | null): string {
  return value === null || value === undefined ? "Unknown" : String(value);
}

function resultBadgeClass(result: EnrollmentAuditEvent["result"]): string {
  if (result === "failed") return "border-red-400/25 bg-red-400/10 text-red-300";
  if (result === "duplicate" || result === "updated_existing") {
    return "border-amber-400/25 bg-amber-400/10 text-amber-300";
  }
  if (result === "ignored") return "border-slate-500/25 bg-slate-500/10 text-slate-400";
  return "border-emerald-400/25 bg-emerald-400/10 text-emerald-300";
}

function TokenDiagnosticsDrawer({
  token,
  diagnostics,
  events,
  loading,
  eventsLoading,
  error,
  onLoadMore,
  onClose,
}: {
  token: EnrollmentToken;
  diagnostics: EnrollmentTokenDiagnostics | null;
  events: EnrollmentAuditEvent[];
  loading: boolean;
  eventsLoading: boolean;
  error: string | null;
  onLoadMore: () => void;
  onClose: () => void;
}) {
  const metrics = [
    ["Uses", `${token.use_count} / ${token.max_uses}`],
    ["Unique devices", diagnosticValue(diagnostics?.unique_devices)],
    ["Duplicate / re-enrollments", diagnosticValue(diagnostics?.duplicate_enrollments)],
    ["Failed attempts", diagnosticValue(diagnostics?.failed_events)],
    ["Orphaned uses", diagnosticValue(diagnostics?.orphaned_uses)],
    ["Archived devices", diagnosticValue(diagnostics?.archived_devices)],
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-sm" onMouseDown={onClose}>
      <aside
        className="flex h-full w-full max-w-6xl flex-col border-l border-white/10 bg-[var(--th-bg-surface)] shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-white/[0.08] px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-techi-orange">Token Diagnostics</p>
            <h2 className="mt-1 text-lg font-semibold text-white">{token.name}</h2>
            <p className="mt-1 font-mono text-xs text-slate-500">{formatTokenPrefix(token.token_prefix)}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-white/5 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Loading diagnostics…
            </div>
          )}
          {error && <div className="mb-4 rounded-lg border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{error}</div>}
          {!loading && diagnostics && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {metrics.map(([label, value]) => (
                  <div key={label} className="premium-card-soft p-4">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
                    <p className="mt-2 text-xl font-semibold text-white">{value}</p>
                  </div>
                ))}
              </div>

              {diagnostics.inference_note && (
                <div className="mt-4 flex gap-2 rounded-lg border border-blue-400/15 bg-blue-400/[0.06] p-3 text-xs leading-5 text-blue-100">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
                  <span>
                    {diagnostics.inferred && <strong className="mr-1">Inferred:</strong>}
                    {diagnostics.inference_note}
                  </span>
                </div>
              )}

              <div className="mt-6 overflow-hidden rounded-xl border border-white/[0.08]">
                <div className="border-b border-white/[0.08] px-4 py-3">
                  <h3 className="text-sm font-semibold text-white">Enrollment History</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1050px] text-left text-xs">
                    <thead className="th-table-head">
                      <tr className="uppercase tracking-wide text-slate-500">
                        <th className="px-3 py-3">Time</th>
                        <th className="px-3 py-3">Hostname</th>
                        <th className="px-3 py-3">User</th>
                        <th className="px-3 py-3">Device</th>
                        <th className="px-3 py-3">RustDesk ID</th>
                        <th className="px-3 py-3">Result</th>
                        <th className="px-3 py-3">Reason</th>
                        <th className="px-3 py-3">IP</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.05]">
                      {!events.length && (
                        <tr><td colSpan={8} className="px-3 py-10 text-center text-slate-500">No enrollment audit events recorded.</td></tr>
                      )}
                      {events.map((event) => (
                        <tr key={event.id} className="text-slate-300">
                          <td className="whitespace-nowrap px-3 py-3 text-slate-500">{formatLocalDateTime(event.created_at)}</td>
                          <td className="px-3 py-3 font-semibold text-white">{event.hostname || "—"}</td>
                          <td className="px-3 py-3">{event.username || "—"}</td>
                          <td className="px-3 py-3">{event.device_id ? `#${event.device_id}` : "—"}</td>
                          <td className="px-3 py-3 font-mono">{event.rustdesk_id || "—"}</td>
                          <td className="px-3 py-3">
                            <span className={`inline-flex rounded-full border px-2 py-0.5 font-semibold ${resultBadgeClass(event.result)}`}>
                              {event.result.replace("_", " ")}
                            </span>
                          </td>
                          <td className="max-w-[240px] truncate px-3 py-3" title={event.raw_error || event.reason || ""}>
                            {event.reason || event.raw_error || "—"}
                          </td>
                          <td className="px-3 py-3 font-mono text-slate-400">{event.public_ip || event.local_ip || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {events.length > 0 && events.length % 50 === 0 && (
                  <div className="flex justify-center border-t border-white/[0.08] p-3">
                    <Button size="sm" onClick={onLoadMore} disabled={eventsLoading} className="th-btn-secondary">
                      {eventsLoading ? "Loading…" : "Load more"}
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

interface OutputBlockProps {
  title: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}

function OutputBlock({ title, value, copied, onCopy }: OutputBlockProps) {
  return (
    <div className="premium-card-soft overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-100 transition hover:bg-white/[0.08]"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-300" />
          ) : (
            <Clipboard className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words p-4 text-[12px] leading-5 text-slate-200">
        {value}
      </pre>
    </div>
  );
}
