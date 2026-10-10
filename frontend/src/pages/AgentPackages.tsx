import { useEffect, useMemo, useState } from "react";
import { Binary, CheckCircle2, Download, Package, RefreshCcw, Trash2, UploadCloud } from "lucide-react";
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
import { Badge, Button, PageHeader, SelectField } from "../components/ui";
import { APP_TIME_ZONE, parseUTC, DISPLAY_LOCALE } from "../utils/time";
import { usePlatformFeatures } from "../hooks/usePlatformFeatures";
import PlatformIcon from "../components/PlatformIcon";
import LinuxPackagesPanel from "./LinuxPackagesPanel";

const PLATFORMS: AgentPackagePlatform[] = ["windows", "windows-amd64", "windows-arm64", "linux-amd64", "darwin-arm64"];
const INPUT_CLS = "th-input rounded-lg border px-3 py-2 text-sm font-medium outline-none focus:border-techi-orange/60";

function formatDate(iso: string): string {
  return parseUTC(iso).toLocaleString(DISPLAY_LOCALE, { hourCycle: "h23", timeZone: APP_TIME_ZONE, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

type TabId = "msi" | "agent_binary" | "agent_update_msi" | "remote_support_msi";

const TABS: { id: TabId; label: string; fileType: AgentFileType; hint: string; fixedPlatform?: AgentPackagePlatform }[] = [
  {
    id: "msi",
    label: "MSI Packages",
    fileType: "msi",
    hint: "For GPO, fresh installs and new PCs. Contains TECHI Remote Support + techi-agent.",
  },
  {
    id: "agent_binary",
    label: "Agent Binary",
    fileType: "agent_binary",
    hint: "techi-agent.exe only. Used by the \"Update agent\" command — does not touch TECHI Remote Support.",
    fixedPlatform: "windows-amd64",
  },
  {
    id: "agent_update_msi",
    label: "Update MSI (Bridge)",
    fileType: "agent_update_msi",
    hint: "Agent-only bridge MSI (TECHI-Agent-Update-*.msi). Used by \"Update agent\" for legacy agents (< 2.1.1) — does not touch TECHI Remote Support and is not used for GPO/bootstrap.",
    fixedPlatform: "windows-amd64",
  },
  {
    id: "remote_support_msi",
    label: "Remote Support Packages",
    fileType: "remote_support_msi",
    hint: "TECHI Remote Support MSI, versioned separately from the agent. Used to install, update, repair and reinstall Remote Support.",
    fixedPlatform: "windows-amd64",
  },
];

export default function AgentPackages() {
  const { can } = useAuth();
  const canManage = can("admin");
  // Platform Expansion: a Windows|Linux scope toggle appears only when Linux
  // is enabled. Default "windows" ⇒ flag-off UI is identical to today.
  const showLinux = usePlatformFeatures().FEATURE_LINUX;
  const [platformScope, setPlatformScope] = useState<"windows" | "linux">("windows");
  const [tab, setTab] = useState<TabId>("msi");
  const [packages, setPackages] = useState<AgentPackage[]>([]);
  const [version, setVersion] = useState("");
  const [platform, setPlatform] = useState<AgentPackagePlatform>("windows-amd64");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentPackage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentTab = TABS.find((t) => t.id === tab)!;

  const visiblePackages = useMemo(
    () => packages.filter((pkg) => pkg.file_type === currentTab.fileType),
    [packages, currentTab.fileType],
  );

  const activeCount = useMemo(
    () => visiblePackages.filter((pkg) => pkg.is_active).length,
    [visiblePackages],
  );

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      setPackages(await getAgentPackages());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load packages");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleUpload = async () => {
    if (!file || !version.trim()) {
      setError("Version and package file are required");
      return;
    }
    try {
      setUploading(true);
      setError(null);
      await uploadAgentPackage({
        version: version.trim(),
        platform: currentTab.fixedPlatform ?? platform,
        file,
        file_type: currentTab.fileType,
      });
      setVersion("");
      setFile(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleActiveToggle = async (pkg: AgentPackage, isActive: boolean) => {
    try {
      setBusyId(pkg.id);
      setError(null);
      await setAgentPackageActive(pkg.id, isActive);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Package update failed");
    } finally {
      setBusyId(null);
    }
  };

  const handleDownload = async (pkg: AgentPackage) => {
    try {
      setBusyId(pkg.id);
      setError(null);
      await downloadAgentPackage(pkg);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
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

  return (
    <section className="premium-page space-y-5">
      <PageHeader
        title="Agent Packages"
        description="Manage downloadable Techi Agent packages for GPO deployments and binary-only updates."
        actions={
          <>
            <Badge variant="ghost">{activeCount} active</Badge>
            <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
              <RefreshCcw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </>
        }
      />

      <div className="premium-card overflow-hidden px-5 pb-4 pt-1">

        {/* Platform scope toggle — only when Linux is enabled */}
        {showLinux && (
          <div className="mt-4 inline-flex rounded-lg border border-white/[0.08] p-0.5">
            {(["windows", "linux"] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                onClick={() => { setPlatformScope(scope); setError(null); }}
                className={[
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition-colors",
                  platformScope === scope ? "bg-techi-accent-dim text-techi-orange" : "text-slate-400 hover:text-slate-200",
                ].join(" ")}
              >
                <PlatformIcon platform={scope} size={13} />
                {scope}
              </button>
            ))}
          </div>
        )}

        {/* Windows tabs (unchanged) — only in the Windows scope */}
        {platformScope === "windows" && (
          <>
            <div className="mt-4 flex gap-1 border-b border-white/[0.08]">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => { setTab(t.id); setError(null); }}
                  className={[
                    "flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors",
                    tab === t.id
                      ? "border-b-2 border-techi-orange text-techi-orange"
                      : "text-slate-400 hover:text-slate-200",
                  ].join(" ")}
                >
                  {t.id === "msi" ? <Package className="h-3.5 w-3.5" /> : <Binary className="h-3.5 w-3.5" />}
                  {t.label}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">{currentTab.hint}</p>
          </>
        )}
      </div>

      {platformScope === "linux" && <LinuxPackagesPanel canManage={canManage} />}

      {platformScope === "windows" && canManage && (
        <div className="premium-card-soft p-4">
          <div className="mb-3 flex items-center gap-2">
            <UploadCloud className="h-4 w-4 text-techi-orange" />
            <h2 className="text-sm font-semibold text-white">
              {tab === "msi"
                ? "Upload MSI package"
                : tab === "agent_update_msi"
                  ? "Upload Agent Update Bridge MSI"
                  : tab === "remote_support_msi"
                    ? "Upload Remote Support MSI"
                    : "Upload Agent Binary (techi-agent.exe)"}
            </h2>
          </div>
          <div className="grid gap-2 lg:grid-cols-[160px_190px_minmax(0,1fr)_auto]">
            <input
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder="Version (e.g. 2.1.1)"
              className={INPUT_CLS}
            />
            {currentTab.fixedPlatform ? (
              <div className={`${INPUT_CLS} flex items-center text-slate-400`}>
                {currentTab.fixedPlatform}
              </div>
            ) : (
              <SelectField
                value={platform}
                onChange={(event) => setPlatform(event.target.value as AgentPackagePlatform)}
                id="package-platform"
                name="package-platform"
                aria-label="Platform"
                className={INPUT_CLS}
              >
                {PLATFORMS.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </SelectField>
            )}
            <input
              type="file"
              id="package-file"
              name="package-file"
              aria-label="Package file"
              accept={tab === "agent_binary" ? ".exe" : ".msi"}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className={`${INPUT_CLS} file:mr-3 file:rounded-md file:border-0 file:bg-techi-orange/15 file:px-2 file:py-1 file:text-xs file:font-semibold file:text-techi-orange`}
            />
            <Button onClick={handleUpload} disabled={uploading}>
              <UploadCloud className="h-4 w-4" />
              Upload
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-sm font-medium text-red-100">
          {error}
        </div>
      )}

      {platformScope === "windows" && (
      <div className="premium-card-soft overflow-hidden">
        <div className="border-b border-white/[0.08] px-4 py-3">
          <div className="flex items-center gap-2">
            {tab === "msi" ? (
              <Package className="h-4 w-4 text-techi-orange" />
            ) : (
              <Binary className="h-4 w-4 text-techi-orange" />
            )}
            <span className="text-sm font-semibold text-white">
              {loading ? "Loading..." : `${visiblePackages.length} package${visiblePackages.length === 1 ? "" : "s"}`}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-950/80">
              <tr className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Version</th>
                {tab === "msi" && <th className="px-4 py-3">Platform</th>}
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Uploaded</th>
                <th className="px-4 py-3">Uploader</th>
                <th className="px-4 py-3">File</th>
                <th className="px-4 py-3">SHA256</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {visiblePackages.length === 0 && (
                <tr>
                  <td colSpan={tab === "msi" ? 8 : 7} className="px-4 py-8 text-center text-sm font-medium text-slate-500">
                    {loading
                      ? "Loading..."
                      : `No ${tab === "msi"
                        ? "MSI packages"
                        : tab === "agent_update_msi"
                          ? "bridge MSI packages"
                          : tab === "remote_support_msi"
                            ? "Remote Support packages"
                            : "agent binaries"} uploaded yet.`}
                  </td>
                </tr>
              )}
              {visiblePackages.map((pkg) => (
                <tr key={pkg.id} className="text-slate-300 hover:bg-white/[0.025]">
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-white">{pkg.version}</td>
                  {tab === "msi" && <td className="whitespace-nowrap px-4 py-3 text-slate-300">{pkg.platform}</td>}
                  <td className="whitespace-nowrap px-4 py-3">
                    {pkg.is_active ? (
                      <Badge variant="ghost" className="border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="neutral">Inactive</Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-400">{formatDate(pkg.uploaded_at)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-400">{pkg.uploaded_by ?? "-"}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-500">{pkg.filename}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-500" title={pkg.sha256 ?? undefined}>
                    {pkg.sha256 ? `${pkg.sha256.slice(0, 12)}…` : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <Button variant="secondary" size="sm" onClick={() => void handleDownload(pkg)} disabled={busyId === pkg.id}>
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </Button>
                      {canManage && (
                        <>
                          <Button
                            size="sm"
                            variant={pkg.is_active ? "secondary" : "primary"}
                            onClick={() => void handleActiveToggle(pkg, !pkg.is_active)}
                            disabled={busyId === pkg.id}
                          >
                            {pkg.is_active ? "Deactivate" : "Activate"}
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => setDeleteTarget(pkg)}
                            disabled={busyId === pkg.id || deleting}
                            variant="danger"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {deleteTarget && (
        <ConfirmationModal
          title="Delete package"
          confirmLabel={deleting ? "Deleting" : "Delete"}
          loading={deleting}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void handleDelete()}
        >
          Permanently delete <span className="font-semibold text-white">{deleteTarget.filename}</span>?
          {deleteTarget.is_active && " This package is active — deleting it removes the current active package for this type."}
        </ConfirmationModal>
      )}
    </section>
  );
}
