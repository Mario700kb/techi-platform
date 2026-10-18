import type { ReactNode } from "react";

/**
 * One compact label/value pair for a `<dl className="th-kv">` grid: a muted
 * label column, the value beside it. An empty value shows a faint dash.
 */
export default function Kv({
  label,
  children,
  span = false,
  mono = false,
  title,
}: {
  label: string;
  children?: ReactNode;
  /** Take the whole line instead of half of it. */
  span?: boolean;
  mono?: boolean;
  title?: string;
}) {
  const empty = children == null || children === "" || children === false;
  return (
    <div className="th-kv-row" data-span={span ? "2" : undefined}>
      <dt>{label}</dt>
      <dd className={mono ? "font-mono" : undefined} data-empty={empty || undefined} title={title}>
        {empty ? "—" : children}
      </dd>
    </div>
  );
}
