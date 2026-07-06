import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * Offline banner (MOBILE-DESIGN-SPEC.md — Offline States; audit finding
 * B2, paired with sw.js's shell precache). Shown whenever the browser
 * reports it is offline; `lastFetchTime` (from AppDataContext) labels how
 * stale the visible data may be.
 */
function formatClock(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function OfflineBanner({ lastFetchTime }: { lastFetchTime: number | null }) {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      className="flex flex-none items-center gap-2 px-3 py-[6px] text-[11.5px] font-bold md:hidden"
      style={{
        background: "color-mix(in srgb, var(--th-status-warning) 14%, var(--th-bg-topbar))",
        borderBottom: "1px solid var(--th-status-warning)",
        color: "var(--th-status-warning)",
      }}
    >
      <WifiOff className="h-3.5 w-3.5 flex-none" />
      Offline — showing cached data from {formatClock(lastFetchTime)}
    </div>
  );
}
