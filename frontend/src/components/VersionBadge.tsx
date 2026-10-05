import { VersionStatus } from "../utils/version";

// Version Service UI — the ONE badge every platform's version comparison
// renders through (Device List + Generic Drawer). Windows keeps its exact
// prior 2-color (green/orange) output because it only ever passes
// status="current"|"outdated"; "ahead" (blue) is new and only reachable for
// connector platforms whose reported version can exceed the registry's
// latest_connector_version.
const STYLES: Record<VersionStatus, React.CSSProperties> = {
  current: { color: "var(--th-status-online)", background: "color-mix(in srgb, var(--th-status-online) 20%, transparent)", border: "1px solid color-mix(in srgb, var(--th-status-online) 35%, transparent)" },
  outdated: { color: "var(--th-accent)", background: "color-mix(in srgb, var(--th-accent) 20%, transparent)", border: "1px solid color-mix(in srgb, var(--th-accent) 35%, transparent)" },
  ahead: { color: "var(--th-status-info)", background: "color-mix(in srgb, var(--th-status-info) 20%, transparent)", border: "1px solid color-mix(in srgb, var(--th-status-info) 35%, transparent)" },
  unknown: { color: "var(--th-text-muted)", background: "color-mix(in srgb, var(--th-status-offline) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--th-status-offline) 22%, transparent)" },
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
