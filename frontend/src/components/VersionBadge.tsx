import { VersionStatus } from "../utils/version";

// Version Service UI — the ONE badge every platform's version comparison
// renders through (Device List + Generic Drawer). Windows keeps its exact
// prior 2-color (green/orange) output because it only ever passes
// status="current"|"outdated"; "ahead" (blue) is new and only reachable for
// connector platforms whose reported version can exceed the registry's
// latest_connector_version.
const STYLES: Record<VersionStatus, React.CSSProperties> = {
  current: { color: "#22c55e", background: "rgba(34,197,94,0.2)", border: "1px solid rgba(34,197,94,0.35)" },
  outdated: { color: "#f97316", background: "rgba(249,115,22,0.2)", border: "1px solid rgba(249,115,22,0.35)" },
  ahead: { color: "#3b82f6", background: "rgba(59,130,246,0.2)", border: "1px solid rgba(59,130,246,0.35)" },
  unknown: { color: "var(--th-text-muted)", background: "rgba(148,163,184,0.12)", border: "1px solid rgba(148,163,184,0.22)" },
};

interface Props {
  version?: string | null;
  status: VersionStatus;
  title?: string;
}

export default function VersionBadge({ version, status, title }: Props) {
  if (!version) {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-bold" style={STYLES.unknown}>
        —
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-bold" style={STYLES[status]} title={title}>
      {version}
    </span>
  );
}
