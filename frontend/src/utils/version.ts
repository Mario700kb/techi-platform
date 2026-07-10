// Frontend mirror of backend/app/services/version_service.py's compare_versions.
// Same tiny dotted-integer-tuple algorithm; kept in sync manually (both sides
// are a handful of lines and this pattern already exists for isAgentOutdated).
export type VersionStatus = "current" | "outdated" | "ahead" | "unknown";

function parseVersion(version: string): number[] | null {
  const parts = version.trim().replace(/^[vV]/, "").split(".");
  const nums = parts.map((p) => Number.parseInt(p, 10));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

export function compareVersions(reported?: string | null, latest?: string | null): VersionStatus {
  const r = (reported ?? "").trim();
  const l = (latest ?? "").trim();
  if (!r || !l) return "unknown";
  if (r === l) return "current";
  const rp = parseVersion(r);
  const lp = parseVersion(l);
  if (!rp || !lp) return "outdated";
  const len = Math.max(rp.length, lp.length);
  for (let i = 0; i < len; i++) {
    const a = rp[i] ?? 0;
    const b = lp[i] ?? 0;
    if (a !== b) return a > b ? "ahead" : "outdated";
  }
  return "current";
}
