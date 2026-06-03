import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Download, Package, RefreshCcw, Trash2, UploadCloud } from "lucide-react";
import {
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
import { Badge, Button } from "../components/ui";
import { parseUTC } from "../utils/time";

const PLATFORMS: AgentPackagePlatform[] = ["windows", "windows-amd64", "windows-arm64", "linux-amd64", "darwin-arm64"];
const INPUT_CLS = "th-input rounded-lg border px-3 py-2 text-sm font-medium outline-none focus:border-techi-orange/60";

function formatDate(iso: string): string {
  return parseUTC(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function AgentPackages() {
  const { can } = useAuth();
  const canManage = can("admin");
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

  const activeCount = useMemo(() => packages.filter((pkg) => pkg.is_active).length, [packages]);

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
      await uploadAgentPackage({ version: version.trim(), platform, file });
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
      <div className="premium-card overflow-hidden p-5 md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="premium-kicker">Deployment</p>
            <h1 className="mt-1.5 text-3xl font-semibold text-white">Agent Packages</h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-400">
              Manage downloadable Techi Agent binaries for controlled MSP deployments.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="ghost">{activeCount} active</Badge>
            <Button size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCcw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {canManage && (
        <div className="premium-card-soft p-4">
          <div className="mb-3 flex items-center gap-2">
            <UploadCloud className="h-4 w-4 text-techi-orange" />
            <h2 className="text-sm font-semibold text-white">Upload package</h2>
          </div>
          <div className="grid gap-2 lg:grid-cols-[160px_190px_minmax(0,1fr)_auto]">
            <input
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder="Version"
              className={INPUT_CLS}
            />
            <select
              value={platform}
              onChange={(event) => setPlatform(event.target.value as AgentPackagePlatform)}
              className={INPUT_CLS}
            >
              {PLATFORMS.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <input
              type="file"
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

      <div className="premium-card-soft overflow-hidden">
        <div className="border-b border-white/[0.08] px-4 py-3">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-techi-orange" />
            <span className="text-sm font-semibold text-white">
              {loading ? "Loading packages..." : `${packages.length} package${packages.length === 1 ? "" : "s"}`}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-950/80">
              <tr className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Version</th>
                <th className="px-4 py-3">Platform</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Uploaded</th>
                <th className="px-4 py-3">Uploader</th>
                <th className="px-4 py-3">File</th>
                <th className="px-4 py-3">SHA256</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {packages.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm font-medium text-slate-500">
                    {loading ? "Loading..." : "No agent packages available."}
                  </td>
                </tr>
              )}
              {packages.map((pkg) => (
                <tr key={pkg.id} className="text-slate-300 hover:bg-white/[0.025]">
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-white">{pkg.version}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-300">{pkg.platform}</td>
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
                      <Button size="sm" onClick={() => void handleDownload(pkg)} disabled={busyId === pkg.id}>
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </Button>
                      {canManage && (
                        <>
                          <Button
                            size="sm"
                            onClick={() => void handleActiveToggle(pkg, !pkg.is_active)}
                            disabled={busyId === pkg.id}
                            className={pkg.is_active ? "th-btn-secondary" : undefined}
                          >
                            {pkg.is_active ? "Deactivate" : "Activate"}
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => setDeleteTarget(pkg)}
                            disabled={busyId === pkg.id || deleting}
                            className="th-btn-danger hover:bg-red-500/20"
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

      {deleteTarget && (
        <ConfirmationModal
          title="Delete agent package"
          confirmLabel={deleting ? "Deleting" : "Delete"}
          loading={deleting}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void handleDelete()}
        >
          Permanently delete <span className="font-semibold text-white">{deleteTarget.filename}</span>?
          {deleteTarget.is_active && " This package is active and deleting it removes the current active package for this platform."}
        </ConfirmationModal>
      )}
    </section>
  );
}
