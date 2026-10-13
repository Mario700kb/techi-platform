import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  AlertTriangle,
  Binary,
  Check,
  Copy,
  Download,
  LifeBuoy,
  Package,
  Power,
  RefreshCcw,
  Terminal,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  AgentFileType,
  AgentPackage,
  AgentPackagePlatform,
  deleteAgentPackage,
  downloadAgentPackage,
  getAgentPackages,
  setAgentPackageActive,
  uploadAgentPackage,
} from "../api/agentPackages";
import { useAuth } from "../auth/AuthContext";
import ConfirmationModal from "../components/ConfirmationModal";
import { Button, EmptyState, PageHeader, Select } from "../components/ui";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { usePlatformFeatures } from "../hooks/usePlatformFeatures";
import { useTabIndicator } from "../hooks/useTabIndicator";
import { TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { formatLocalDateTime } from "../utils/time";

type TypeId = "msi" | "agent_binary" | "agent_update_msi" | "remote_support_msi" | "linux_binary";

interface PackageType {
  id: TypeId;
  label: string;
  icon: LucideIcon;
  fileType: AgentFileType;
  hint: string;
  /** Platforms an upload can target; one entry means it is fixed. */
  platforms: AgentPackagePlatform[];
  accept?: string;
  matches: (pkg: AgentPackage) => boolean;
}

// Linux agent binaries share file_type "agent_binary" with the Windows one, so
// every type also filters by platform.
const PACKAGE_TYPES: PackageType[] = [
  {
    id: "msi",
    label: "Endpoint MSI",
    icon: Package,
    fileType: "msi",
    hint: "Agent and Remote Support together, for GPO, fresh installs and new PCs.",
    platforms: ["windows-amd64", "windows-arm64", "windows"],
    accept: ".msi",
    matches: (p) => p.file_type === "msi",
  },
  {
    id: "agent_binary",
    label: "Agent binary",
    icon: Binary,
    fileType: "agent_binary",
    hint: 'techi-agent.exe alone. "Update agent" installs it; Remote Support is not touched.',
    platforms: ["windows-amd64"],
    accept: ".exe",
    matches: (p) => p.file_type === "agent_binary" && p.platform.startsWith("windows"),
  },
  {
    id: "agent_update_msi",
    label: "Update bridge",
    icon: RefreshCcw,
    fileType: "agent_update_msi",
    hint: 'Agent-only MSI used by "Update agent" for agents older than 2.1.1. Not used for GPO or bootstrap.',
    platforms: ["windows-amd64"],
    accept: ".msi",
    matches: (p) => p.file_type === "agent_update_msi",
  },
  {
    id: "remote_support_msi",
    label: "Remote Support",
    icon: LifeBuoy,
    fileType: "remote_support_msi",
    hint: "Remote Support MSI, versioned apart from the agent. Used to install, update, repair and reinstall it.",
    platforms: ["windows-amd64"],
    accept: ".msi",
    matches: (p) => p.file_type === "remote_support_msi",
  },
  {
    id: "linux_binary",
    label: "Linux agent",
    icon: Terminal,
    fileType: "agent_binary",
    hint: 'techi-agent for Linux, one binary per architecture. The active one per architecture is what "Needs Agent Update" compares against.',
    platforms: ["linux-amd64", "linux-arm64", "linux-armhf"],
    matches: (p) => p.file_type === "agent_binary" && p.platform.startsWith("linux"),
  },
];

const ACTIVE_TONE = { "--chip-tone": TONE.online } as CSSProperties;
const INACTIVE_TONE = { "--chip-tone": TONE.neutral } as CSSProperties;

export default function AgentPackages() {
  const { can } = useAuth();
  const canManage = can("admin");
  const showLinux = usePlatformFeatures().FEATURE_LINUX;
  const types = useMemo(() => PACKAGE_TYPES.filter((t) => t.id !== "linux_binary" || showLinux), [showLinux]);

  const [typeId, setTypeId] = useState<TypeId>("msi");
  const {
    data: packages,
    loading,
    refreshing,
    error: loadError,
    reload: load,
  } = useCachedQuery("page.agent-packages", getAgentPackages);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentPackage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [version, setVersion] = useState("");
  const [platform, setPlatform] = useState<AgentPackagePlatform>("windows-amd64");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const type = types.find((t) => t.id === typeId) ?? types[0];
  const typeTabsRef = useTabIndicator<HTMLDivElement>(type.id);
  const byType = useMemo(() => {
    const map = {} as Record<TypeId, AgentPackage[]>;
    for (const t of PACKAGE_TYPES) {
      map[t.id] = (packages ?? [])
        .filter(t.matches)
        .sort((a, b) => Date.parse(b.uploaded_at) - Date.parse(a.uploaded_at));
    }
    return map;
  }, [packages]);
  const rows = byType[type.id];

  useEffect(() => {
    setError(loadError);
  }, [loadError]);

  const selectType = (id: TypeId) => {
    const next = PACKAGE_TYPES.find((t) => t.id === id)!;
    setTypeId(id);
    setPlatform(next.platforms[0]);
    setFile(null);
    if (fileInput.current) fileInput.current.value = "";
    setError(null);
  };

  const handleUpload = async () => {
    if (!file || !version.trim()) {
      setError("A version and a package file are required");
      return;
    }
    try {
      setUploading(true);
      setError(null);
      await uploadAgentPackage({ version: version.trim(), platform, file, file_type: type.fileType });
      setVersion("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setUploadOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const run = async (pkg: AgentPackage, action: () => Promise<unknown>, failure: string, reload = true) => {
    try {
      setBusyId(pkg.id);
      setError(null);
      await action();
      if (reload) await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      setError(null);
      await deleteAgentPackage(deleteTarget.id, deleteTarget.is_active);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const copySha = async (pkg: AgentPackage) => {
    if (!pkg.sha256) return;
    await navigator.clipboard.writeText(pkg.sha256);
    setCopiedId(pkg.id);
    window.setTimeout(() => setCopiedId(null), 1600);
  };

  const showPlatformColumn = type.platforms.length > 1;

  return (
    <section className="premium-page th-onb space-y-4">
      <PageHeader
        title="Agent Packages"
        description="Installers and binaries the platform hands out. Activating a package makes it the one new installs and updates use; nothing updates on its own."
        actions={
          <Button size="sm" variant="secondary" onClick={() => void load()} disabled={refreshing}>
            <RefreshCcw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      {/* ── what is live, per package type ──────────────────────────────── */}
      <div className={`grid gap-4 sm:grid-cols-2 ${types.length === 5 ? "xl:grid-cols-5" : "xl:grid-cols-4"}`}>
        {types.map((t, index) => {
          const active = byType[t.id].filter((p) => p.is_active);
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => selectType(t.id)}
              aria-pressed={t.id === type.id}
              className="th-onb-card th-onb-summary th-onb-enter text-left"
              style={{ "--i": index } as CSSProperties}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="th-onb-icon"
                  style={{ "--onb-tone": active.length ? "var(--th-accent)" : "var(--th-text-faint)" } as CSSProperties}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="th-status-chip" style={active.length ? ACTIVE_TONE : INACTIVE_TONE}>
                  <i />
                  {active.length ? "Active" : "None active"}
                </span>
              </div>
              <div className="mt-4 text-[13px] font-medium" style={{ color: "var(--th-text-secondary)" }}>
                {t.label}
              </div>
              <div
                className="mt-1 truncate text-[20px] font-semibold tabular-nums"
                style={{ color: "var(--th-text-primary)" }}
              >
                {active.length === 0
                  ? "—"
                  : active.length === 1
                    ? active[0].version
                    : active
                        .map((p) => p.version)
                        .filter((v, i, all) => all.indexOf(v) === i)
                        .join(" · ")}
              </div>
              <div className="mt-1 truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                {active.length === 0
                  ? `${formatCount(byType[t.id].length)} uploaded`
                  : active.length === 1
                    ? `${active[0].platform} · ${formatLocalDateTime(active[0].uploaded_at)}`
                    : active.map((p) => p.platform).join(", ")}
              </div>
            </button>
          );
        })}
      </div>

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

      {/* ── packages of the selected type ───────────────────────────────── */}
      <div className="th-alerts-card th-onb-tokens th-onb-enter" style={{ "--i": types.length } as CSSProperties}>
        <div className="th-onb-card-head">
          <div key={type.id} className="th-onb-card-title th-fade-in">
            <span className="th-onb-icon" style={{ "--onb-tone": "var(--th-accent)" } as CSSProperties}>
              <type.icon className="h-4 w-4" />
            </span>
            <span>
              {type.label}
              <small>{type.hint}</small>
            </span>
          </div>
          {canManage && (
            <Button
              size="sm"
              variant={uploadOpen ? "secondary" : "primary"}
              onClick={() => setUploadOpen((open) => !open)}
            >
              {uploadOpen ? <X className="h-3.5 w-3.5" /> : <UploadCloud className="h-3.5 w-3.5" />}
              {uploadOpen ? "Close" : "Upload"}
            </Button>
          )}
        </div>

        <div className="th-alerts-toolbar">
          <div ref={typeTabsRef} role="tablist" aria-label="Package type" className="th-tabs">
            {types.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === type.id}
                onClick={() => selectType(t.id)}
                className="th-tab"
              >
                {t.label}
                <span className="th-tab-count">{formatCount(byType[t.id].length)}</span>
              </button>
            ))}
          </div>
        </div>

        {canManage && uploadOpen && (
          <div className="th-onb-upload th-onb-reveal">
            <label className="th-onb-field">
              Version
              <input
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="e.g. 2.1.24"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <div className="th-onb-field">
              {type.id === "linux_binary" ? "Architecture" : "Platform"}
              {type.platforms.length > 1 ? (
                <Select
                  id="package-platform"
                  aria-label="Platform"
                  value={platform}
                  onChange={(value) => setPlatform(value as AgentPackagePlatform)}
                  options={type.platforms.map((p) => ({ value: p, label: p }))}
                />
              ) : (
                <span className="th-onb-fixed">{type.platforms[0]}</span>
              )}
            </div>
            <div className="th-onb-field">
              File
              <label className="th-onb-file">
                <UploadCloud className="h-4 w-4 flex-none" />
                <span className="truncate">{file ? file.name : `Choose ${type.accept ?? "a binary"}`}</span>
                <input
                  ref={fileInput}
                  type="file"
                  aria-label="Package file"
                  accept={type.accept}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>
            <Button onClick={() => void handleUpload()} disabled={uploading || !file || !version.trim()}>
              <UploadCloud className="h-4 w-4" />
              {uploading ? "Uploading…" : "Upload"}
            </Button>
          </div>
        )}

        {loading ? (
          <div className="th-alerts-scroll" aria-busy="true" aria-label="Loading packages">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.15 }} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            className="th-fade-in py-10"
            icon={<type.icon className="h-5 w-5" />}
            title={`No ${type.label.toLowerCase()} packages uploaded yet`}
            action={
              canManage && !uploadOpen ? (
                <Button size="sm" variant="secondary" onClick={() => setUploadOpen(true)}>
                  <UploadCloud className="h-3.5 w-3.5" />
                  Upload
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="th-alerts-scroll th-table-scroll">
            <table className="th-alerts-table">
              <colgroup>
                <col />
                {showPlatformColumn && <col className="w-[150px]" />}
                <col className="w-[130px]" />
                <col className="w-[190px]" />
                <col className="w-[200px]" />
                <col className="w-[132px]" />
              </colgroup>
              <thead>
                <tr>
                  <th>Version</th>
                  {showPlatformColumn && <th>{type.id === "linux_binary" ? "Architecture" : "Platform"}</th>}
                  <th>Status</th>
                  <th>Uploaded</th>
                  <th>SHA-256</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((pkg, index) => (
                  <tr
                    key={pkg.id}
                    className="th-alerts-row"
                    style={{ "--row": index } as CSSProperties}
                    data-selected={pkg.is_active || undefined}
                  >
                    <td>
                      <span className="th-alerts-primary tabular-nums">{pkg.version}</span>
                      <span className="th-alerts-secondary font-mono" title={pkg.filename}>
                        {pkg.filename}
                      </span>
                    </td>
                    {showPlatformColumn && (
                      <td>
                        <span className="th-alerts-primary font-mono !text-[12px]">{pkg.platform}</span>
                      </td>
                    )}
                    <td>
                      <span className="th-status-chip" style={pkg.is_active ? ACTIVE_TONE : INACTIVE_TONE}>
                        <i />
                        {pkg.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>
                      <span className="th-alerts-primary tabular-nums">{formatLocalDateTime(pkg.uploaded_at)}</span>
                      <span className="th-alerts-secondary">{pkg.uploaded_by ?? "—"}</span>
                    </td>
                    <td>
                      {pkg.sha256 ? (
                        <button
                          type="button"
                          className="th-onb-sha"
                          onClick={() => void copySha(pkg)}
                          title={`${pkg.sha256}\nClick to copy`}
                        >
                          <span className="truncate">{pkg.sha256.slice(0, 16)}…</span>
                          {copiedId === pkg.id ? (
                            <Check className="h-3.5 w-3.5 flex-none" />
                          ) : (
                            <Copy className="h-3.5 w-3.5 flex-none" />
                          )}
                        </button>
                      ) : (
                        <span className="th-alerts-secondary">—</span>
                      )}
                    </td>
                    <td>
                      <div className="th-onb-actions">
                        <button
                          type="button"
                          className="th-onb-action"
                          title="Download"
                          aria-label={`Download ${pkg.filename}`}
                          disabled={busyId === pkg.id}
                          onClick={() => void run(pkg, () => downloadAgentPackage(pkg), "Download failed", false)}
                        >
                          <Download className="h-4 w-4" />
                        </button>
                        {canManage && (
                          <>
                            <button
                              type="button"
                              className="th-onb-action"
                              data-active={pkg.is_active || undefined}
                              title={pkg.is_active ? "Deactivate" : "Activate"}
                              aria-label={`${pkg.is_active ? "Deactivate" : "Activate"} ${pkg.version}`}
                              disabled={busyId === pkg.id}
                              onClick={() =>
                                void run(
                                  pkg,
                                  () => setAgentPackageActive(pkg.id, !pkg.is_active),
                                  "Package update failed",
                                )
                              }
                            >
                              <Power className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              className="th-onb-action"
                              data-tone="danger"
                              title="Delete"
                              aria-label={`Delete ${pkg.filename}`}
                              disabled={busyId === pkg.id || deleting}
                              onClick={() => setDeleteTarget(pkg)}
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
      </div>

      {deleteTarget && (
        <ConfirmationModal
          title="Delete package"
          confirmLabel={deleting ? "Deleting" : "Delete"}
          loading={deleting}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void handleDelete()}
        >
          Permanently delete{" "}
          <span className="font-semibold" style={{ color: "var(--th-text-primary)" }}>
            {deleteTarget.filename}
          </span>
          ?
          {deleteTarget.is_active &&
            " It is the active package for its type, so nothing will be served for that type until another is activated."}
        </ConfirmationModal>
      )}
    </section>
  );
}
