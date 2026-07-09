import { useEffect, useMemo, useState } from "react";
import { Boxes, Check, Clipboard, Copy, Download, Eye, HardDrive, KeyRound, Laptop, Layers, Loader2, LucideIcon, Monitor, Package, Pencil, RefreshCcw, Router, Search, Server, Terminal, Trash2 } from "lucide-react";
import { API_BASE_URL, getAuthToken } from "../api/client";
import { Client, DeviceGroup, getClients, getGroups } from "../api/clients";
import { AgentPackage, getLatestPackage } from "../api/agentPackages";
import {
  CreateTokenResponse,
  EnrollmentToken,
  EnrollmentTokenDeployment,
  RustDeskConfig,
  buildLinuxInstallCommand,
  buildLinuxInstallUrl,
  buildWindowsBootstrapCommand,
  buildWindowsBootstrapUrl,
  createEnrollmentToken,
  deleteEnrollmentToken,
  enrollmentTokenBootstrapDownloadUrl,
  getEnrollmentTokenDeployment,
  getEnrollmentTokens,
  getRustDeskConfig,
  regenerateEnrollmentToken,
  revokeEnrollmentToken,
  tokenFromBootstrapUrl,
  updateEnrollmentToken,
} from "../api/enrollmentBootstrap";
import { PlatformFeatures } from "../api/platform";
import { usePlatformFeatures } from "../hooks/usePlatformFeatures";
import { Button } from "../components/ui";

// ── Deployment platform registry (metadata-driven) ─────────────────────────
// The Deployment dialog renders from this table, gated by the backend Platform
// Expansion feature flags. Windows is always shown and production-proven; every
// other platform is opt-in via its flag. Adding a future platform = one entry
// here + its icon (+ the backend flag). No UI rewrite. macOS is gated on a flag
// that does not exist yet (FEATURE_MACOS) so it stays hidden until introduced.
type DeployKind = "windows" | "linux" | "script" | "placeholder";
type PlatformStatus = "Production" | "Experimental" | "Planned";

interface DeploymentPlatformMeta {
  id: string;
  label: string;
  icon: LucideIcon;
  // null → always visible (Windows). Otherwise visible only when that flag is on.
  featureFlag: keyof PlatformFeatures | "FEATURE_MACOS" | null;
  status: PlatformStatus;
  kind: DeployKind;
  arches?: string[];         // Linux/script: supported architectures (display)
  futureMethods?: string[];  // placeholders: planned deployment methods
  scriptEndpoint?: string;   // kind "script": backend endpoint that generates the copy-paste script
  scriptLabel?: string;      // kind "script": the block label (e.g. "RouterOS Script")
  routerosVersions?: { value: "6" | "7"; label: string }[];
}

const DEPLOYMENT_PLATFORMS: DeploymentPlatformMeta[] = [
  { id: "windows", label: "Windows", icon: Monitor, featureFlag: null, status: "Production", kind: "windows" },
  { id: "linux", label: "Linux", icon: Terminal, featureFlag: "FEATURE_LINUX", status: "Experimental", kind: "linux",
    arches: ["linux-amd64", "linux-arm64", "linux-armhf"] },
  { id: "macos", label: "macOS", icon: Laptop, featureFlag: "FEATURE_MACOS", status: "Planned", kind: "placeholder" },
  { id: "mikrotik", label: "MikroTik", icon: Router, featureFlag: "FEATURE_MIKROTIK", status: "Experimental", kind: "script",
    scriptEndpoint: "/api/v1/install/mikrotik", scriptLabel: "RouterOS Script",
    routerosVersions: [{ value: "6", label: "RouterOS 6.x" }, { value: "7", label: "RouterOS 7.x" }],
    arches: ["chr", "x86", "arm", "arm64", "mipsbe", "mmips", "ppc", "tile"] },
  { id: "synology", label: "Synology DSM", icon: HardDrive, featureFlag: "FEATURE_STORAGE", status: "Planned", kind: "placeholder",
    futureMethods: ["Package", "SSH Installer"] },
  { id: "qnap", label: "QNAP QTS", icon: HardDrive, featureFlag: "FEATURE_STORAGE", status: "Planned", kind: "placeholder",
    futureMethods: ["Package", "SSH Installer"] },
  { id: "vmware", label: "VMware ESXi", icon: Server, featureFlag: "FEATURE_HYPERVISOR", status: "Planned", kind: "placeholder" },
  { id: "hyperv", label: "Hyper-V", icon: Boxes, featureFlag: "FEATURE_HYPERVISOR", status: "Planned", kind: "placeholder" },
  { id: "proxmox", label: "Proxmox", icon: Layers, featureFlag: "FEATURE_HYPERVISOR", status: "Planned", kind: "placeholder" },
];

function isPlatformVisible(meta: DeploymentPlatformMeta, features: PlatformFeatures): boolean {
  if (meta.featureFlag === null) return true; // Windows — always
  return (features as unknown as Record<string, boolean>)[meta.featureFlag] === true;
}

const STATUS_BADGE: Record<PlatformStatus, string> = {
  Production: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  Experimental: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  Planned: "border-slate-400/25 bg-slate-400/10 text-slate-400",
};

type CopyTarget = string | null;

function fmtDate(value?: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadTokenScript(tokenId: number) {
  const response = await fetch(enrollmentTokenBootstrapDownloadUrl(tokenId).replace(API_BASE_URL, API_BASE_URL), {
    headers: {
      ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
    },
  });
  if (!response.ok) throw new Error(await response.text());
  downloadText("techi-bootstrap.ps1", await response.text());
}

export default function Deployment() {
  const [tokenName, setTokenName] = useState("PC Deployment");
  const [maxUses, setMaxUses] = useState(25);
  const [token, setToken] = useState<CreateTokenResponse | null>(null);
  const [tokens, setTokens] = useState<EnrollmentToken[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [rustdesk, setRustdesk] = useState<RustDeskConfig | null>(null);
  const [activePackage, setActivePackage] = useState<AgentPackage | null>(null);
  const [linuxPackage, setLinuxPackage] = useState<AgentPackage | null>(null);
  const features = usePlatformFeatures();
  const [loading, setLoading] = useState(false);
  const [tableLoading, setTableLoading] = useState(false);
  const [copied, setCopied] = useState<CopyTarget>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewDeployment, setViewDeployment] = useState<EnrollmentTokenDeployment | null>(null);
  const [editToken, setEditToken] = useState<EnrollmentToken | null>(null);
  const [oneTimeToken, setOneTimeToken] = useState<CreateTokenResponse | null>(null);
  const [tokenSearch, setTokenSearch] = useState("");

  const bootstrapUrl = useMemo(() => token ? buildWindowsBootstrapUrl(token.token) : "", [token]);
  const bootstrapCommand = useMemo(() => token ? buildWindowsBootstrapCommand(token.token) : "", [token]);
  const filteredTokens = useMemo(() => {
    const q = tokenSearch.trim().toLowerCase();
    if (!q) return tokens;
    return tokens.filter((t) => t.name.toLowerCase().includes(q));
  }, [tokens, tokenSearch]);

  const loadTokens = async () => {
    setTableLoading(true);
    try {
      const [tokenRows, clientRows, groupRows] = await Promise.all([getEnrollmentTokens(), getClients(), getGroups()]);
      setTokens(tokenRows);
      setClients(clientRows);
      setGroups(groupRows);
    } finally {
      setTableLoading(false);
    }
  };

  useEffect(() => {
    getRustDeskConfig().then(setRustdesk).catch(() => setRustdesk(null));
    getLatestPackage("windows-amd64")
      .catch(() => getLatestPackage("windows"))
      .then(setActivePackage)
      .catch(() => setActivePackage(null));
    getLatestPackage("linux-amd64").then(setLinuxPackage).catch(() => setLinuxPackage(null));
    void loadTokens();
  }, []);

  const copy = async (target: Exclude<CopyTarget, null>, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(target);
    window.setTimeout(() => setCopied(null), 1600);
  };

  const generateToken = async () => {
    setLoading(true);
    setError(null);
    try {
      const created = await createEnrollmentToken({
        name: tokenName.trim() || "PC Deployment",
        max_uses: Math.max(1, Number(maxUses) || 1),
        expires_at: null,
      });
      setToken(created);
      setOneTimeToken(created);
      await loadTokens();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate enrollment token");
    } finally {
      setLoading(false);
    }
  };

  const clientName = (id?: number | null) => clients.find((client) => client.id === id)?.name ?? "-";
  const groupName = (id?: number | null) => groups.find((group) => group.id === id)?.name ?? "-";

  return (
    <section className="premium-page space-y-5">
      <div className="premium-card overflow-hidden p-5 md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="premium-kicker">Deployment</p>
            <h1 className="mt-2 text-2xl font-semibold" style={{ color: "var(--th-text-primary)" }}>Windows Bootstrap Deployment</h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-6" style={{ color: "var(--th-text-secondary)" }}>
              Generate enrollment tokens and use AMSI-friendlier download-and-run commands for manual or GPO startup deployment.
            </p>
          </div>
          <div className="rounded-lg border px-3 py-2 text-xs font-semibold" style={{ borderColor: "var(--th-border-card)", color: "var(--th-text-secondary)" }}>
            Windows 10/11 · Server 2019/2022 · Domain Controllers
          </div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="premium-card-soft p-5">
          <div className="mb-4 flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-techi-orange" />
            <h2 className="text-base font-semibold" style={{ color: "var(--th-text-primary)" }}>New Enrollment Token</h2>
          </div>
          <div className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Token name</span>
              <input value={tokenName} onChange={(e) => setTokenName(e.target.value)} className="th-input w-full rounded-lg border px-3 py-2.5 text-sm font-medium outline-none" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Maximum PCs</span>
              <input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} className="th-input w-full rounded-lg border px-3 py-2.5 text-sm font-medium outline-none" />
            </label>
            {error && <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-sm font-medium text-red-200">{error}</div>}
            <Button type="button" onClick={() => void generateToken()} disabled={loading} className="w-full justify-center">
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
              Generate Token
            </Button>
          </div>

          <div className="mt-5 rounded-lg border p-3" style={{ borderColor: "var(--th-border-card)", background: "var(--th-bg-card)" }}>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>TECHI Remote Support Config</div>
            <dl className="space-y-1 text-xs" style={{ color: "var(--th-text-secondary)" }}>
              <div className="flex justify-between gap-3"><dt className="font-semibold">Server</dt><dd className="font-mono" style={{ color: "var(--th-text-primary)" }}>{rustdesk?.server_host ?? "loading"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="font-semibold">Relay</dt><dd className="font-mono" style={{ color: "var(--th-text-primary)" }}>{rustdesk?.relay_host ?? "loading"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="font-semibold">Key</dt><dd className="max-w-[190px] truncate font-mono" style={{ color: "var(--th-text-primary)" }}>{rustdesk?.public_key ?? "loading"}</dd></div>
            </dl>
          </div>
        </div>

        <div className="premium-card-soft p-5">
          <div className="mb-4 flex items-center gap-2">
            <Clipboard className="h-4 w-4 text-techi-orange" />
            <h2 className="text-base font-semibold" style={{ color: "var(--th-text-primary)" }}>One-Time Command</h2>
          </div>
          {token ? (
            <CommandBlock label="Run in elevated PowerShell" value={bootstrapCommand} copied={copied === "new-command"} onCopy={() => copy("new-command", bootstrapCommand)} />
          ) : (
            <div className="rounded-lg border p-6 text-sm font-medium" style={{ borderColor: "var(--th-border-card)", background: "var(--th-bg-card)", color: "var(--th-text-muted)" }}>
              Generate a token to reveal the safe deployment command. Token values are shown only after create/regenerate.
            </div>
          )}
          {token && <CommandBlock label="Bootstrap URL" value={bootstrapUrl} copied={copied === "new-url"} onCopy={() => copy("new-url", bootstrapUrl)} />}
        </div>
      </div>

      <div className="premium-card-soft p-4">
        <div className="flex items-center gap-2 mb-3">
          <Package className="h-4 w-4 text-techi-orange" />
          <h2 className="text-sm font-semibold" style={{ color: "var(--th-text-primary)" }}>Active Deployment Package</h2>
        </div>
        {activePackage ? (
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>Version</span>
              <div className="mt-0.5 font-semibold" style={{ color: "var(--th-text-primary)" }}>{activePackage.version}</div>
            </div>
            <div>
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>Platform</span>
              <div className="mt-0.5 font-mono text-xs" style={{ color: "var(--th-text-secondary)" }}>{activePackage.platform}</div>
            </div>
            <div>
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>File</span>
              <div className="mt-0.5 font-mono text-xs" style={{ color: "var(--th-text-secondary)" }}>{activePackage.filename}</div>
            </div>
            {activePackage.sha256 && (
              <div>
                <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>SHA256</span>
                <div className="mt-0.5 font-mono text-xs" style={{ color: "var(--th-text-secondary)" }} title={activePackage.sha256}>
                  {activePackage.sha256.slice(0, 16)}…
                </div>
              </div>
            )}
            <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-300">Active</span>
          </div>
        ) : (
          <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>
            No active Windows deployment package. Upload an MSI via{" "}
            <a href="/agent-packages" className="text-techi-orange hover:underline">Agent Packages</a>.
          </p>
        )}
      </div>

      <div className="premium-card-soft p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold" style={{ color: "var(--th-text-primary)" }}>Enrollment Tokens</h2>
            <p className="mt-1 text-xs font-medium" style={{ color: "var(--th-text-muted)" }}>Persistent deployment workflow for technicians and per-company GPO tokens.</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5" style={{ color: "var(--th-text-muted)" }} />
              <input
                className="th-input rounded-lg py-1.5 pl-8 pr-3 text-xs"
                placeholder="Kërko token sipas emrit..."
                value={tokenSearch}
                onChange={(e) => setTokenSearch(e.target.value)}
                style={{ width: 220 }}
              />
            </div>
            <Button type="button" size="sm" onClick={() => void loadTokens()} disabled={tableLoading}>
              {tableLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="th-table min-w-full">
            <thead>
              <tr>
                <th>Name</th><th>Prefix</th><th>Status</th><th>Uses</th><th>Expires</th><th>Assignment</th><th>Created</th><th>Last used</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredTokens.map((row) => (
                <tr key={row.id}>
                  <td className="font-semibold">{row.name}</td>
                  <td className="font-mono">{row.token_prefix ?? "-"}</td>
                  <td><span className={`status-pill ${row.status}`}>{row.status}</span></td>
                  <td>{row.use_count} / {row.max_uses}</td>
                  <td>{fmtDate(row.expires_at)}</td>
                  <td>{clientName(row.client_id)} / {groupName(row.group_id)}</td>
                  <td>{fmtDate(row.created_at)}</td>
                  <td>{fmtDate(row.used_at)}</td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" type="button" onClick={async () => setViewDeployment(await getEnrollmentTokenDeployment(row.id))}><Eye className="mr-1 h-3.5 w-3.5" />View</Button>
                      <Button size="sm" type="button" onClick={async () => copy(`cmd-${row.id}`, (await getEnrollmentTokenDeployment(row.id)).manual_command)}><Copy className="mr-1 h-3.5 w-3.5" />Cmd</Button>
                      <Button size="sm" type="button" onClick={() => setEditToken(row)}><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button>
                      <Button size="sm" type="button" onClick={async () => { const next = await regenerateEnrollmentToken(row.id); setOneTimeToken(next); await loadTokens(); }}><RefreshCcw className="mr-1 h-3.5 w-3.5" />Regenerate</Button>
                      <Button size="sm" type="button" onClick={async () => { await revokeEnrollmentToken(row.id); await loadTokens(); }}>Revoke</Button>
                      <Button size="sm" type="button" onClick={async () => { await deleteEnrollmentToken(row.id, { confirmActive: true, confirmDefault: true }); await loadTokens(); }}><Trash2 className="mr-1 h-3.5 w-3.5" />Delete</Button>
                    </div>
                  </td>
                </tr>
              ))}
              {!filteredTokens.length && (
                <tr>
                  <td colSpan={9} className="py-8 text-center" style={{ color: "var(--th-text-muted)" }}>
                    {tokenSearch.trim() ? "Asnjë token nuk u gjet." : "No enrollment tokens yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {viewDeployment && (
        <DeploymentModal
          deployment={viewDeployment}
          features={features}
          linuxPackage={linuxPackage}
          copied={copied}
          onCopy={copy}
          onDownload={() => void downloadTokenScript(viewDeployment.token_id)}
          onClose={() => setViewDeployment(null)}
        />
      )}
      {editToken && (
        <EditTokenModal
          token={editToken}
          clients={clients}
          groups={groups}
          onClose={() => setEditToken(null)}
          onSave={async (payload) => {
            await updateEnrollmentToken(editToken.id, payload);
            setEditToken(null);
            await loadTokens();
          }}
        />
      )}
      {oneTimeToken && (
        <OneTimeTokenModal
          token={oneTimeToken}
          command={buildWindowsBootstrapCommand(oneTimeToken.token)}
          onCopy={(value) => copy("one-time-token", value)}
          onClose={() => setOneTimeToken(null)}
        />
      )}
    </section>
  );
}

function CommandBlock({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>{label}</span>
        <Button size="sm" type="button" onClick={onCopy}>{copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}{copied ? "Copied" : "Copy"}</Button>
      </div>
      <pre className="overflow-x-auto rounded-lg border p-4 text-xs font-semibold leading-6" style={{ borderColor: "var(--th-border-card)", background: "var(--th-bg-main)", color: "var(--th-text-primary)" }}>{value}</pre>
    </div>
  );
}

function DeploymentModal({ deployment, features, linuxPackage, copied, onCopy, onDownload, onClose }: { deployment: EnrollmentTokenDeployment; features: PlatformFeatures; linuxPackage: AgentPackage | null; copied: CopyTarget; onCopy: (target: string, value: string) => Promise<void>; onDownload: () => void; onClose: () => void }) {
  // Every platform shares the SAME token — derived from the Windows bootstrap
  // URL the backend already returns — so regenerating a token updates all.
  const token = tokenFromBootstrapUrl(deployment.bootstrap_url);
  const visible = DEPLOYMENT_PLATFORMS.filter((meta) => isPlatformVisible(meta, features));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg border p-5" style={{ borderColor: "var(--th-border-card)", background: "var(--th-bg-card)", color: "var(--th-text-primary)" }}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Deployment: {deployment.token_name}</h3>
          <Button size="sm" type="button" onClick={onClose}>Close</Button>
        </div>
        {!deployment.token_available && <div className="mb-4 rounded-lg border border-yellow-400/30 bg-yellow-400/10 p-3 text-sm text-yellow-100">This token has no recoverable value. Regenerate it to copy a usable command.</div>}
        <div className="space-y-5">
          {visible.map((meta) => (
            <PlatformSection
              key={meta.id}
              meta={meta}
              deployment={deployment}
              token={token}
              linuxPackage={linuxPackage}
              copied={copied}
              onCopy={onCopy}
              onDownload={onDownload}
            />
          ))}
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <Info label="Status" value={deployment.token_metadata.status} />
          <Info label="Uses" value={`${deployment.token_metadata.use_count} / ${deployment.token_metadata.max_uses}`} />
          <Info label="Expires" value={fmtDate(deployment.token_metadata.expires_at)} />
          <Info label="TECHI Remote Support" value={`${deployment.rustdesk.server_host ?? "-"} / ${deployment.rustdesk.relay_host ?? "-"}`} />
        </div>
      </div>
    </div>
  );
}

function PlatformSection({ meta, deployment, token, linuxPackage, copied, onCopy, onDownload }: { meta: DeploymentPlatformMeta; deployment: EnrollmentTokenDeployment; token: string | null; linuxPackage: AgentPackage | null; copied: CopyTarget; onCopy: (target: string, value: string) => Promise<void>; onDownload: () => void }) {
  const Icon = meta.icon;
  return (
    <section className="rounded-lg border p-4" style={{ borderColor: "var(--th-border-card)", background: "var(--th-bg-main)" }}>
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-techi-orange" />
        <h4 className="text-sm font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-primary)" }}>{meta.label}</h4>
        <span className={`ml-auto rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[meta.status]}`}>{meta.status}</span>
      </div>

      {/* WINDOWS — production-proven; byte-identical to the original block. */}
      {meta.kind === "windows" && (
        <>
          <CommandBlock label="Safe one-time/manual command" value={deployment.manual_command} copied={copied === "modal-manual"} onCopy={() => void onCopy("modal-manual", deployment.manual_command)} />
          <CommandBlock label="GPO startup command" value={deployment.gpo_command} copied={copied === "modal-gpo"} onCopy={() => void onCopy("modal-gpo", deployment.gpo_command)} />
          <CommandBlock label="GPO Scheduled Task Deploy (Domain Controller)" value={deployment.gpo_deploy_command} copied={copied === "modal-gpo-deploy"} onCopy={() => void onCopy("modal-gpo-deploy", deployment.gpo_deploy_command)} />
          <CommandBlock label="Bootstrap URL" value={deployment.bootstrap_url} copied={copied === "modal-url"} onCopy={() => void onCopy("modal-url", deployment.bootstrap_url)} />
          <Button type="button" onClick={onDownload} disabled={!deployment.token_available}><Download className="mr-2 h-4 w-4" />Download PS1</Button>
        </>
      )}

      {/* LINUX — same token, one-liner installer (Experimental). */}
      {meta.kind === "linux" && (
        token ? (
          <>
            <CommandBlock label="One-Time Install" value={buildLinuxInstallCommand(token)} copied={copied === "modal-linux-cmd"} onCopy={() => void onCopy("modal-linux-cmd", buildLinuxInstallCommand(token))} />
            <CommandBlock label="Manual URL" value={buildLinuxInstallUrl(token)} copied={copied === "modal-linux-url"} onCopy={() => void onCopy("modal-linux-url", buildLinuxInstallUrl(token))} />
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Supported architectures</div>
                <ul className="space-y-0.5 font-mono text-xs" style={{ color: "var(--th-text-primary)" }}>
                  {meta.arches?.map((a) => <li key={a}>• {a}</li>)}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Package source</div>
                {linuxPackage ? (
                  <div className="text-xs" style={{ color: "var(--th-text-primary)" }}>Active Linux Package · <span className="font-mono">{linuxPackage.version}</span> · <span className="font-mono">{linuxPackage.filename}</span></div>
                ) : (
                  <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>No active Linux package — upload one in <a href="/agent-packages" className="text-techi-orange hover:underline">Agent Packages</a>.</div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="rounded-lg border p-3 text-xs" style={{ borderColor: "var(--th-border-card)", color: "var(--th-text-muted)" }}>Token value not recoverable. Regenerate the token to reveal the Linux install command.</div>
        )
      )}

      {/* SCRIPT — server-generated deployment script from the Platform Registry
          template (e.g. MikroTik RouterOS). Same token; nothing hardcoded. */}
      {meta.kind === "script" && (
        token ? (
          <ScriptSection meta={meta} token={token} copied={copied} onCopy={onCopy} />
        ) : (
          <div className="rounded-lg border p-3 text-xs" style={{ borderColor: "var(--th-border-card)", color: "var(--th-text-muted)" }}>Token value not recoverable. Regenerate the token to reveal the {meta.scriptLabel ?? "deployment"} script.</div>
        )
      )}

      {/* PLACEHOLDER — reserved UI only, no commands. */}
      {meta.kind === "placeholder" && (
        <div className="rounded-lg border border-dashed p-3 text-xs" style={{ borderColor: "var(--th-border-card)", color: "var(--th-text-muted)" }}>
          <p className="font-medium" style={{ color: "var(--th-text-secondary)" }}>Coming soon. This platform is not yet available.</p>
          {meta.futureMethods && meta.futureMethods.length > 0 && (
            <>
              <p className="mt-2">Future deployment methods:</p>
              <ul className="mt-1 space-y-0.5">
                {meta.futureMethods.map((m) => <li key={m}>• {m}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ScriptSection({ meta, token, copied, onCopy }: { meta: DeploymentPlatformMeta; token: string; copied: CopyTarget; onCopy: (target: string, value: string) => Promise<void> }) {
  const [script, setScript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [routerosVersion, setRouterosVersion] = useState<"6" | "7">("7");
  useEffect(() => {
    let active = true;
    setScript(null);
    setError(null);
    // The script is generated server-side from the Platform Registry template
    // with this token injected (unauthenticated, like the Linux installer — the
    // enrollment token is the credential).
    const params = new URLSearchParams({ token });
    if (meta.routerosVersions) params.set("routeros_version", routerosVersion);
    fetch(`${API_BASE_URL}${meta.scriptEndpoint}?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((t) => { if (active) setScript(t); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Failed to generate script"); });
    return () => { active = false; };
  }, [meta.routerosVersions, meta.scriptEndpoint, routerosVersion, token]);

  const label = meta.scriptLabel ?? "Deployment Script";
  return (
    <>
      {meta.routerosVersions && (
        <div className="mb-3">
          <div className="mb-1 text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>RouterOS Version</div>
          <div className="flex flex-wrap gap-2">
            {meta.routerosVersions.map((version) => (
              <label key={version.value} className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: routerosVersion === version.value ? "var(--th-accent)" : "var(--th-border-card)", color: "var(--th-text-primary)" }}>
                <input
                  type="radio"
                  name={`${meta.id}-routeros-version`}
                  value={version.value}
                  checked={routerosVersion === version.value}
                  onChange={() => setRouterosVersion(version.value)}
                />
                {version.label}
              </label>
            ))}
          </div>
        </div>
      )}
      {error ? (
        <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-xs text-red-200">Could not generate the {label}: {error}</div>
      ) : script === null ? (
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--th-text-muted)" }}><Loader2 className="h-3.5 w-3.5 animate-spin" />Generating {label}…</div>
      ) : (
        <CommandBlock label={label} value={script} copied={copied === `modal-${meta.id}-script`} onCopy={() => void onCopy(`modal-${meta.id}-script`, script)} />
      )}
      {meta.arches && meta.arches.length > 0 && (
        <div className="mt-1">
          <div className="mb-1 text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Supported architectures</div>
          <div className="flex flex-wrap gap-1.5">
            {meta.arches.map((a) => <span key={a} className="rounded-full border px-2 py-0.5 text-[11px] font-mono" style={{ borderColor: "var(--th-border-card)", color: "var(--th-text-secondary)" }}>{a}</span>)}
          </div>
        </div>
      )}
    </>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border p-3" style={{ borderColor: "var(--th-border-card)" }}><div className="text-xs" style={{ color: "var(--th-text-muted)" }}>{label}</div><div className="mt-1 text-sm font-semibold">{value}</div></div>;
}

function EditTokenModal({ token, clients, groups, onClose, onSave }: { token: EnrollmentToken; clients: Client[]; groups: DeviceGroup[]; onClose: () => void; onSave: (payload: Record<string, unknown>) => Promise<void> }) {
  const [name, setName] = useState(token.name);
  const [maxUses, setMaxUses] = useState(token.max_uses);
  const [expiresAt, setExpiresAt] = useState(token.expires_at ? token.expires_at.slice(0, 16) : "");
  const [clientId, setClientId] = useState(token.client_id ?? "");
  const [groupId, setGroupId] = useState(token.group_id ?? "");
  const [status, setStatus] = useState<"active" | "revoked">(token.status === "revoked" ? "revoked" : "active");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border p-5" style={{ borderColor: "var(--th-border-card)", background: "var(--th-bg-card)" }}>
        <h3 className="mb-4 text-lg font-semibold" style={{ color: "var(--th-text-primary)" }}>Edit token</h3>
        <div className="space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} id="token-name" name="token-name" aria-label="Token name" className="th-input w-full rounded-lg border px-3 py-2 text-sm" />
          <input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} id="token-max-uses" name="token-max-uses" aria-label="Maximum uses" className="th-input w-full rounded-lg border px-3 py-2 text-sm" />
          <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} id="token-expires-at" name="token-expires-at" aria-label="Expiration date and time" className="th-input w-full rounded-lg border px-3 py-2 text-sm" />
          <select value={clientId} onChange={(e) => setClientId(e.target.value ? Number(e.target.value) : "")} id="token-client" name="token-client" aria-label="Client" className="th-input w-full rounded-lg border px-3 py-2 text-sm">
            <option value="">No client</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : "")} id="token-group" name="token-group" aria-label="Group" className="th-input w-full rounded-lg border px-3 py-2 text-sm">
            <option value="">No group</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as "active" | "revoked")} id="token-status" name="token-status" aria-label="Token status" className="th-input w-full rounded-lg border px-3 py-2 text-sm">
            <option value="active">active</option><option value="revoked">revoked</option>
          </select>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={() => void onSave({ name, max_uses: maxUses, expires_at: expiresAt ? new Date(expiresAt).toISOString() : null, client_id: clientId || null, group_id: groupId || null, status })}>Save</Button>
        </div>
      </div>
    </div>
  );
}

function OneTimeTokenModal({ token, command, onCopy, onClose }: { token: CreateTokenResponse; command: string; onCopy: (value: string) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl rounded-lg border p-5" style={{ borderColor: "var(--th-border-card)", background: "var(--th-bg-card)", color: "var(--th-text-primary)" }}>
        <h3 className="text-lg font-semibold">Token value shown once</h3>
        <p className="mt-2 text-sm" style={{ color: "var(--th-text-secondary)" }}>Copy this now. Existing values are stored recoverably only for deployment view; token hashes are never exposed.</p>
        <CommandBlock label={`Token ${token.name}`} value={token.token} copied={false} onCopy={() => onCopy(token.token)} />
        <CommandBlock label="Safe command" value={command} copied={false} onCopy={() => onCopy(command)} />
        <div className="flex justify-end"><Button type="button" onClick={onClose}>Done</Button></div>
      </div>
    </div>
  );
}
