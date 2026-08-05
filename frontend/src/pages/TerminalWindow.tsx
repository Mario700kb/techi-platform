import { useEffect } from "react";
import { Suspense, lazy } from "react";
import { useParams, useSearchParams } from "react-router-dom";

const DeviceTerminal = lazy(() => import("../components/DeviceTerminal"));

/**
 * Standalone Web Terminal, opened with window.open from the Device Catalog.
 *
 * A separate browser window rather than a modal because a terminal is a
 * long-lived working surface: it can be moved to a second screen and stays
 * usable while the operator navigates the catalog. Same origin, so it shares
 * the session token from localStorage — no second login.
 *
 * Deliberately chrome-free: no sidebar, no topbar. The window IS the terminal,
 * and the terminal fills it.
 */
export default function TerminalWindow() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const deviceId = Number(id);
  const name = params.get("name") || `Device #${deviceId}`;

  useEffect(() => {
    const previous = document.title;
    document.title = `Terminal — ${name}`;
    return () => {
      document.title = previous;
    };
  }, [name]);

  if (!Number.isFinite(deviceId) || deviceId <= 0) {
    return (
      <div className="flex h-screen items-center justify-center text-sm th-text-muted">
        Invalid device.
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col th-bg">
      <div className="flex items-center justify-between border-b th-border px-3 py-1.5">
        <div className="truncate text-[12px] font-semibold th-text">{name}</div>
        <div className="text-[11px] th-text-muted">Web Terminal</div>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={<div className="py-8 text-center text-sm th-text-muted">Loading terminal…</div>}
        >
          <DeviceTerminal deviceId={deviceId} mode="agent" />
        </Suspense>
      </div>
    </div>
  );
}
