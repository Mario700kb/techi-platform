import { useMemo } from "react";
import { encode } from "uqr";

/**
 * A QR code drawn as one SVG path — no canvas, no innerHTML, no image the
 * CSP would have to allow. Dark modules on a white plate so phone cameras
 * read it in either theme.
 */
export default function QrCode({ value, size = 184, label }: { value: string; size?: number; label: string }) {
  const { path, dimension } = useMemo(() => {
    const { data, size: modules } = encode(value, { ecc: "M", border: 2 });
    let d = "";
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { path: d, dimension: modules };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${dimension} ${dimension}`}
      shapeRendering="crispEdges"
      className="rounded-lg"
      style={{ background: "#ffffff" }}
    >
      <path d={path} fill="#000000" />
    </svg>
  );
}
