// Single source of truth for per-platform iconography (Platform Expansion §17).
// A future platform is one new entry here — never a new component. Kept tiny
// and inline (no external assets) to match the self-contained design system.

type PlatformKey = "windows" | "linux" | "mikrotik" | "synology" | "qnap" | "unknown";

function normalize(platform?: string | null): PlatformKey {
  const p = (platform || "").toLowerCase();
  if (p.includes("linux") || p === "ubuntu" || p === "debian") return "linux";
  if (p.includes("windows") || p === "") return "windows";
  if (p.includes("mikrotik") || p.includes("routeros")) return "mikrotik";
  if (p.includes("synology")) return "synology";
  if (p.includes("qnap")) return "qnap";
  return "unknown";
}

interface Props {
  platform?: string | null;
  size?: number;
  className?: string;
}

export default function PlatformIcon({ platform, size = 14, className }: Props) {
  const key = normalize(platform);
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    className,
    "aria-hidden": true,
    focusable: false,
  } as const;

  switch (key) {
    case "linux":
      return (
        <svg {...common} role="img" aria-label="Linux">
          <path
            fill="#B8B8C2"
            d="M12 2.3c-2.5 0-4 1.8-4 4.6 0 1.8-.7 3.2-1.7 4.9-1 1.6-1.6 3.2-1.6 4.8 0 3 3.2 5.1 7.3 5.1s7.3-2.1 7.3-5.1c0-1.6-.6-3.2-1.6-4.8-1-1.7-1.7-3.1-1.7-4.9 0-2.8-1.5-4.6-4-4.6z"
          />
          <ellipse fill="#F5F5F7" cx="12" cy="16.2" rx="3.9" ry="4.4" />
          <circle fill="#17171A" cx="10.4" cy="7.2" r=".8" />
          <circle fill="#17171A" cx="13.6" cy="7.2" r=".8" />
          <path fill="#E85A3C" d="m12 7.9 1.7 1.3-1.7 1.1-1.7-1.1z" />
        </svg>
      );
    case "windows":
      return (
        <svg {...common} role="img" aria-label="Windows">
          <path
            style={{ fill: "var(--th-status-info)" }}
            d="M3 5.4l7.7-1.1v7.2H3zM12 4.1 21 3v8.5h-9zM3 12.5h7.7v7.2L3 18.6zM12 12.5h9V21l-9-1.3z"
          />
        </svg>
      );
    case "mikrotik":
      return (
        <svg {...common} role="img" aria-label="MikroTik">
          <rect x="3" y="13.5" width="18" height="6" rx="1.5" fill="none" stroke="#B8B8C2" strokeWidth="1.7" />
          <path d="M7.5 13.5V7M16.5 13.5V4" stroke="#B8B8C2" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="7.5" cy="16.5" r="1" fill="#E85A3C" />
        </svg>
      );
    default:
      return (
        <svg {...common} role="img" aria-label="Device">
          <rect x="3" y="4" width="18" height="13" rx="2" fill="none" stroke="#A0A0AA" strokeWidth="1.8" />
          <path d="M8 20h8M12 17v3" stroke="#A0A0AA" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
  }
}
