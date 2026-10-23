import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  Ban,
  Boxes,
  Check,
  Copy,
  Download,
  Eye,
  HardDrive,
  KeyRound,
  Laptop,
  Layers,
  LifeBuoy,
  Loader2,
  LucideIcon,
  Monitor,
  Package,
  Pencil,
  RefreshCcw,
  Router,
  Search,
  Server,
  Star,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { fetchText } from "../api/client";
import { Client, DeviceGroup, getClients, getGroups } from "../api/clients";
import { AgentPackage, getAgentPackages } from "../api/agentPackages";
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
  enrollmentTokenBootstrapPath,
  getEnrollmentTokenDeployment,
  getEnrollmentTokens,
  getRustDeskConfig,
  regenerateEnrollmentToken,
  revokeEnrollmentToken,
  tokenFromBootstrapUrl,
  updateEnrollmentToken,
} from "../api/enrollmentBootstrap";
import { PlatformFeatures } from "../api/platform";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { usePlatformFeatures } from "../hooks/usePlatformFeatures";
import { useTabIndicator } from "../hooks/useTabIndicator";
import { Button, EmptyState, PageHeader, RowMenu, Select, DatePicker } from "../components/ui";
import TablePagination from "../components/ui/TablePagination";
import ConfirmationModal from "../components/ConfirmationModal";
import TokenDiagnostics from "../components/TokenDiagnostics";
import { CardHead } from "../components/ui/PanelCard";
import Modal from "../components/ui/Modal";
import {
  TOKEN_FILTERS,
  TokenFilter,
  TokenStatusChip,
  UsageMeter,
  formatTokenPrefix,
  tokenState,
} from "../components/EnrollmentTokenBits";
import { TERMS, TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { formatLocalDateTime, parseUTC, tiranaInputToUtcIso, timeAgo, utcToTiranaInput } from "../utils/time";

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
  arches?: string[]; // Linux/script: supported architectures (display)
  futureMethods?: string[]; // placeholders: planned deployment methods
  scriptEndpoint?: string; // kind "script": backend endpoint that generates the copy-paste script
  scriptLabel?: string; // kind "script": the block label (e.g. "RouterOS Script")
  routerosVersions?: { value: "6" | "7"; label: string }[];
}

const LINUX_ARCHES = ["linux-amd64", "linux-arm64", "linux-armhf"];

interface LinuxPackage {
  arch: string;
  pkg: AgentPackage | null;
}

const DEPLOYMENT_PLATFORMS: DeploymentPlatformMeta[] = [
  { id: "windows", label: "Windows", icon: Monitor, featureFlag: null, status: "Production", kind: "windows" },
  {
    id: "linux",
    label: "Linux",
    icon: Terminal,
    featureFlag: "FEATURE_LINUX",
    status: "Production",
    kind: "linux",
    arches: LINUX_ARCHES,
  },
  { id: "macos", label: "macOS", icon: Laptop, featureFlag: "FEATURE_MACOS", status: "Planned", kind: "placeholder" },
  {
    id: "mikrotik",
    label: "MikroTik",
    icon: Router,
    featureFlag: "FEATURE_MIKROTIK",
    status: "Experimental",
    kind: "script",
    scriptEndpoint: "/api/v1/install/mikrotik",
    scriptLabel: "RouterOS Script",
    routerosVersions: [
      { value: "6", label: "RouterOS 6.x" },
      { value: "7", label: "RouterOS 7.x" },
    ],
    arches: ["chr", "x86", "arm", "arm64", "mipsbe", "mmips", "ppc", "tile"],
  },
  {
    id: "synology",
    label: "Synology DSM",
    icon: HardDrive,
    featureFlag: "FEATURE_STORAGE",
    status: "Planned",
    kind: "placeholder",
    futureMethods: ["Package", "SSH Installer"],
  },
  {
    id: "qnap",
    label: "QNAP QTS",
    icon: HardDrive,
    featureFlag: "FEATURE_STORAGE",
    status: "Planned",
    kind: "placeholder",
    futureMethods: ["Package", "SSH Installer"],
  },
  {
    id: "vmware",
    label: "VMware ESXi",
    icon: Server,
    featureFlag: "FEATURE_HYPERVISOR",
    status: "Planned",
    kind: "placeholder",
  },
  {
    id: "hyperv",
    label: "Hyper-V",
    icon: Boxes,
    featureFlag: "FEATURE_HYPERVISOR",
    status: "Planned",
    kind: "placeholder",
  },
  {
    id: "proxmox",
    label: "Proxmox",
    icon: Layers,
    featureFlag: "FEATURE_HYPERVISOR",
    status: "Planned",
    kind: "placeholder",
  },
];

function isPlatformVisible(meta: DeploymentPlatformMeta, features: PlatformFeatures): boolean {
  if (meta.featureFlag === null) return true; // Windows — always
  return (features as unknown as Record<string, boolean>)[meta.featureFlag] === true;
}

const STATUS_TONE: Record<PlatformStatus, string> = {
  Production: TONE.online,
  Experimental: TONE.warning,
  Planned: TONE.neutral,
};

type CopyTarget = string | null;

function fmtDate(value?: string | null) {
  return value ? formatLocalDateTime(value) : "Never";
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
  downloadText("techi-bootstrap.ps1", await fetchText(enrollmentTokenBootstrapPath(tokenId)));
}

interface TokenTable {
  tokens: EnrollmentToken[];
  clients: Client[];
  groups: DeviceGroup[];
}

const EMPTY_TABLE: TokenTable = { tokens: [], clients: [], groups: [] };

async function fetchTokenTable(): Promise<TokenTable> {
  const [tokens, clients, groups] = await Promise.all([getEnrollmentTokens(), getClients(), getGroups()]);
  return { tokens, clients, groups };
}

const ONE_TIME_STEPS: [string, string][] = [
  ["Generate a token", "One per site or batch of PCs; the value is shown once."],
  ["Copy the command", "It appears here, with the bootstrap URL for GPO."],
  ["Run it on the device", "Elevated PowerShell on Windows; the eye icon in the table shows Linux and MikroTik."],
];

interface ActivePackages {
  windows: AgentPackage | null;
  linux: LinuxPackage[];
}

// What a new install downloads: the Endpoint MSI on Windows (not the update
// bridge, which shares the platform) and one agent binary per Linux
// architecture, where the installer refuses an architecture without one.
// One list request; a /latest per platform answers 404 for every gap.
function fetchActivePackages(): Promise<ActivePackages> {
  return getAgentPackages()
    .catch(() => [] as AgentPackage[])
    .then((packages) => ({
      windows:
        packages.find((p) => p.file_type === "msi" && p.is_active && p.platform === "windows-amd64") ??
        packages.find((p) => p.file_type === "msi" && p.is_active && p.platform.startsWith("windows")) ??
        null,
      linux: LINUX_ARCHES.map((arch) => ({
        arch,
        pkg: packages.find((p) => p.platform === arch && p.file_type === "agent_binary" && p.is_active) ?? null,
      })),
    }));
}

// "20h ago", "9d ago", "3 mo ago": the age beside a date, never the date again.
function relativeAge(iso: string): string {
  const days = (Date.now() - parseUTC(iso).getTime()) / 86_400_000;
  if (days < 7) return timeAgo(iso);
  if (days < 60) return `${Math.floor(days)}d ago`;
  if (days < 730) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}

function formatLinuxPackages(linux: LinuxPackage[]): string {
  return linux.map(({ arch, pkg }) => `${arch.replace("linux-", "")} ${pkg ? pkg.version : "none"}`).join(" · ");
}

function fetchRustDeskConfig(): Promise<RustDeskConfig | null> {
  return getRustDeskConfig().catch(() => null);
}

export default function Deployment() {
  const [tokenName, setTokenName] = useState("PC Deployment");
  const [maxUses, setMaxUses] = useState(25);
  const [token, setToken] = useState<CreateTokenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const table = useCachedQuery("mem.deployment.token-table", async () => {
    try {
      return await fetchTokenTable();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load enrollment tokens");
      throw err;
    }
  });
  const { tokens, clients, groups } = table.data ?? EMPTY_TABLE;
  const rustdesk = useCachedQuery("page.deployment.rustdesk-config", fetchRustDeskConfig).data ?? null;
  const activePackages = useCachedQuery("page.deployment.packages", fetchActivePackages).data ?? null;
  const activePackage = activePackages?.windows ?? null;
  const linuxPackages = activePackages?.linux ?? [];
  const features = usePlatformFeatures();
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<CopyTarget>(null);
  const [viewDeployment, setViewDeployment] = useState<EnrollmentTokenDeployment | null>(null);
  const [editToken, setEditToken] = useState<EnrollmentToken | null>(null);
  const [oneTimeToken, setOneTimeToken] = useState<CreateTokenResponse | null>(null);
  const [tokenSearch, setTokenSearch] = useState("");
  const [pendingTokenAction, setPendingTokenAction] = useState<{
    kind: "revoke" | "delete";
    token: EnrollmentToken;
  } | null>(null);
  const [tokenActionBusy, setTokenActionBusy] = useState(false);
  const [diagnosticsToken, setDiagnosticsToken] = useState<EnrollmentToken | null>(null);
  const [statusFilter, setStatusFilter] = useState<TokenFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const statusTabsRef = useTabIndicator<HTMLDivElement>(statusFilter);

  const bootstrapUrl = useMemo(() => (token ? buildWindowsBootstrapUrl(token.token) : ""), [token]);
  const bootstrapCommand = useMemo(() => (token ? buildWindowsBootstrapCommand(token.token) : ""), [token]);
  const clientName = (id?: number | null) => clients.find((client) => client.id === id)?.name ?? null;
  const groupName = (id?: number | null) => groups.find((group) => group.id === id)?.name ?? null;
  const statusCounts = useMemo(() => {
    const counts = { all: tokens.length, active: 0, unused: 0, used: 0, revoked: 0, expired: 0 } as Record<
      TokenFilter,
      number
    >;
    for (const t of tokens) counts[tokenState(t)] += 1;
    return counts;
  }, [tokens]);
  const filteredTokens = useMemo(() => {
    const q = tokenSearch.trim().toLowerCase();
    return tokens.filter((t) => {
      if (statusFilter !== "all" && tokenState(t) !== statusFilter) return false;
      if (!q) return true;
      const client = clients.find((c) => c.id === t.client_id)?.name ?? "";
      return [t.name, t.token_prefix ?? "", client].some((v) => v.toLowerCase().includes(q));
    });
  }, [tokens, tokenSearch, statusFilter, clients]);
  const pagedTokens = useMemo(
    () => filteredTokens.slice((page - 1) * pageSize, page * pageSize),
    [filteredTokens, page, pageSize],
  );
  const showExpires = useMemo(() => filteredTokens.some((t) => t.expires_at), [filteredTokens]);

  const loadTokens = table.reload;

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

  return (
    <section className="premium-page th-onb space-y-4">
      <PageHeader
        title="Windows Bootstrap Deployment"
        description="Issue enrollment tokens and the download-and-run commands for manual installs and GPO startup scripts."
        actions={
          <span className="th-status-chip" style={{ "--chip-tone": TONE.info } as CSSProperties}>
            <i />
            {[
              "Windows 10/11 · Server 2019/2022",
              features.FEATURE_LINUX && "Linux",
              features.FEATURE_MIKROTIK && "MikroTik",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        }
      />

      {error && (
        <div
          className="th-onb-note"
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

      {/* ── new token · one-time command ────────────────────────────────── */}
      <div className="grid items-stretch gap-4 xl:grid-cols-2">
        <div className="th-onb-card th-onb-enter" style={{ "--i": 0 } as CSSProperties}>
          <CardHead
            icon={KeyRound}
            tone="var(--th-accent)"
            title="New enrollment token"
            subtitle="One token per site or batch of PCs"
          />
          <div className="th-onb-body flex-1">
            <label className="th-onb-field">
              Token name
              <input
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="th-onb-field">
              Maximum PCs
              <input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} />
              <span className="th-onb-hint">The token stops enrolling once this many PCs have used it.</span>
            </label>
          </div>
          <div className="th-onb-foot">
            <Button type="button" onClick={() => void generateToken()} disabled={loading} className="w-full">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              {loading ? "Generating…" : "Generate token"}
            </Button>
          </div>
        </div>

        <div className="th-onb-card th-onb-enter" style={{ "--i": 1 } as CSSProperties}>
          <CardHead
            icon={Terminal}
            tone={token ? "var(--th-status-online)" : "var(--th-text-faint)"}
            title="One-time command"
            subtitle={token ? `For ${token.name}` : "Appears once a token is generated"}
          />
          {token ? (
            <div className="th-onb-body flex-1 th-onb-reveal">
              <CommandBlock
                label="Run in an elevated PowerShell"
                value={bootstrapCommand}
                copied={copied === "new-command"}
                onCopy={() => void copy("new-command", bootstrapCommand)}
              />
              <CommandBlock
                label="Bootstrap URL"
                value={bootstrapUrl}
                copied={copied === "new-url"}
                onCopy={() => void copy("new-url", bootstrapUrl)}
              />
            </div>
          ) : (
            <ol className="th-onb-body th-onb-steps flex-1">
              {ONE_TIME_STEPS.map(([title, hint], index) => (
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
      </div>

      {/* ── active package · remote support ─────────────────────────────── */}
      <div className="grid items-stretch gap-4 lg:grid-cols-2">
        <div className="th-onb-card th-onb-enter" style={{ "--i": 2 } as CSSProperties}>
          <CardHead
            icon={Package}
            tone={activePackage ? "var(--th-status-online)" : "var(--th-status-warning)"}
            title="Active deployment packages"
            subtitle="What a new install downloads"
            aside={
              <Link to="/onboarding?tab=packages" className="th-onb-link text-[12px]">
                Packages
              </Link>
            }
          />
          <div className="th-onb-body flex-1">
            <dl className="th-onb-meta">
              <div>
                <dt>Windows · Endpoint MSI</dt>
                <dd className="tabular-nums" title={activePackage?.filename}>
                  {activePackage ? activePackage.version : "None active"}
                </dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd className="font-mono !text-[12px]" title={activePackage?.sha256 ?? undefined}>
                  {activePackage?.sha256 ? `${activePackage.sha256.slice(0, 16)}…` : "—"}
                </dd>
              </div>
              {features.FEATURE_LINUX && (
                <div className="col-span-2">
                  <dt>Linux agent</dt>
                  <dd className="font-mono !text-[12px]">
                    {linuxPackages.length ? formatLinuxPackages(linuxPackages) : "—"}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </div>

        <div className="th-onb-card th-onb-enter" style={{ "--i": 3 } as CSSProperties}>
          <CardHead
            icon={LifeBuoy}
            tone="var(--th-status-info)"
            title={`${TERMS.remoteSupport} configuration`}
            subtitle="Written to every device the agent installs"
          />
          <div className="th-onb-body flex-1">
            <dl className="th-onb-meta">
              <div>
                <dt>Server</dt>
                <dd className="font-mono !text-[12px]">{rustdesk?.server_host ?? "—"}</dd>
              </div>
              <div>
                <dt>Relay</dt>
                <dd className="font-mono !text-[12px]">{rustdesk?.relay_host ?? "—"}</dd>
              </div>
              <div className="col-span-2">
                <dt>Public key</dt>
                <dd className="font-mono !text-[12px]" title={rustdesk?.public_key ?? undefined}>
                  {rustdesk?.public_key ?? "—"}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>

      {/* ── tokens ──────────────────────────────────────────────────────── */}
      <div className="th-alerts-card th-onb-tokens th-onb-enter" style={{ "--i": 4 } as CSSProperties}>
        <CardHead
          icon={KeyRound}
          tone="var(--th-accent)"
          title="Enrollment tokens"
          subtitle={
            table.loading ? "Loading…" : `${formatCount(tokens.length)} total · per-company GPO and technician tokens`
          }
          aside={
            <Button
              variant="secondary"
              type="button"
              size="sm"
              onClick={() => void loadTokens()}
              disabled={table.refreshing}
            >
              <RefreshCcw className={`h-3.5 w-3.5 ${table.refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          }
        />

        <div className="th-alerts-toolbar">
          <div ref={statusTabsRef} role="tablist" aria-label="Token status" className="th-tabs">
            {TOKEN_FILTERS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={statusFilter === id}
                onClick={() => {
                  setStatusFilter(id);
                  setPage(1);
                }}
                className="th-tab"
              >
                {label}
                <span className="th-tab-count">{formatCount(statusCounts[id])}</span>
              </button>
            ))}
          </div>
          <div className="pb-2">
            <label className="th-search th-search-sm w-[260px]">
              <Search className="h-3.5 w-3.5 flex-none" />
              <input
                value={tokenSearch}
                onChange={(e) => {
                  setTokenSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search tokens or clients"
                aria-label="Search tokens"
              />
              {tokenSearch && (
                <button
                  type="button"
                  onClick={() => setTokenSearch("")}
                  className="th-explorer-clear"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </label>
          </div>
        </div>

        {table.loading ? (
          <div className="th-alerts-scroll" aria-busy="true" aria-label="Loading tokens">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.12 }} />
            ))}
          </div>
        ) : filteredTokens.length === 0 ? (
          <EmptyState
            className="th-fade-in py-10"
            icon={<KeyRound className="h-5 w-5" />}
            title={tokens.length === 0 ? "No enrollment tokens yet" : "No tokens match these filters"}
            action={
              tokens.length > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setStatusFilter("all");
                    setTokenSearch("");
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
                <col className="w-[160px]" />
                <col className="w-[20%]" />
                <col className="w-[150px]" />
                {showExpires && <col className="w-[150px]" />}
                <col className="w-[112px]" />
              </colgroup>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Status</th>
                  <th>Usage</th>
                  <th>Client · group</th>
                  <th>Last used</th>
                  {showExpires && <th>Expires</th>}
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedTokens.map((row, index) => {
                  const client = clientName(row.client_id);
                  const group = groupName(row.group_id);
                  return (
                    <tr key={row.id} className="th-alerts-row" style={{ "--row": index } as CSSProperties}>
                      <td>
                        <span className="th-alerts-primary !flex min-w-0 items-center gap-1.5">
                          {row.is_default && (
                            <Star
                              className="h-3.5 w-3.5 flex-none"
                              style={{ color: "var(--th-accent)", fill: "var(--th-accent)" }}
                              aria-label="Default deployment token"
                            />
                          )}
                          <button
                            type="button"
                            className="th-alerts-link min-w-0 truncate text-left"
                            onClick={async () => setViewDeployment(await getEnrollmentTokenDeployment(row.id))}
                          >
                            {row.name}
                          </button>
                        </span>
                        <span className="th-alerts-secondary">
                          <span className="font-mono">{formatTokenPrefix(row.token_prefix)}</span> · created{" "}
                          {formatLocalDateTime(row.created_at)}
                        </span>
                      </td>
                      <td>
                        <TokenStatusChip token={row} />
                      </td>
                      <td>
                        <UsageMeter token={row} />
                      </td>
                      <td>
                        {client ? (
                          <>
                            <span className="th-alerts-primary">{client}</span>
                            <span className="th-alerts-secondary">{group ?? "Auto by device type"}</span>
                          </>
                        ) : (
                          <span className="th-alerts-secondary">Any client</span>
                        )}
                      </td>
                      <td>
                        {row.last_used_at ? (
                          <>
                            <span className="th-alerts-primary tabular-nums">
                              {formatLocalDateTime(row.last_used_at)}
                            </span>
                            <span className="th-alerts-secondary">{relativeAge(row.last_used_at)}</span>
                          </>
                        ) : (
                          <span className="th-alerts-secondary">Never</span>
                        )}
                      </td>
                      {showExpires && (
                        <td>
                          {row.expires_at ? (
                            <span className="th-alerts-primary tabular-nums">
                              {formatLocalDateTime(row.expires_at)}
                            </span>
                          ) : (
                            <span className="th-alerts-secondary">Never</span>
                          )}
                        </td>
                      )}
                      <td>
                        <div className="th-onb-actions">
                          <button
                            type="button"
                            className="th-onb-action"
                            title="Deployment commands"
                            aria-label={`Deployment commands for ${row.name}`}
                            onClick={async () => setViewDeployment(await getEnrollmentTokenDeployment(row.id))}
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            className="th-onb-action"
                            title="Copy install command"
                            aria-label={`Copy install command for ${row.name}`}
                            onClick={async () =>
                              copy(`cmd-${row.id}`, (await getEnrollmentTokenDeployment(row.id)).manual_command)
                            }
                          >
                            {copied === `cmd-${row.id}` ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                          </button>
                          <RowMenu
                            label={`More actions for ${row.name}`}
                            items={[
                              { label: "Edit", icon: Pencil, onSelect: () => setEditToken(row) },
                              {
                                label: "Regenerate value",
                                icon: RefreshCcw,
                                onSelect: async () => {
                                  const next = await regenerateEnrollmentToken(row.id);
                                  setOneTimeToken(next);
                                  await loadTokens();
                                },
                              },
                              { label: "Diagnostics", icon: Activity, onSelect: () => setDiagnosticsToken(row) },
                              ...(row.status !== "revoked"
                                ? [
                                    {
                                      label: "Revoke",
                                      icon: Ban,
                                      danger: true,
                                      onSelect: () => setPendingTokenAction({ kind: "revoke", token: row }),
                                    },
                                  ]
                                : []),
                              {
                                label: "Delete",
                                icon: Trash2,
                                danger: true,
                                onSelect: () => setPendingTokenAction({ kind: "delete", token: row }),
                              },
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {filteredTokens.length > 0 && (
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={filteredTokens.length}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            pageSizeOptions={[25, 50, 100]}
            itemLabel="tokens"
          />
        )}
      </div>

      {diagnosticsToken && <TokenDiagnostics token={diagnosticsToken} onClose={() => setDiagnosticsToken(null)} />}

      {pendingTokenAction && (
        <ConfirmationModal
          title={pendingTokenAction.kind === "revoke" ? "Revoke token" : "Delete token"}
          confirmLabel={pendingTokenAction.kind === "revoke" ? "Revoke token" : "Delete token"}
          loading={tokenActionBusy}
          onClose={() => setPendingTokenAction(null)}
          onConfirm={async () => {
            const { kind, token: target } = pendingTokenAction;
            setTokenActionBusy(true);
            try {
              if (kind === "revoke") await revokeEnrollmentToken(target.id);
              else await deleteEnrollmentToken(target.id, { confirmActive: true, confirmDefault: true });
              await loadTokens();
            } catch (err) {
              setError(err instanceof Error ? err.message : `Failed to ${kind} token`);
            } finally {
              setTokenActionBusy(false);
              setPendingTokenAction(null);
            }
          }}
        >
          {pendingTokenAction.kind === "revoke" ? (
            <>
              New devices can no longer enroll with{" "}
              <strong style={{ color: "var(--th-text-primary)" }}>{pendingTokenAction.token.name}</strong>. Devices
              already enrolled are not affected.
            </>
          ) : (
            <>
              Permanently delete{" "}
              <strong style={{ color: "var(--th-text-primary)" }}>{pendingTokenAction.token.name}</strong>? Install
              commands that use it stop working. Devices already enrolled are not affected.
            </>
          )}
        </ConfirmationModal>
      )}

      {viewDeployment && (
        <DeploymentModal
          deployment={viewDeployment}
          features={features}
          linuxPackages={linuxPackages}
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

// A titled group of commands inside a platform: what it is for on the left,
// an optional action (download, link) on the right.
function DeploySection({
  title,
  hint,
  aside,
  children,
}: {
  title: string;
  hint: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="th-onb-section th-deploy-section">
      <div className="flex flex-wrap items-center justify-between gap-3 [&>*:last-child:not(:first-child)]:flex-none [&>*:last-child:not(:first-child)]:whitespace-nowrap">
        <div className="min-w-0 flex-1">
          <div className="th-onb-label">{title}</div>
          <div className="th-onb-hint !mt-0.5">{hint}</div>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function CommandBlock({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="th-onb-field">
      <span className="flex items-center justify-between gap-3">
        {label}
        <button type="button" className="th-onb-link" onClick={onCopy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
      <pre className="th-onb-code max-h-[240px] overflow-auto whitespace-pre-wrap break-all p-3">{value}</pre>
    </div>
  );
}

function DeploymentModal({
  deployment,
  features,
  linuxPackages,
  copied,
  onCopy,
  onDownload,
  onClose,
}: {
  deployment: EnrollmentTokenDeployment;
  features: PlatformFeatures;
  linuxPackages: LinuxPackage[];
  copied: CopyTarget;
  onCopy: (target: string, value: string) => Promise<void>;
  onDownload: () => void;
  onClose: () => void;
}) {
  // Every platform shares the SAME token — derived from the Windows bootstrap
  // URL the backend already returns — so regenerating a token updates all.
  const token = tokenFromBootstrapUrl(deployment.bootstrap_url);
  const visible = DEPLOYMENT_PLATFORMS.filter((meta) => isPlatformVisible(meta, features));
  const meta = deployment.token_metadata;
  const [platformId, setPlatformId] = useState(visible[0]?.id ?? "windows");
  const platform = visible.find((p) => p.id === platformId) ?? visible[0];
  const platformTabsRef = useTabIndicator<HTMLDivElement>(platform?.id ?? "");
  return (
    <Modal
      title={deployment.token_name}
      subtitle="Deployment commands for every platform"
      icon={Terminal}
      size="xl"
      onClose={onClose}
      footer={
        <Button variant="secondary" type="button" onClick={onClose}>
          Close
        </Button>
      }
    >
      {/* One block whose height follows its content: the body scrolls instead
          of squeezing the summary to a line when Windows' commands are long. */}
      <div className="flex flex-col gap-4">
        {!deployment.token_available && (
          <div className="th-onb-note" style={{ "--onb-tone": "var(--th-status-warning)" } as CSSProperties}>
            <AlertTriangle className="h-4 w-4" />
            <span>This token has no recoverable value. Regenerate it to copy a usable command.</span>
          </div>
        )}
        <dl className="th-onb-meta sm:!grid-cols-4">
          <div>
            <dt>Status</dt>
            <dd>
              <TokenStatusChip token={meta} />
            </dd>
          </div>
          <div>
            <dt>Uses</dt>
            <dd>
              <UsageMeter token={meta} />
            </dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>{fmtDate(meta.expires_at)}</dd>
          </div>
          <div>
            <dt>{TERMS.remoteSupport}</dt>
            <dd className="font-mono !text-[12px]">{deployment.rustdesk.server_host ?? "—"}</dd>
          </div>
        </dl>
        <div ref={platformTabsRef} role="tablist" aria-label="Platform" className="th-tabs th-deploy-tabs">
          {visible.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={p.id === platform?.id}
              onClick={() => setPlatformId(p.id)}
              className="th-tab"
            >
              <p.icon className="h-3.5 w-3.5" />
              {p.label}
              <i
                className="th-tab-dot"
                style={{ "--tab-tone": STATUS_TONE[p.status] } as CSSProperties}
                title={p.status}
              />
            </button>
          ))}
        </div>
        {platform && (
          <PlatformSection
            key={platform.id}
            meta={platform}
            deployment={deployment}
            token={token}
            linuxPackages={linuxPackages}
            copied={copied}
            onCopy={onCopy}
            onDownload={onDownload}
          />
        )}
      </div>
    </Modal>
  );
}

function PlatformSection({
  meta,
  deployment,
  token,
  linuxPackages,
  copied,
  onCopy,
  onDownload,
}: {
  meta: DeploymentPlatformMeta;
  deployment: EnrollmentTokenDeployment;
  token: string | null;
  linuxPackages: LinuxPackage[];
  copied: CopyTarget;
  onCopy: (target: string, value: string) => Promise<void>;
  onDownload: () => void;
}) {
  const Icon = meta.icon;
  return (
    <section className="th-onb-card">
      <CardHead
        icon={Icon}
        tone={STATUS_TONE[meta.status]}
        title={meta.label}
        aside={
          <span className="th-status-chip" style={{ "--chip-tone": STATUS_TONE[meta.status] } as CSSProperties}>
            <i />
            {meta.status}
          </span>
        }
      />
      <div className="th-onb-body">
        {/* WINDOWS — production-proven. */}
        {meta.kind === "windows" && (
          <>
            <DeploySection
              title="Manual install"
              hint="One PC at a time, in an elevated PowerShell"
              aside={
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={onDownload}
                  disabled={!deployment.token_available}
                >
                  <Download className="h-3.5 w-3.5" />
                  Download .ps1
                </Button>
              }
            >
              <CommandBlock
                label="One-time command"
                value={deployment.manual_command}
                copied={copied === "modal-manual"}
                onCopy={() => void onCopy("modal-manual", deployment.manual_command)}
              />
              <CommandBlock
                label="Bootstrap URL"
                value={deployment.bootstrap_url}
                copied={copied === "modal-url"}
                onCopy={() => void onCopy("modal-url", deployment.bootstrap_url)}
              />
            </DeploySection>
            <DeploySection title="Group Policy" hint="Domain-joined fleets, at the next startup">
              <CommandBlock
                label="Startup script"
                value={deployment.gpo_command}
                copied={copied === "modal-gpo"}
                onCopy={() => void onCopy("modal-gpo", deployment.gpo_command)}
              />
              <CommandBlock
                label="Scheduled task (domain controller)"
                value={deployment.gpo_deploy_command}
                copied={copied === "modal-gpo-deploy"}
                onCopy={() => void onCopy("modal-gpo-deploy", deployment.gpo_deploy_command)}
              />
            </DeploySection>
          </>
        )}

        {/* LINUX — same token, one-liner installer. */}
        {meta.kind === "linux" &&
          (token ? (
            <>
              <DeploySection title="One-time install" hint="Any systemd distribution, as root (sudo when present)">
                <CommandBlock
                  label="Command"
                  value={buildLinuxInstallCommand(token)}
                  copied={copied === "modal-linux-cmd"}
                  onCopy={() => void onCopy("modal-linux-cmd", buildLinuxInstallCommand(token))}
                />
                <CommandBlock
                  label="Installer URL"
                  value={buildLinuxInstallUrl(token)}
                  copied={copied === "modal-linux-url"}
                  onCopy={() => void onCopy("modal-linux-url", buildLinuxInstallUrl(token))}
                />
              </DeploySection>
              <DeploySection
                title="Agent packages"
                hint="The installer refuses an architecture without an active package"
                aside={
                  linuxPackages.some(({ pkg }) => !pkg) ? (
                    <Link to="/onboarding?tab=packages" className="th-onb-link text-[12px]">
                      Packages
                    </Link>
                  ) : undefined
                }
              >
                <div className="flex flex-wrap gap-1.5">
                  {linuxPackages.map(({ arch, pkg }) => (
                    <span
                      key={arch}
                      className="th-status-chip font-mono !text-[11px]"
                      style={{ "--chip-tone": pkg ? TONE.online : TONE.warning } as CSSProperties}
                    >
                      <i />
                      {arch.replace("linux-", "")} {pkg ? pkg.version : "missing"}
                    </span>
                  ))}
                </div>
              </DeploySection>
            </>
          ) : (
            <p className="th-onb-hint">
              Token value not recoverable. Regenerate the token to reveal the Linux install command.
            </p>
          ))}

        {/* SCRIPT — server-generated deployment script from the Platform Registry
            template (e.g. MikroTik RouterOS). Same token; nothing hardcoded. */}
        {meta.kind === "script" &&
          (token ? (
            <ScriptSection meta={meta} token={token} copied={copied} onCopy={onCopy} />
          ) : (
            <p className="th-onb-hint">
              Token value not recoverable. Regenerate the token to reveal the {meta.scriptLabel ?? "deployment"} script.
            </p>
          ))}

        {/* PLACEHOLDER — reserved UI only, no commands. */}
        {meta.kind === "placeholder" && (
          <p className="th-onb-hint">
            Not available yet.
            {meta.futureMethods && meta.futureMethods.length > 0 && <> Planned: {meta.futureMethods.join(", ")}.</>}
          </p>
        )}
      </div>
    </section>
  );
}

function ScriptSection({
  meta,
  token,
  copied,
  onCopy,
}: {
  meta: DeploymentPlatformMeta;
  token: string;
  copied: CopyTarget;
  onCopy: (target: string, value: string) => Promise<void>;
}) {
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
    fetchText(`${meta.scriptEndpoint}?${params.toString()}`)
      .then((t) => {
        if (active) setScript(t);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Failed to generate script");
      });
    return () => {
      active = false;
    };
  }, [meta.routerosVersions, meta.scriptEndpoint, routerosVersion, token]);

  const label = meta.scriptLabel ?? "Deployment script";
  return (
    <>
      <DeploySection title={label} hint="Paste into a RouterOS terminal (Winbox → New Terminal, or SSH)">
        {meta.routerosVersions && (
          <div className="th-onb-field">
            RouterOS version
            <div
              className="th-segmented"
              role="radiogroup"
              aria-label="RouterOS version"
              data-thumb
              style={
                {
                  "--seg-n": meta.routerosVersions.length,
                  "--seg-i": Math.max(
                    0,
                    meta.routerosVersions.findIndex((v) => v.value === routerosVersion),
                  ),
                } as CSSProperties
              }
            >
              {meta.routerosVersions.map((version) => (
                <button
                  key={version.value}
                  type="button"
                  role="radio"
                  aria-checked={routerosVersion === version.value}
                  onClick={() => setRouterosVersion(version.value)}
                >
                  {version.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {error ? (
          <div className="th-onb-note" style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}>
            <AlertTriangle className="h-4 w-4" />
            <span>
              Could not generate the {label}: {error}
            </span>
          </div>
        ) : script === null ? (
          <div className="flex items-center gap-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Generating {label}…
          </div>
        ) : (
          <CommandBlock
            label="Script"
            value={script}
            copied={copied === `modal-${meta.id}-script`}
            onCopy={() => void onCopy(`modal-${meta.id}-script`, script)}
          />
        )}
      </DeploySection>
      {meta.arches && meta.arches.length > 0 && (
        <DeploySection title="Supported architectures" hint="Every RouterOS device on these runs the same script">
          <div className="flex flex-wrap gap-1.5">
            {meta.arches.map((a) => (
              <span key={a} className="th-status-chip font-mono !text-[11px]">
                {a}
              </span>
            ))}
          </div>
        </DeploySection>
      )}
    </>
  );
}

function EditTokenModal({
  token,
  clients,
  groups,
  onClose,
  onSave,
}: {
  token: EnrollmentToken;
  clients: Client[];
  groups: DeviceGroup[];
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(token.name);
  const [maxUses, setMaxUses] = useState(token.max_uses);
  const [expiresAt, setExpiresAt] = useState(utcToTiranaInput(token.expires_at));
  const [clientId, setClientId] = useState<number | "">(token.client_id ?? "");
  const [groupId, setGroupId] = useState<number | "">(token.group_id ?? "");
  const [status, setStatus] = useState<"active" | "revoked">(token.status === "revoked" ? "revoked" : "active");
  const [saving, setSaving] = useState(false);
  // Only the selected client's groups. Groups are named per client ("Servers",
  // "Client PC"), so an unfiltered list renders one indistinguishable "Client PC"
  // per client and the operator cannot tell which one belongs to their client.
  const visibleGroups = clientId ? groups.filter((g) => g.client_id === clientId) : [];
  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        name,
        max_uses: maxUses,
        expires_at: expiresAt ? tiranaInputToUtcIso(expiresAt) : null,
        client_id: clientId || null,
        group_id: groupId || null,
        status,
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Edit token"
      subtitle={token.name}
      icon={Pencil}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <label className="th-onb-field">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} id="token-name" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="th-onb-field">
          Maximum uses
          <input
            type="number"
            min={1}
            value={maxUses}
            onChange={(e) => setMaxUses(Number(e.target.value))}
            id="token-max-uses"
          />
        </label>
        <label className="th-onb-field">
          Expires (Tirana time)
          <DatePicker withTime defaultTime="23:59" value={expiresAt} onChange={setExpiresAt} id="token-expires-at" />
        </label>
      </div>
      <div className="th-onb-field">
        Client
        <Select
          id="token-client"
          aria-label="Client"
          value={clientId === "" ? "" : String(clientId)}
          onChange={(value) => {
            setClientId(value ? Number(value) : "");
            setGroupId("");
          }}
          options={[{ value: "", label: "No client" }, ...clients.map((c) => ({ value: String(c.id), label: c.name }))]}
        />
      </div>
      <div className="th-onb-field">
        Group
        <Select
          id="token-group"
          aria-label="Group"
          disabled={!clientId}
          value={groupId === "" ? "" : String(groupId)}
          onChange={(value) => setGroupId(value ? Number(value) : "")}
          options={[
            { value: "", label: "Auto by device type (Servers / Client PC)" },
            ...visibleGroups.map((g) => ({ value: String(g.id), label: g.name })),
          ]}
        />
        <span className="th-onb-hint">
          {clientId
            ? "Leave on Auto so each device lands in Servers or Client PC by what it is. Picking a group pins every device to it."
            : "Select a client first; groups belong to a client."}
        </span>
      </div>
      <div className="th-onb-field">
        Status
        <div
          className="th-segmented"
          role="radiogroup"
          aria-label="Token status"
          data-thumb
          style={{ "--seg-n": 2, "--seg-i": status === "revoked" ? 1 : 0 } as CSSProperties}
        >
          {(["active", "revoked"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={status === value}
              onClick={() => setStatus(value)}
              className="capitalize"
            >
              {value}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function OneTimeTokenModal({
  token,
  command,
  onCopy,
  onClose,
}: {
  token: CreateTokenResponse;
  command: string;
  onCopy: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Copy the token now"
      subtitle={token.name}
      icon={KeyRound}
      size="lg"
      onClose={onClose}
      footer={
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="th-onb-note" style={{ "--onb-tone": "var(--th-status-warning)" } as CSSProperties}>
        <AlertTriangle className="h-4 w-4" />
        <span>
          The value is shown this once. Only the deployment view can recover it later; token hashes are never exposed.
        </span>
      </div>
      <CommandBlock label="Token" value={token.token} copied={false} onCopy={() => onCopy(token.token)} />
      <CommandBlock label="Install command" value={command} copied={false} onCopy={() => onCopy(command)} />
    </Modal>
  );
}
