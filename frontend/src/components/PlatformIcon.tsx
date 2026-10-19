// Single source of truth for per-platform iconography (Platform Expansion §17).
// A future platform is one new entry here — never a new component. Kept tiny
// and inline (no external assets) to match the self-contained design system.

import { useId } from "react";

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
  // Per-instance gradient id: the icon renders many times per page. useId's
  // colons are stripped so the id is safe inside url(#…).
  const gradientId = `win-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
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
        // Windows 11 mark: four equal flat squares sharing one diagonal gradient.
        <svg {...common} role="img" aria-label="Windows">
          <defs>
            <linearGradient id={gradientId} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#4CC2FF" />
              <stop offset="1" stopColor="#0067C0" />
            </linearGradient>
          </defs>
          <path
            fill={`url(#${gradientId})`}
            d="M3 3h8.6v8.6H3zM12.4 3H21v8.6h-8.6zM3 12.4h8.6V21H3zM12.4 12.4H21V21h-8.6z"
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
