import { useEffect, useState } from "react";
import { Suspense, lazy } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { TerminalSession } from "../api/terminal";
import { PowerShellCodeForm } from "../components/PowerShellStepUp";
import { Button } from "../components/ui";

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
 *
 * `?engine=powershell` (Windows, from the drawer's Maintenance tab): the
 * administrator PowerShell. A console ticket is single-use, so this window
 * opens its own session — after its own two-factor code — rather than taking
 * over one the drawer holds.
 */
export default function TerminalWindow() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const deviceId = Number(id);
  const name = params.get("name") || `Device #${deviceId}`;
  const powershell = params.get("engine") === "powershell";
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  // The operator ended it: the console is unmounted, which closes the socket.
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    const previous = document.title;
    document.title = `${powershell ? "PowerShell" : "Terminal"} — ${name} · TECHI Connect`;
    return () => {
      document.title = previous;
    };
  }, [name, powershell]);

  if (!Number.isFinite(deviceId) || deviceId <= 0) {
    return <div className="flex h-screen items-center justify-center text-sm th-text-muted">Invalid device.</div>;
  }

  const fallback = <div className="py-8 text-center text-sm th-text-muted">Loading terminal…</div>;

  if (powershell) {
    return (
      <div className="flex h-screen flex-col th-bg">
        <div className="flex items-center gap-3 border-b th-border px-3 py-1.5">
          <div className="min-w-0 truncate text-[12px] font-semibold th-text">{name} · PowerShell (Administrator)</div>
          <div className="ml-auto flex-none text-[11px] th-text-muted">
            {session ? (ended ?? "Session open") : "Two-factor code needed"} · runs as SYSTEM · recorded
          </div>
          {session && !ended && (
            <Button
              size="sm"
              variant="danger"
              className="!min-h-7"
              onClick={() => {
                setStopped(true);
                setEnded("Session ended");
              }}
            >
              End session
            </Button>
          )}
          {ended && (
            <Button size="sm" variant="secondary" className="!min-h-7" onClick={() => setSession(null)}>
              New session
            </Button>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {!session ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="th-drawer-card w-full max-w-sm">
                <p className="mb-3 text-[14px] font-semibold th-text">Open PowerShell as administrator</p>
                <PowerShellCodeForm
                  deviceId={deviceId}
                  formId="ps-window"
                  onOpened={(s) => {
                    setEnded(null);
                    setStopped(false);
                    setSession(s);
                  }}
                />
              </div>
            </div>
          ) : stopped ? (
            <div className="flex h-full items-center justify-center text-sm th-text-muted">Session ended.</div>
          ) : (
            <Suspense fallback={fallback}>
              <DeviceTerminal
                key={session.session_id}
                deviceId={deviceId}
                session={session}
                bare
                onClosed={(text) => setEnded(text)}
              />
            </Suspense>
          )}
        </div>
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
        <Suspense fallback={fallback}>
          <DeviceTerminal deviceId={deviceId} mode="agent" />
        </Suspense>
      </div>
    </div>
  );
}
