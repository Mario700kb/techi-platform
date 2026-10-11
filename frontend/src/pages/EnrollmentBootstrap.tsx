import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  Check,
  Copy,
  Download,
  FileCode2,
  Info,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Star,
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
import { API_BASE_URL } from "../api/client";
import { Button, EmptyState, PageHeader, Select, SelectField } from "../components/ui";
import TablePagination from "../components/ui/TablePagination";
import { TokenStatusChip, UsageMeter, TOKEN_FILTERS, TokenFilter, formatTokenPrefix, tokenState, usagePercent } from "../components/EnrollmentTokenBits";
import { TERMS, TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { formatLocalDateTime, timeAgo, tiranaInputToUtcIso } from "../utils/time";

async function validateBackendReachable(url: string): Promise<void> {
  const base = url.trim().replace(/\/+$/, "");
  const response = await fetch(`${base}/health`, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Backend health check failed (${response.status})`);
  }
}

type Toast = { id: number; message: string; type: "success" | "error" };

const PLATFORMS: { id: EnrollmentBootstrapPlatform; label: string }[] = [
  { id: "windows", label: "Windows" },
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
];

const SECURITY_POINTS = [
  "The lock screen stays on. Remote access runs through the TechiAgent and Remote Support services, not a signed-in session.",
  "A device that sleeps or hibernates is unreachable unless Wake-on-LAN is set up.",
  "Choose the Server profile for machines that must stay reachable on AC power.",
];

function isRevocable(token: EnrollmentToken): boolean {
  return token.status === "active" || token.status === "used";
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
  const [backendUrl, setBackendUrl] = useState(API_BASE_URL);
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

  // ── token table view ─────────────────────────────────────────────────────
  const [statusFilter, setStatusFilter] = useState<TokenFilter>("all");
  const [tokenSearch, setTokenSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [clientNames, setClientNames] = useState<Record<number, string>>({});

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
  const statusCounts = useMemo(() => {
    const counts = { all: tokens.length, active: 0, unused: 0, used: 0, revoked: 0, expired: 0 } as Record<TokenFilter, number>;
    for (const t of tokens) counts[tokenState(t)] += 1;
    return counts;
  }, [tokens]);
  const visibleTokens = useMemo(() => {
    const q = tokenSearch.trim().toLowerCase();
    return tokens.filter((t) => {
      if (statusFilter !== "all" && tokenState(t) !== statusFilter) return false;
      if (!q) return true;
      const client = t.client_id ? clientNames[t.client_id] ?? "" : "";
      return [t.name, t.token_prefix ?? "", client].some((v) => v.toLowerCase().includes(q));
    });
  }, [tokens, statusFilter, tokenSearch, clientNames]);
  const pagedTokens = useMemo(() => visibleTokens.slice((page - 1) * pageSize, page * pageSize), [visibleTokens, page, pageSize]);
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
    getClients()
      .then((list) => setClientNames(Object.fromEntries(list.map((c) => [c.id, c.name]))))
      .catch(() => setClientNames({}));
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
    <section className="premium-page th-onb space-y-4">
      <PageHeader
        title="Enrollment Bootstrap"
        description={<>Generate a one-click installer for new endpoints. Use <strong>Token enrollment</strong> for workgroup PCs and tests, <strong>Trusted domain / GPO</strong> for domain-joined fleets.</>}
        actions={
          <Button variant="secondary" size="sm" type="button" onClick={() => void loadTokens()} disabled={tokensLoading}>
            <RefreshCcw className={`h-3.5 w-3.5 ${tokensLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      {warningTokens.length > 0 && (
        <div className="th-onb-note" style={{ "--onb-tone": "var(--th-status-warning)" } as React.CSSProperties} role="status">
          <AlertTriangle className="h-4 w-4" />
          <div className="min-w-0 flex-1">
            <p className="font-medium" style={{ color: "var(--th-text-primary)" }}>
              {warningTokens.length} token{warningTokens.length === 1 ? " is" : "s are"} close to the enrollment limit
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {warningTokens.map((token) => (
                <button
                  key={token.id}
                  type="button"
                  className="th-status-chip"
                  disabled={!canManage}
                  onClick={() => openMaxUsesEditor(token)}
                  style={{ "--chip-tone": token.usage_warning === "critical" ? "var(--th-status-critical)" : "var(--th-status-warning)" } as React.CSSProperties}
                  title={canManage ? "Raise max uses" : undefined}
                >
                  <i />
                  {token.name}
                  <span className="tabular-nums" style={{ color: "var(--th-text-muted)" }}>{token.use_count}/{token.max_uses}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── default token · security model ──────────────────────────────── */}
      <div className="grid items-stretch gap-4 lg:grid-cols-2">
        <div className="th-onb-card">
          <div className="th-onb-card-head">
            <div className="th-onb-card-title">
              <span className="th-onb-icon" style={{ "--onb-tone": defaultToken?.status === "active" ? "var(--th-status-online)" : "var(--th-status-warning)" } as React.CSSProperties}>
                <KeyRound className="h-4 w-4" />
              </span>
              <span>
                Default deployment token
                <small>Used by installers that do not name a token</small>
              </span>
            </div>
            {defaultToken && <TokenStatusChip token={defaultToken} />}
          </div>
          <div className="th-onb-body flex-1 justify-between !gap-4">
            {defaultToken ? (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <div className="min-w-0">
                  <div className="th-onb-label">Name</div>
                  <div className="mt-1 truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>{defaultToken.name}</div>
                </div>
                <div>
                  <div className="th-onb-label">Prefix</div>
                  <code className="mt-1 block font-mono text-[12px]" style={{ color: "var(--th-text-secondary)" }}>{formatTokenPrefix(defaultToken.token_prefix)}</code>
                </div>
                <div>
                  <div className="th-onb-label">Usage</div>
                  <div className="mt-1.5"><UsageMeter token={defaultToken} /></div>
                </div>
              </div>
            ) : (
              <p className="th-onb-hint">No default deployment token exists. Regenerate to create one.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {activeDefault && mode === "token" && (
                <Button size="sm" variant="secondary" onClick={handleUseDefault} disabled={tokenId === String(activeDefault.id)}>
                  {tokenId === String(activeDefault.id) ? <><Check className="h-3.5 w-3.5" />Selected in generator</> : "Use in generator"}
                </Button>
              )}
              {canManage && (
                <Button size="sm" variant="secondary" onClick={() => void handleRegenerateDefault()} disabled={regenerating}>
                  <RotateCcw className={`h-3.5 w-3.5 ${regenerating ? "animate-spin" : ""}`} />
                  {regenerating ? "Regenerating…" : "Regenerate"}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="th-onb-card">
          <div className="th-onb-card-head">
            <div className="th-onb-card-title">
              <span className="th-onb-icon" style={{ "--onb-tone": "var(--th-status-info)" } as React.CSSProperties}>
                <ShieldCheck className="h-4 w-4" />
              </span>
              <span>
                Security model
                <small>How managed endpoints stay reachable</small>
              </span>
            </div>
          </div>
          <ul className="th-onb-body flex-1 !gap-3">
            {SECURITY_POINTS.map((point) => (
              <li key={point} className="flex gap-2.5 text-[13px] leading-5" style={{ color: "var(--th-text-secondary)" }}>
                <Check className="mt-0.5 h-4 w-4 flex-none" style={{ color: "var(--th-status-info)" }} />
                {point}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ── generator · output ──────────────────────────────────────────── */}
      <div className="grid items-stretch gap-4 xl:grid-cols-2">
        <div className="th-onb-card">
          <div className="th-onb-card-head">
            <div className="th-onb-card-title">
              <span className="th-onb-icon" style={{ "--onb-tone": "var(--th-accent)" } as React.CSSProperties}>
                <SlidersHorizontal className="h-4 w-4" />
              </span>
              <span>
                Generator
                <small>Deployment, connection and device policy</small>
              </span>
            </div>
          </div>

          <div className="th-onb-body flex-1">
            <div className="th-onb-section">
              <span className="th-onb-label">Deployment mode</span>
              <div className="th-segmented" role="radiogroup" aria-label="Deployment mode">
                {(["token", "gpo"] as const).map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
                    {m === "token" ? "Token enrollment" : "Trusted domain / GPO"}
                  </button>
                ))}
              </div>

              {mode === "gpo" && (
                <div className="th-onb-note" style={{ "--onb-tone": "var(--th-status-warning)" } as React.CSSProperties}>
                  <Info className="h-4 w-4" />
                  <ul className="space-y-1">
                    <li><strong>Domain-joined PCs</strong> enroll without a token. The backend needs <code className="font-mono">TRUSTED_DOMAIN_AUTO_ENROLLMENT=true</code>.</li>
                    <li><strong>WORKGROUP PCs</strong> do not enroll through GPO; use Token enrollment for them.</li>
                    <li>The script is idempotent, so it is safe to run at every startup.</li>
                  </ul>
                </div>
              )}

              {mode === "token" && (
                <>
                  <div className="th-onb-field">
                    <span className="flex items-center justify-between">
                      Enrollment token
                      {canManage && (
                        <button type="button" onClick={() => void openCreateModal()} className="th-onb-link">
                          <Plus className="h-3.5 w-3.5" />
                          New token
                        </button>
                      )}
                    </span>
                    <Select
                      id="deployment-token"
                      aria-label="Deployment token"
                      value={tokenId}
                      onChange={(value) => { setTokenId(value); setPlaintextToken(""); }}
                      placeholder={activeTokens.length === 0 ? "No active tokens: create one" : "Select a token"}
                      options={activeTokens.map((t) => ({
                        value: String(t.id),
                        label: `${t.name}${t.is_default ? " · default" : ""}`,
                        hint: `#${t.id} · ${t.use_count}/${t.max_uses} uses`,
                      }))}
                    />
                  </div>
                  <label className="th-onb-field">
                    <span className="flex items-center gap-2">
                      Plaintext token
                      {plaintextToken && <span className="th-status-chip !h-5 !px-2 !text-[11px]" style={{ "--chip-tone": "var(--th-status-online)" } as React.CSSProperties}><i />Filled</span>}
                    </span>
                    <input
                      value={plaintextToken}
                      onChange={(e) => setPlaintextToken(e.target.value)}
                      placeholder="Filled after New token, or paste it here"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </label>
                </>
              )}
            </div>

            <div className="th-onb-section">
              <span className="th-onb-label">Connection</span>
              <label className="th-onb-field">
                Backend URL
                <input value={backendUrl} onChange={(e) => setBackendUrl(e.target.value)} spellCheck={false} />
              </label>
              {isLocalhost && (
                <div className="th-onb-note" style={{ "--onb-tone": "var(--th-status-warning)" } as React.CSSProperties}>
                  <AlertTriangle className="h-4 w-4" />
                  <span>localhost only reaches this machine. Real devices need the server&apos;s public URL.</span>
                </div>
              )}
              <div className="th-onb-field">
                Platform
                <div className="th-segmented" role="radiogroup" aria-label="Platform">
                  {PLATFORMS.map((p) => (
                    <button key={p.id} type="button" role="radio" aria-checked={platform === p.id} onClick={() => setPlatform(p.id)}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {platform === "windows" && (
              <div className="th-onb-section">
                <span className="th-onb-label">Device policy</span>
                <div className="th-onb-field">
                  Availability profile
                  <div className="th-segmented" role="radiogroup" aria-label="Availability profile">
                    {(["server", "workstation", "custom"] as AvailabilityProfile[]).map((p) => (
                      <button key={p} type="button" role="radio" aria-checked={availProfile === p} onClick={() => setAvailProfile(p)}>
                        {PROFILE_INFO[p].label}
                      </button>
                    ))}
                  </div>
                  <p className="th-onb-hint">{PROFILE_INFO[availProfile].description}</p>
                </div>

                <label className="th-onb-check">
                  <input type="checkbox" checked={managePower} onChange={(e) => setManagePower(e.target.checked)} />
                  <span>
                    Apply power policy on agent startup
                    <small>{availProfile === "server" ? "Sleep and hibernate are disabled on AC power." : "Uses the switches below."}</small>
                  </span>
                </label>
                {managePower && availProfile !== "server" && (
                  <div className="th-onb-sub">
                    <label className="th-onb-check"><input type="checkbox" checked={preventSleepAC} onChange={(e) => setPreventSleepAC(e.target.checked)} /><span>Prevent sleep on AC power</span></label>
                    <label className="th-onb-check"><input type="checkbox" checked={preventHibernate} onChange={(e) => setPreventHibernate(e.target.checked)} /><span>Disable hibernate</span></label>
                    <label className="th-onb-check"><input type="checkbox" checked={allowDisplayOff} onChange={(e) => setAllowDisplayOff(e.target.checked)} /><span>Allow display off on AC <small>Recommended</small></span></label>
                  </div>
                )}

                <label className="th-onb-check">
                  <input type="checkbox" checked={rustdeskEnabled} onChange={(e) => setRustdeskEnabled(e.target.checked)} />
                  <span>
                    {TERMS.remoteSupport} self-healing
                    <small>The agent installs, configures and keeps {TERMS.remoteSupport} running.</small>
                  </span>
                </label>
                {rustdeskEnabled && (
                  <div className="th-onb-sub sm:grid-cols-2">
                    {(
                      [
                        { label: "MSI URL", value: rustdeskMsiUrl, set: setRustdeskMsiUrl, placeholder: "https://…/TECHI-Remote-Support.msi" },
                        { label: "Rendezvous server", value: rustdeskRendezvous, set: setRustdeskRendezvous, placeholder: "Host or IP" },
                        { label: "Relay server", value: rustdeskRelay, set: setRustdeskRelay, placeholder: "Host or IP" },
                        { label: "API server", value: rustdeskApi, set: setRustdeskApi, placeholder: "Leave empty unless you run one" },
                        { label: "Public key", value: rustdeskKey, set: setRustdeskKey, placeholder: "Base64 key" },
                        { label: "Default password", value: rustdeskPassword, set: setRustdeskPassword, placeholder: "Initial password" },
                      ] as const
                    ).map(({ label, value, set, placeholder }) => (
                      <label key={label} className="th-onb-field">
                        {label}
                        <input value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder} spellCheck={false} autoComplete="off" />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="th-onb-foot space-y-3">
            {error && (
              <div className="th-onb-note" style={{ "--onb-tone": "var(--th-status-critical)" } as React.CSSProperties} role="alert">
                <AlertTriangle className="h-4 w-4" />
                <span>{error}</span>
              </div>
            )}
            <Button className="w-full" type="button" onClick={() => void handleGenerate()} disabled={loading || !canGenerate || !backendUrl.trim()}>
              {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Terminal className="h-4 w-4" />}
              {loading ? "Generating…" : "Generate installer"}
            </Button>
          </div>
        </div>

        <div className="th-onb-card">
          <div className="th-onb-card-head">
            <div className="th-onb-card-title">
              <span className="th-onb-icon" style={{ "--onb-tone": bootstrap ? "var(--th-status-online)" : "var(--th-text-faint)" } as React.CSSProperties}>
                <FileCode2 className="h-4 w-4" />
              </span>
              <span>
                Installer
                <small>{bootstrap ? "Ready to run as Administrator" : "Appears here once generated"}</small>
              </span>
            </div>
            {bootstrap && (
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => void copyText("script", bootstrap.bootstrap_script)}>
                  {copied === "script" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied === "script" ? "Copied" : "Copy script"}
                </Button>
                <Button size="sm" onClick={handleDownloadScript}>
                  <Download className="h-3.5 w-3.5" />
                  Download .ps1
                </Button>
              </div>
            )}
          </div>

          {bootstrap ? (
            <div className="th-onb-body flex-1 th-fade-in">
              <dl className="th-onb-meta">
                <div><dt>Target</dt><dd>{bootstrap.mode === "gpo" ? "Trusted domain / GPO" : bootstrap.platform === "windows" ? "Windows service" : `${bootstrap.platform} bootstrap`}</dd></div>
                <div><dt>Platform</dt><dd className="capitalize">{bootstrap.platform}</dd></div>
                <div><dt>Backend</dt><dd title={bootstrap.backend_url}>{bootstrap.backend_url}</dd></div>
                <div>
                  <dt>{bootstrap.mode === "gpo" ? "Enrollment" : "Token"}</dt>
                  <dd>{bootstrap.mode === "gpo" ? "Domain trust" : selectedToken ? selectedToken.name : bootstrap.enrollment_token_id ? `#${bootstrap.enrollment_token_id}` : "—"}</dd>
                </div>
              </dl>

              <div className="th-onb-field">
                Run command
                <div className="flex items-stretch gap-2">
                  <code className="th-onb-code min-w-0 flex-1 truncate px-3 py-2">{bootstrap.bootstrap_command}</code>
                  <button type="button" className="th-onb-action !h-auto !w-9 border" style={{ borderColor: "var(--th-border-subtle)" }} onClick={() => void copyText("command", bootstrap.bootstrap_command)} aria-label="Copy run command">
                    {copied === "command" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>

              <div className="th-onb-field">
                Script
                <pre className="th-onb-code max-h-[320px] overflow-auto whitespace-pre-wrap break-words p-3">{bootstrap.bootstrap_script}</pre>
              </div>

              <OutputBlock
                title="Config template (agent.config.json)"
                value={bootstrap.config_template}
                copied={copied === "config"}
                onCopy={() => void copyText("config", bootstrap.config_template)}
              />

              {bootstrap.preproduction_notice && (
                <div className="th-onb-note" style={{ "--onb-tone": "var(--th-status-info)" } as React.CSSProperties}>
                  <Info className="h-4 w-4" />
                  <span>{bootstrap.preproduction_notice}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="th-onb-empty">
              <EmptyState
                icon={<Terminal className="h-5 w-5" />}
                title="No installer yet"
                description="Choose the deployment mode, token and device policy, then generate. The PowerShell script and a copy-ready command appear here."
              />
            </div>
          )}
        </div>
      </div>

      {/* ── tokens ──────────────────────────────────────────────────────── */}
      <div className="th-alerts-card th-onb-tokens">
        <div className="th-onb-card-head">
          <div className="th-onb-card-title">
            <span className="th-onb-icon" style={{ "--onb-tone": "var(--th-accent)" } as React.CSSProperties}>
              <KeyRound className="h-4 w-4" />
            </span>
            <span>
              Enrollment tokens
              <small>{tokensLoading && tokens.length === 0 ? "Loading…" : `${formatCount(tokens.length)} total · ${formatCount(activeTokens.length)} active`}</small>
            </span>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => void openCreateModal()}>
              <Plus className="h-3.5 w-3.5" />
              New token
            </Button>
          )}
        </div>

        {flashToken && (
          <div className="th-onb-flash">
            <Info className="h-4 w-4 flex-none" style={{ color: "var(--th-status-warning)" }} />
            <span className="flex-none text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>Copy the token now; it is not shown again.</span>
            <code className="th-onb-code min-w-0 flex-1 truncate px-2.5 py-1">{flashToken.plaintext}</code>
            <Button size="sm" variant="secondary" onClick={() => void copyText("flash", flashToken.plaintext)}>
              {copied === "flash" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied === "flash" ? "Copied" : "Copy"}
            </Button>
            <button type="button" className="th-onb-action" onClick={() => setFlashToken(null)} aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="th-alerts-toolbar">
          <div role="tablist" aria-label="Token status" className="th-tabs">
            {TOKEN_FILTERS.map(({ id, label }) => (
              <button key={id} type="button" role="tab" aria-selected={statusFilter === id} onClick={() => { setStatusFilter(id); setPage(1); }} className="th-tab">
                {label}
                <span className="th-tab-count">{formatCount(statusCounts[id])}</span>
              </button>
            ))}
          </div>
          <div className="pb-2">
            <label className="th-search th-search-sm w-[260px]">
              <Search className="h-3.5 w-3.5 flex-none" />
              <input value={tokenSearch} onChange={(e) => { setTokenSearch(e.target.value); setPage(1); }} placeholder="Search tokens or clients" aria-label="Search tokens" />
              {tokenSearch && (
                <button type="button" onClick={() => setTokenSearch("")} className="th-explorer-clear" aria-label="Clear search">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </label>
          </div>
        </div>

        {tokensLoading && tokens.length === 0 ? (
          <div className="th-alerts-scroll" aria-busy="true" aria-label="Loading tokens">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.12 }} />
            ))}
          </div>
        ) : visibleTokens.length === 0 ? (
          <EmptyState
            className="th-fade-in py-10"
            icon={<KeyRound className="h-5 w-5" />}
            title={tokens.length === 0 ? "No enrollment tokens yet" : "No tokens match these filters"}
            action={tokens.length > 0 ? <Button size="sm" variant="secondary" onClick={() => { setStatusFilter("all"); setTokenSearch(""); }}>Clear filters</Button> : undefined}
          />
        ) : (
          <div className="th-alerts-scroll th-table-scroll">
            <table className="th-alerts-table">
              <colgroup>
                <col />
                <col className="w-[120px]" />
                <col className="w-[160px]" />
                <col className="w-[18%]" />
                <col className="w-[120px]" />
                <col className="w-[120px]" />
                <col className="w-[148px]" />
                {canManage && <col className="w-[168px]" />}
              </colgroup>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Status</th>
                  <th>Usage</th>
                  <th>Client</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  <th>Created</th>
                  {canManage && <th className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {pagedTokens.map((token) => (
                  <tr key={token.id} data-selected={tokenId === String(token.id) || undefined}>
                    <td>
                      <span className="th-alerts-primary flex items-center gap-1.5">
                        {token.is_default && <Star className="h-3.5 w-3.5 flex-none" style={{ color: "var(--th-accent)", fill: "var(--th-accent)" }} aria-label="Default deployment token" />}
                        {canManage ? (
                          <button type="button" className="th-alerts-link truncate text-left" onClick={() => void openDiagnostics(token)}>{token.name}</button>
                        ) : (
                          <span className="truncate">{token.name}</span>
                        )}
                      </span>
                      <span className="th-alerts-secondary font-mono">{formatTokenPrefix(token.token_prefix)}</span>
                    </td>
                    <td><TokenStatusChip token={token} /></td>
                    <td>
                      {canManage ? (
                        <button type="button" className="text-left" onClick={() => openMaxUsesEditor(token)} title="Change max uses">
                          <UsageMeter token={token} />
                        </button>
                      ) : (
                        <UsageMeter token={token} />
                      )}
                    </td>
                    <td>
                      {token.client_id ? (
                        <span className="th-alerts-primary" title={token.group_id ? `Group #${token.group_id}` : undefined}>
                          {clientNames[token.client_id] ?? `Client #${token.client_id}`}
                        </span>
                      ) : (
                        <span className="th-alerts-secondary">Any client</span>
                      )}
                    </td>
                    <td>
                      {token.last_used_at ? (
                        <span className="th-alerts-primary" title={formatLocalDateTime(token.last_used_at)}>{timeAgo(token.last_used_at)}</span>
                      ) : (
                        <span className="th-alerts-secondary">Never</span>
                      )}
                    </td>
                    <td>
                      {token.expires_at ? (
                        <span className="th-alerts-primary">{formatLocalDateTime(token.expires_at)}</span>
                      ) : (
                        <span className="th-alerts-secondary">Never</span>
                      )}
                    </td>
                    <td><span className="th-alerts-secondary !mt-0 tabular-nums">{formatLocalDateTime(token.created_at)}</span></td>
                    {canManage && (
                      <td>
                        <div className="th-onb-actions">
                          <button type="button" className="th-onb-action" title="Diagnostics" aria-label={`Diagnostics for ${token.name}`} onClick={() => void openDiagnostics(token)}>
                            <Activity className="h-4 w-4" />
                          </button>
                          {flashToken?.id === token.id && (
                            <button type="button" className="th-onb-action" title="Copy plaintext token" aria-label={`Copy ${token.name}`} onClick={() => void copyText(`row-${token.id}`, flashToken.plaintext)}>
                              {copied === `row-${token.id}` ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                            </button>
                          )}
                          {token.is_default && (
                            <button type="button" className="th-onb-action" title="Regenerate" aria-label="Regenerate default token" disabled={regenerating} onClick={() => void handleRegenerateDefault()}>
                              <RotateCcw className={`h-4 w-4 ${regenerating ? "animate-spin" : ""}`} />
                            </button>
                          )}
                          {isRevocable(token) && (
                            <button type="button" className="th-onb-action" data-tone="danger" title="Revoke" aria-label={`Revoke ${token.name}`} disabled={revoking.has(token.id)} onClick={() => setRevokeTarget(token)}>
                              <Ban className="h-4 w-4" />
                            </button>
                          )}
                          <button type="button" className="th-onb-action" data-tone="danger" title="Delete" aria-label={`Delete ${token.name}`} disabled={deleting} onClick={() => setDeleteTarget(token)}>
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {visibleTokens.length > 0 && (
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={visibleTokens.length}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
            pageSizeOptions={[25, 50, 100]}
            itemLabel="tokens"
          />
        )}
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
        <div className="th-modal-scrim fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
          <div className="th-modal w-full max-w-md rounded-xl p-5 shadow-2xl" style={{ border: "1px solid var(--th-border-card)", background: "var(--th-bg-surface)" }}>
            <div className="mb-5 flex items-center justify-between">
              <h3 className="text-base font-semibold" style={{ color: "var(--th-text-primary)" }}>New enrollment token</h3>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="th-onb-action" aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              <label className="th-onb-field">
                Token name *
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. ADPascucci — Office PCs"
                  autoFocus
                  onKeyDown={(e) => e.key === "Enter" && void handleCreateToken()}
                  className="w-full"
                />
              </label>

              <label className="th-onb-field">
                Max uses
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={newMaxUses}
                  onChange={(e) => setNewMaxUses(Math.max(1, Number(e.target.value)))}
                  className="w-full"
                />
              </label>

              <label className="th-onb-field">
                Expires (Tirana time, optional)
                <input
                  type="datetime-local"
                  value={newExpiry}
                  onChange={(e) => setNewExpiry(e.target.value)}
                  className="w-full"
                />
              </label>

              {clients.length > 0 && (
                <>
                  <label className="th-onb-field">
                    Assign to client (optional)
                    <SelectField
                      value={newClientId}
                      onChange={(e) => setNewClientId(e.target.value === "" ? "" : Number(e.target.value))}
                      className="w-full"
                    >
                      <option value="">— No assignment —</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </SelectField>
                  </label>

                  {newClientId !== "" && groups.length > 0 && (
                    <label className="th-onb-field">
                      Assign to group (optional)
                      <SelectField
                        value={newGroupId}
                        onChange={(e) => setNewGroupId(e.target.value === "" ? "" : Number(e.target.value))}
                        className="w-full"
                      >
                        <option value="">— No group —</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>{g.name}</option>
                        ))}
                      </SelectField>
                    </label>
                  )}
                </>
              )}
            </div>

            <div className="mt-5 flex flex-row-reverse gap-2">
              <Button
                type="button"
                
                onClick={() => void handleCreateToken()}
                disabled={!newName.trim() || creating}
              >
                {creating ? "Creating…" : "Create and select"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Change max uses Modal ─────────────────────────────────────────────── */}
      {editMaxUsesTarget && (
        <div className="th-modal-scrim fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
          <div className="th-modal w-full max-w-md rounded-xl p-5 shadow-2xl" style={{ border: "1px solid var(--th-border-card)", background: "var(--th-bg-surface)" }}>
            <div className="mb-5 flex items-center justify-between">
              <h3 className="text-base font-semibold" style={{ color: "var(--th-text-primary)" }}>Change max uses</h3>
              <button
                type="button"
                onClick={() => setEditMaxUsesTarget(null)}
                className="th-onb-action" aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mb-4 text-sm leading-6" style={{ color: "var(--th-text-secondary)" }}>
              <span className="font-semibold" style={{ color: "var(--th-text-primary)" }}>{editMaxUsesTarget.name}</span> is at{" "}
              <span className="font-mono">
                {editMaxUsesTarget.use_count}/{editMaxUsesTarget.max_uses}
              </span>{" "}
              ({usagePercent(editMaxUsesTarget)}%) of its enrollment limit.
              {editMaxUsesTarget.status === "used" &&
                " Raising the limit above the current use count reactivates the token."}
            </p>

            <label className="th-onb-field">
              Max uses
              <input
                type="number"
                min={1}
                max={1000000}
                value={editMaxUses}
                autoFocus
                onChange={(e) => setEditMaxUses(Math.max(1, Number(e.target.value)))}
                onKeyDown={(e) => e.key === "Enter" && void handleSaveMaxUses()}
                className="w-full"
              />
            </label>

            <div className="mt-5 flex flex-row-reverse gap-2">
              <Button
                type="button"
                
                onClick={() => void handleSaveMaxUses()}
                disabled={savingMaxUses}
              >
                {savingMaxUses ? "Saving…" : "Save"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditMaxUsesTarget(null)} disabled={savingMaxUses}>Cancel</Button>
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
          Revoke <span className="font-semibold" style={{ color: "var(--th-text-primary)" }}>{revokeTarget.name}</span>? Existing installers with this token will stop enrolling new devices.
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
          Permanently delete <span className="font-semibold" style={{ color: "var(--th-text-primary)" }}>{deleteTarget.name}</span>?
          {deleteTarget.status === "active" && " This token is active and this action cannot be undone."}
          {deleteTarget.is_default && deleteTarget.status === "active" && " Regenerate or revoke the Default Deployment token first unless you are intentionally removing it."}
        </ConfirmationModal>
      )}

      {/* ── Toasts ───────────────────────────────────────────────────────────── */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[110] flex flex-col gap-2" aria-live="polite">
        {toasts.map((toast) => {
          const tone = toast.type === "success" ? TONE.online : TONE.critical;
          return (
            <div
              key={toast.id}
              className="th-toast flex items-center gap-2.5 rounded-lg px-4 py-3 text-[13px] font-medium shadow-xl"
              style={{ border: "1px solid var(--th-border-card)", background: "var(--th-bg-elevated)", color: "var(--th-text-primary)", boxShadow: `inset 3px 0 0 ${tone}` }}
            >
              {toast.type === "success" ? <Check className="h-4 w-4 flex-none" style={{ color: tone }} /> : <AlertTriangle className="h-4 w-4 flex-none" style={{ color: tone }} />}
              {toast.message}
            </div>
          );
        })}
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
                    <Button size="sm" onClick={onLoadMore} disabled={eventsLoading} variant="secondary">
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
    <details className="th-onb-details">
      <summary>
        <span>{title}</span>
        <button type="button" className="th-onb-action" onClick={(e) => { e.preventDefault(); onCopy(); }} aria-label={`Copy ${title}`}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </summary>
      <pre className="th-onb-code max-h-[280px] overflow-auto whitespace-pre-wrap break-words p-3">{value}</pre>
    </details>
  );
}
