import { useEffect, useMemo, useState } from "react";
import { Binary, CheckCircle2, Trash2, UploadCloud } from "lucide-react";

import {
  AgentPackage,
  AgentPackagePlatform,
  deleteAgentPackage,
  getAgentPackages,
  setAgentPackageActive,
  uploadAgentPackage,
} from "../api/agentPackages";
import { Badge, Button, SelectField } from "../components/ui";
import ConfirmationModal from "../components/ConfirmationModal";
import { APP_TIME_ZONE, parseUTC, DISPLAY_LOCALE } from "../utils/time";

const INPUT_CLS = "th-input rounded-lg border px-3 py-2 text-sm font-medium outline-none focus:border-techi-orange/60";

// Future architectures are configuration only: add to this list, nothing else.
const LINUX_ARCHES: AgentPackagePlatform[] = ["linux-amd64", "linux-arm64", "linux-armhf"];

function formatDate(iso: string): string {
  return parseUTC(iso).toLocaleString(DISPLAY_LOCALE, { hourCycle: "h23", timeZone: APP_TIME_ZONE, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface Props {
  canManage: boolean;
}

// Linux agent binaries live in the existing manifest store as file_type
// "agent_binary" with a linux-* platform. This panel is rendered only when
// FEATURE_LINUX is on, so the Windows packages experience is untouched.
export default function LinuxPackagesPanel({ canManage }: Props) {
  const [packages, setPackages] = useState<AgentPackage[]>([]);
  const [version, setVersion] = useState("");
  const [platform, setPlatform] = useState<AgentPackagePlatform>("linux-amd64");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentPackage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const linuxPackages = useMemo(
    () => packages.filter((p) => p.file_type === "agent_binary" && p.platform.startsWith("linux")),
    [packages],
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

  useEffect(() => { void load(); }, []);

  const handleUpload = async () => {
    if (!file || !version.trim()) {
      setError("Version and binary file are required");
      return;
    }
    try {
      setUploading(true);
      setError(null);
      await uploadAgentPackage({ version: version.trim(), platform, file, file_type: "agent_binary" });
      setVersion("");
      setFile(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleActivate = async (pkg: AgentPackage) => {
    try {
      setBusyId(pkg.id);
      await setAgentPackageActive(pkg.id, !pkg.is_active);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Activation failed");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      setBusyId(deleteTarget.id);
      await deleteAgentPackage(deleteTarget.id, deleteTarget.is_active);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-100">{error}</div>
      )}

      {canManage && (
        <div className="premium-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <UploadCloud className="h-4 w-4 text-techi-orange" />
            <h2 className="text-sm font-semibold text-white">Upload Linux agent binary (techi-agent)</h2>
          </div>
          <div className="grid gap-2 lg:grid-cols-[160px_190px_minmax(0,1fr)_auto]">
            <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="Version (e.g. 2.1.6)" className={INPUT_CLS} />
            <SelectField value={platform} onChange={(e) => setPlatform(e.target.value as AgentPackagePlatform)} aria-label="Architecture" className={INPUT_CLS}>
              {LINUX_ARCHES.map((a) => <option key={a} value={a}>{a}</option>)}
            </SelectField>
            <input type="file" aria-label="Binary file" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className={`${INPUT_CLS} file:mr-3 file:rounded-md file:border-0 file:bg-techi-orange/15 file:px-2 file:py-1 file:text-xs file:font-semibold file:text-techi-orange`} />
            <Button onClick={() => void handleUpload()} disabled={uploading || !file || !version.trim()}>
              {uploading ? "Uploading…" : "Upload"}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">SHA-alignment applies: the active binary per arch is what "Needs Agent Update" compares against.</p>
        </div>
      )}

      <div className="premium-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/5 text-[11px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Version</th>
                <th className="px-4 py-3">Arch</th>
                <th className="px-4 py-3">File</th>
                <th className="px-4 py-3">SHA256</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Uploaded</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">Loading…</td></tr>
              ) : linuxPackages.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No Linux binaries uploaded yet.</td></tr>
              ) : (
                linuxPackages.map((pkg) => (
                  <tr key={pkg.id} className="border-b border-white/5">
                    <td className="px-4 py-3 font-semibold text-white">{pkg.version}</td>
                    <td className="px-4 py-3"><Badge variant="ghost">{pkg.platform}</Badge></td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-400">{pkg.filename}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-500">{pkg.sha256 ? pkg.sha256.slice(0, 10) + "…" : "—"}</td>
                    <td className="px-4 py-3">
                      {pkg.is_active
                        ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" />Active</span>
                        : <span className="text-[11px] text-slate-500">Inactive</span>}
                    </td>
                    <td className="px-4 py-3 text-slate-400">{formatDate(pkg.uploaded_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {canManage && (
                          <>
                            <button type="button" disabled={busyId === pkg.id} onClick={() => void handleActivate(pkg)}
                              className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.06]">
                              <Binary className="h-3.5 w-3.5" />{pkg.is_active ? "Deactivate" : "Activate"}
                            </button>
                            <button type="button" onClick={() => setDeleteTarget(pkg)}
                              className="inline-flex items-center gap-1 rounded-md border border-red-400/30 px-2.5 py-1 text-xs font-semibold text-red-200 transition hover:bg-red-400/10">
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

      {deleteTarget && (
        <ConfirmationModal title="Delete Linux binary" confirmLabel="Delete"
          onConfirm={() => void handleDelete()} onClose={() => setDeleteTarget(null)}>
          <p className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
            Delete <strong>{deleteTarget.version} ({deleteTarget.platform})</strong>?
          </p>
        </ConfirmationModal>
      )}
    </div>
  );
}
