import type { ReactNode } from "react";

import CopyButton from "./CopyButton";

/**
 * One compact label/value pair for a `<dl className="th-kv">` grid: a muted
 * label column, the value beside it. An empty value shows a faint dash.
 * With `copy`, a text value gets a copy button beside it.
 */
export default function Kv({
  label,
  children,
  span = false,
  mono = false,
  copy = false,
  title,
}: {
  label: string;
  children?: ReactNode;
  /** Take the whole line instead of half of it. */
  span?: boolean;
  mono?: boolean;
  /** Offer to copy the value (only a plain text value can be copied). */
  copy?: boolean;
  title?: string;
}) {
  const empty = children == null || children === "" || children === false;
  const copyText = copy && !empty && (typeof children === "string" || typeof children === "number") ? String(children) : null;
  return (
    <div className="th-kv-row" data-span={span ? "2" : undefined}>
      <dt>{label}</dt>
      <dd className={mono ? "font-mono" : undefined} data-empty={empty || undefined} title={title}>
        {empty ? "—" : children}
        {copyText && <CopyButton text={copyText} label={label} className="th-kv-copy" />}
      </dd>
    </div>
  );
}
