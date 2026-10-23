import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
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
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  X,
} from "lucide-react";
import {
  AvailabilityProfile,
  CreateTokenRequest,
  EnrollmentBootstrapMode,
  EnrollmentBootstrapPlatform,
  EnrollmentBootstrapResponse,
  EnrollmentToken,
  createEnrollmentToken,
  generateEnrollmentBootstrap,
  getEnrollmentTokens,
  regenerateDefaultToken,
  updateEnrollmentToken,
} from "../api/enrollmentBootstrap";
import { Client, DeviceGroup, getClients, getGroups } from "../api/clients";
import { useAuth } from "../auth/AuthContext";
import { API_BASE_URL } from "../api/client";
import { Button, Modal, PageHeader, Select, DatePicker } from "../components/ui";
import { TokenStatusChip, UsageMeter, formatTokenPrefix } from "../components/EnrollmentTokenBits";
import { TERMS, TONE } from "../utils/deviceStatus";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { tiranaInputToUtcIso } from "../utils/time";

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
  { id: "linux", label: "Linux" },
];

const INSTALLER_STEPS: [string, string][] = [
  ["Choose how it enrolls", "Token enrollment for workgroup PCs and tests, Trusted domain / GPO for domain fleets."],
  [
    "Pick the platform and device policy",
    "Windows or Linux; the Server profile keeps a machine reachable on AC power.",
  ],
  ["Generate and run", "Copy the run command or download the script; run it as Administrator (root on Linux)."],
];

const SECURITY_POINTS = [
  "The lock screen stays on. Remote access runs through the TechiAgent and Remote Support services, not a signed-in session.",
  "A device that sleeps or hibernates is unreachable unless Wake-on-LAN is set up.",
  "Choose the Server profile for machines that must stay reachable on AC power.",
];

const NO_TOKENS: EnrollmentToken[] = [];

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
    description:
      "Sleep and hibernate disabled on AC. Lock screen stays enabled. TECHI Remote Support works on lock screen via service.",
  },
  workstation: {
    label: "Workstation",
    description:
      "Sleep/hibernate follow your explicit settings below. Lock screen stays enabled. Device goes offline when it sleeps.",
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
  const [error, setError] = useState<string | null>(null);
  const tokenList = useCachedQuery("mem.enrollment.tokens", async () => {
    try {
      setError(null);
      const data = await getEnrollmentTokens();
      // Auto-select default active token when no selection exists
      if (!tokenId) {
        const def = data.find((t) => t.is_default && t.status === "active");
        const first = data.find((t) => t.status === "active");
        const pick = def ?? first;
        if (pick) setTokenId(String(pick.id));
      }
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tokens");
      throw err;
    }
  });
  const tokens = tokenList.data ?? NO_TOKENS;
  const loadTokens = tokenList.reload;
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

  const [regenerating, setRegenerating] = useState(false);
  const [editMaxUsesTarget, setEditMaxUsesTarget] = useState<EnrollmentToken | null>(null);
  const [editMaxUses, setEditMaxUses] = useState(0);
  const [savingMaxUses, setSavingMaxUses] = useState(false);
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
    [activeTokens, tokenId],
  );
  const isLocalhost = backendUrl.includes("localhost") || backendUrl.includes("127.0.0.1");
  const canGenerate = mode === "gpo" || (mode === "token" && activeTokens.length > 0 && !!tokenId);

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
        enrollment_token: mode === "token" && plaintextToken.trim() ? plaintextToken.trim() : undefined,
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
    const filename =
      bootstrap.installer_filename || (bootstrap.mode === "gpo" ? "techi-gpo-bootstrap.ps1" : "techi-installer.ps1");
    downloadTextFile(bootstrap.bootstrap_script, filename);
  };

  return (
    <section className="premium-page th-onb space-y-4">
      <PageHeader
        title="Enrollment Bootstrap"
        description={
          <>
            Generate a one-click installer for new endpoints. Use <strong>Token enrollment</strong> for workgroup PCs
            and tests, <strong>Trusted domain / GPO</strong> for domain-joined fleets. Tokens are managed under{" "}
            <Link to="/onboarding?tab=tokens" className="th-onb-link">
              Tokens &amp; commands
            </Link>
            .
          </>
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => void loadTokens()}
            disabled={tokenList.refreshing}
          >
            <RefreshCcw className={`h-3.5 w-3.5 ${tokenList.refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      {warningTokens.length > 0 && (
        <div
          className="th-onb-note"
          style={{ "--onb-tone": "var(--th-status-warning)" } as React.CSSProperties}
          role="status"
        >
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
                  style={
                    {
                      "--chip-tone":
                        token.usage_warning === "critical" ? "var(--th-status-critical)" : "var(--th-status-warning)",
                    } as React.CSSProperties
                  }
                  title={canManage ? "Raise max uses" : undefined}
                >
                  <i />
                  {token.name}
                  <span className="tabular-nums" style={{ color: "var(--th-text-muted)" }}>
                    {token.use_count}/{token.max_uses}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {flashToken && (
        <div
          className="th-onb-note th-onb-reveal"
          style={{ "--onb-tone": "var(--th-status-warning)" } as React.CSSProperties}
        >
          <Info className="h-4 w-4 flex-none" style={{ color: "var(--th-status-warning)" }} />
          <span className="flex-none text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
            Copy the token now; it is not shown again.
          </span>
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

      {/* ── generator · installer, default token, security model ────────── */}
      <div className="grid items-stretch gap-4 xl:grid-cols-2">
        <div className="th-onb-card th-onb-enter" style={{ "--i": 2 } as React.CSSProperties}>
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
              <div
                className="th-segmented"
                role="radiogroup"
                aria-label="Deployment mode"
                data-thumb
                style={{ "--seg-n": 2, "--seg-i": mode === "gpo" ? 1 : 0 } as React.CSSProperties}
              >
                {(["token", "gpo"] as const).map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
                    {m === "token" ? "Token enrollment" : "Trusted domain / GPO"}
                  </button>
                ))}
              </div>

              {mode === "gpo" && (
                <div
                  className="th-onb-note th-onb-reveal"
                  style={{ "--onb-tone": "var(--th-status-warning)" } as React.CSSProperties}
                >
                  <Info className="h-4 w-4" />
                  <ul className="space-y-1">
                    <li>
                      <strong>Domain-joined PCs</strong> enroll without a token. The backend needs{" "}
                      <code className="font-mono">TRUSTED_DOMAIN_AUTO_ENROLLMENT=true</code>.
                    </li>
                    <li>
                      <strong>WORKGROUP PCs</strong> do not enroll through GPO; use Token enrollment for them.
                    </li>
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
                      onChange={(value) => {
                        setTokenId(value);
                        setPlaintextToken("");
                      }}
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
                      {plaintextToken && (
                        <span
                          className="th-status-chip !h-5 !px-2 !text-[11px]"
                          style={{ "--chip-tone": "var(--th-status-online)" } as React.CSSProperties}
                        >
                          <i />
                          Filled
                        </span>
                      )}
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
                <div
                  className="th-onb-note"
                  style={{ "--onb-tone": "var(--th-status-warning)" } as React.CSSProperties}
                >
                  <AlertTriangle className="h-4 w-4" />
                  <span>localhost only reaches this machine. Real devices need the server&apos;s public URL.</span>
                </div>
              )}
              <div className="th-onb-field">
                Platform
                <div
                  className="th-segmented"
                  role="radiogroup"
                  aria-label="Platform"
                  data-thumb
                  style={
                    { "--seg-n": 3, "--seg-i": PLATFORMS.findIndex((p) => p.id === platform) } as React.CSSProperties
                  }
                >
                  {PLATFORMS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={platform === p.id}
                      onClick={() => setPlatform(p.id)}
                    >
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
                  <div
                    className="th-segmented"
                    role="radiogroup"
                    aria-label="Availability profile"
                    data-thumb
                    style={
                      {
                        "--seg-n": 3,
                        "--seg-i": ["server", "workstation", "custom"].indexOf(availProfile),
                      } as React.CSSProperties
                    }
                  >
                    {(["server", "workstation", "custom"] as AvailabilityProfile[]).map((p) => (
                      <button
                        key={p}
                        type="button"
                        role="radio"
                        aria-checked={availProfile === p}
                        onClick={() => setAvailProfile(p)}
                      >
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
                    <small>
                      {availProfile === "server"
                        ? "Sleep and hibernate are disabled on AC power."
                        : "Uses the switches below."}
                    </small>
                  </span>
                </label>
                {managePower && availProfile !== "server" && (
                  <div className="th-onb-sub th-onb-reveal">
                    <label className="th-onb-check">
                      <input
                        type="checkbox"
                        checked={preventSleepAC}
                        onChange={(e) => setPreventSleepAC(e.target.checked)}
                      />
                      <span>Prevent sleep on AC power</span>
                    </label>
                    <label className="th-onb-check">
                      <input
                        type="checkbox"
                        checked={preventHibernate}
                        onChange={(e) => setPreventHibernate(e.target.checked)}
                      />
                      <span>Disable hibernate</span>
                    </label>
                    <label className="th-onb-check">
                      <input
                        type="checkbox"
                        checked={allowDisplayOff}
                        onChange={(e) => setAllowDisplayOff(e.target.checked)}
                      />
                      <span>
                        Allow display off on AC <small>Recommended</small>
                      </span>
                    </label>
                  </div>
                )}

                <label className="th-onb-check">
                  <input
                    type="checkbox"
                    checked={rustdeskEnabled}
                    onChange={(e) => setRustdeskEnabled(e.target.checked)}
                  />
                  <span>
                    {TERMS.remoteSupport} self-healing
                    <small>The agent installs, configures and keeps {TERMS.remoteSupport} running.</small>
                  </span>
                </label>
                {rustdeskEnabled && (
                  <div className="th-onb-sub th-onb-reveal sm:grid-cols-2">
                    {(
                      [
                        {
                          label: "MSI URL",
                          value: rustdeskMsiUrl,
                          set: setRustdeskMsiUrl,
                          placeholder: "https://…/TECHI-Remote-Support.msi",
                        },
                        {
                          label: "Rendezvous server",
                          value: rustdeskRendezvous,
                          set: setRustdeskRendezvous,
                          placeholder: "Host or IP",
                        },
                        {
                          label: "Relay server",
                          value: rustdeskRelay,
                          set: setRustdeskRelay,
                          placeholder: "Host or IP",
                        },
                        {
                          label: "API server",
                          value: rustdeskApi,
                          set: setRustdeskApi,
                          placeholder: "Leave empty unless you run one",
                        },
                        { label: "Public key", value: rustdeskKey, set: setRustdeskKey, placeholder: "Base64 key" },
                        {
                          label: "Default password",
                          value: rustdeskPassword,
                          set: setRustdeskPassword,
                          placeholder: "Initial password",
                        },
                      ] as const
                    ).map(({ label, value, set, placeholder }) => (
                      <label key={label} className="th-onb-field">
                        {label}
                        <input
                          value={value}
                          onChange={(e) => set(e.target.value)}
                          placeholder={placeholder}
                          spellCheck={false}
                          autoComplete="off"
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="th-onb-foot space-y-3">
            {error && (
              <div
                className="th-onb-note"
                style={{ "--onb-tone": "var(--th-status-critical)" } as React.CSSProperties}
                role="alert"
              >
                <AlertTriangle className="h-4 w-4" />
                <span>{error}</span>
              </div>
            )}
            <Button
              className="w-full"
              type="button"
              onClick={() => void handleGenerate()}
              disabled={loading || !canGenerate || !backendUrl.trim()}
            >
              {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Terminal className="h-4 w-4" />}
              {loading ? "Generating…" : "Generate installer"}
            </Button>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="th-onb-card th-onb-enter flex-1" style={{ "--i": 3 } as React.CSSProperties}>
            <div className="th-onb-card-head">
              <div className="th-onb-card-title">
                <span
                  className="th-onb-icon"
                  style={
                    {
                      "--onb-tone": bootstrap ? "var(--th-status-online)" : "var(--th-text-faint)",
                    } as React.CSSProperties
                  }
                >
                  <FileCode2 className="h-4 w-4" />
                </span>
                <span>
                  Installer
                  <small>
                    {bootstrap
                      ? `Ready to run as ${bootstrap.platform === "windows" ? "Administrator" : "root"}`
                      : "Appears here once generated"}
                  </small>
                </span>
              </div>
              {bootstrap && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void copyText("script", bootstrap.bootstrap_script)}
                  >
                    {copied === "script" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied === "script" ? "Copied" : "Copy script"}
                  </Button>
                  <Button size="sm" onClick={handleDownloadScript}>
                    <Download className="h-3.5 w-3.5" />
                    Download .{(bootstrap.installer_filename || "installer.ps1").split(".").pop()}
                  </Button>
                </div>
              )}
            </div>

            {bootstrap ? (
              <div className="th-onb-body flex-1 th-onb-reveal">
                <dl className="th-onb-meta">
                  <div>
                    <dt>Target</dt>
                    <dd>
                      {bootstrap.mode === "gpo"
                        ? "Trusted domain / GPO"
                        : bootstrap.platform === "windows"
                          ? "Windows service"
                          : `${bootstrap.platform} bootstrap`}
                    </dd>
                  </div>
                  <div>
                    <dt>Platform</dt>
                    <dd className="capitalize">{bootstrap.platform}</dd>
                  </div>
                  <div>
                    <dt>Backend</dt>
                    <dd title={bootstrap.backend_url}>{bootstrap.backend_url}</dd>
                  </div>
                  <div>
                    <dt>{bootstrap.mode === "gpo" ? "Enrollment" : "Token"}</dt>
                    <dd>
                      {bootstrap.mode === "gpo"
                        ? "Domain trust"
                        : selectedToken
                          ? selectedToken.name
                          : bootstrap.enrollment_token_id
                            ? `#${bootstrap.enrollment_token_id}`
                            : "—"}
                    </dd>
                  </div>
                </dl>

                <div className="th-onb-field">
                  Run command
                  <div className="flex items-stretch gap-2">
                    <code className="th-onb-code min-w-0 flex-1 truncate px-3 py-2">{bootstrap.bootstrap_command}</code>
                    <button
                      type="button"
                      className="th-onb-action !h-auto !w-9 border"
                      style={{ borderColor: "var(--th-border-subtle)" }}
                      onClick={() => void copyText("command", bootstrap.bootstrap_command)}
                      aria-label="Copy run command"
                    >
                      {copied === "command" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>

                <div className="th-onb-field">
                  Script
                  <pre className="th-onb-code max-h-[320px] overflow-auto whitespace-pre-wrap break-words p-3">
                    {bootstrap.bootstrap_script}
                  </pre>
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
              <ol className="th-onb-body th-onb-steps flex-1">
                {INSTALLER_STEPS.map(([title, hint], index) => (
                  <li key={title}>
                    <span className="th-onb-step">{index + 1}</span>
                    <span>
                      {title}
                      <small>{hint}</small>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="th-onb-card th-onb-enter" style={{ "--i": 4 } as React.CSSProperties}>
            <div className="th-onb-card-head">
              <div className="th-onb-card-title">
                <span
                  className="th-onb-icon"
                  style={
                    {
                      "--onb-tone":
                        defaultToken?.status === "active" ? "var(--th-status-online)" : "var(--th-status-warning)",
                    } as React.CSSProperties
                  }
                >
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
                    <div className="mt-1 truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
                      {defaultToken.name}
                    </div>
                  </div>
                  <div>
                    <div className="th-onb-label">Prefix</div>
                    <code className="mt-1 block font-mono text-[12px]" style={{ color: "var(--th-text-secondary)" }}>
                      {formatTokenPrefix(defaultToken.token_prefix)}
                    </code>
                  </div>
                  <div>
                    <div className="th-onb-label">Usage</div>
                    <div className="mt-1.5">
                      <UsageMeter token={defaultToken} />
                    </div>
                  </div>
                </div>
              ) : (
                <p className="th-onb-hint">No default deployment token exists. Regenerate to create one.</p>
              )}
              <div className="flex flex-wrap gap-2">
                {activeDefault && mode === "token" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleUseDefault}
                    disabled={tokenId === String(activeDefault.id)}
                  >
                    {tokenId === String(activeDefault.id) ? (
                      <>
                        <Check className="h-3.5 w-3.5" />
                        Selected in generator
                      </>
                    ) : (
                      "Use in generator"
                    )}
                  </Button>
                )}
                {canManage && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void handleRegenerateDefault()}
                    disabled={regenerating}
                  >
                    <RotateCcw className={`h-3.5 w-3.5 ${regenerating ? "animate-spin" : ""}`} />
                    {regenerating ? "Regenerating…" : "Regenerate"}
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="th-onb-card th-onb-enter" style={{ "--i": 5 } as React.CSSProperties}>
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
                <li
                  key={point}
                  className="flex gap-2.5 text-[13px] leading-5"
                  style={{ color: "var(--th-text-secondary)" }}
                >
                  <Check className="mt-0.5 h-4 w-4 flex-none" style={{ color: "var(--th-status-info)" }} />
                  {point}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* ── New token ─────────────────────────────────────────────────────────── */}
      {createOpen && (
        <Modal
          title="New enrollment token"
          subtitle="Selected in the generator once created"
          icon={KeyRound}
          busy={creating}
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleCreateToken()} disabled={!newName.trim() || creating}>
                {creating ? "Creating…" : "Create and select"}
              </Button>
            </>
          }
        >
          <label className="th-onb-field">
            Name
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. ADPascucci — Office PCs"
              data-autofocus
              onKeyDown={(e) => e.key === "Enter" && void handleCreateToken()}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="th-onb-field">
              Max uses
              <input
                type="number"
                min={1}
                max={1000}
                value={newMaxUses}
                onChange={(e) => setNewMaxUses(Math.max(1, Number(e.target.value)))}
              />
            </label>
            <label className="th-onb-field">
              Expires (Tirana time)
              <DatePicker withTime defaultTime="23:59" value={newExpiry} onChange={setNewExpiry} />
            </label>
          </div>
          {clients.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="th-onb-field">
                Client
                <Select
                  id="new-token-client"
                  aria-label="Assign to client"
                  value={newClientId === "" ? "" : String(newClientId)}
                  onChange={(value) => setNewClientId(value === "" ? "" : Number(value))}
                  options={[
                    { value: "", label: "No assignment" },
                    ...clients.map((c) => ({ value: String(c.id), label: c.name })),
                  ]}
                />
              </div>
              <div className="th-onb-field">
                Group
                <Select
                  id="new-token-group"
                  aria-label="Assign to group"
                  disabled={newClientId === "" || groups.length === 0}
                  value={newGroupId === "" ? "" : String(newGroupId)}
                  onChange={(value) => setNewGroupId(value === "" ? "" : Number(value))}
                  options={[
                    { value: "", label: "Auto by device type" },
                    ...groups.map((g) => ({ value: String(g.id), label: g.name })),
                  ]}
                />
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* ── Change max uses ───────────────────────────────────────────────────── */}
      {editMaxUsesTarget && (
        <Modal
          title="Change max uses"
          subtitle={editMaxUsesTarget.name}
          icon={KeyRound}
          size="sm"
          busy={savingMaxUses}
          onClose={() => setEditMaxUsesTarget(null)}
          footer={
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEditMaxUsesTarget(null)}
                disabled={savingMaxUses}
              >
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleSaveMaxUses()} disabled={savingMaxUses}>
                {savingMaxUses ? "Saving…" : "Save"}
              </Button>
            </>
          }
        >
          <div className="flex items-center justify-between gap-4">
            <span>Used so far</span>
            <UsageMeter token={editMaxUsesTarget} />
          </div>
          {editMaxUsesTarget.status === "used" && (
            <div className="th-onb-note" style={{ "--onb-tone": "var(--th-status-warning)" } as React.CSSProperties}>
              <Info className="h-4 w-4" />
              <span>The token is exhausted. A limit above {editMaxUsesTarget.use_count} reactivates it.</span>
            </div>
          )}
          <label className="th-onb-field">
            Max uses
            <input
              type="number"
              min={1}
              max={1000000}
              value={editMaxUses}
              data-autofocus
              onChange={(e) => setEditMaxUses(Math.max(1, Number(e.target.value)))}
              onKeyDown={(e) => e.key === "Enter" && void handleSaveMaxUses()}
            />
          </label>
        </Modal>
      )}

      {/* ── Toasts ───────────────────────────────────────────────────────────── */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[110] flex flex-col gap-2" aria-live="polite">
        {toasts.map((toast) => {
          const tone = toast.type === "success" ? TONE.online : TONE.critical;
          return (
            <div
              key={toast.id}
              className="th-toast flex items-center gap-2.5 rounded-lg px-4 py-3 text-[13px] font-medium shadow-xl"
              style={{
                border: "1px solid var(--th-border-card)",
                background: "var(--th-bg-elevated)",
                color: "var(--th-text-primary)",
                boxShadow: `inset 3px 0 0 ${tone}`,
              }}
            >
              {toast.type === "success" ? (
                <Check className="h-4 w-4 flex-none" style={{ color: tone }} />
              ) : (
                <AlertTriangle className="h-4 w-4 flex-none" style={{ color: tone }} />
              )}
              {toast.message}
            </div>
          );
        })}
      </div>
    </section>
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
        <button
          type="button"
          className="th-onb-action"
          onClick={(e) => {
            e.preventDefault();
            onCopy();
          }}
          aria-label={`Copy ${title}`}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </summary>
      <pre className="th-onb-code max-h-[280px] overflow-auto whitespace-pre-wrap break-words p-3">{value}</pre>
    </details>
  );
}
