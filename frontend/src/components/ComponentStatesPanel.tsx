import { useEffect, useState } from "react";
import { Boxes } from "lucide-react";

import {
  ComponentLifecycle,
  DeviceComponentState,
  getDeviceComponentStates,
  getPlatformComponents,
} from "../api/platform";

// Read-only Platform Components panel for the Device Drawer. It reports, per
// managed component, the Installed and Desired versions, the derived Health
// Status, and the lifecycle operations the component supports (metadata only).
// It triggers nothing — no buttons, no actions. Data comes entirely from the
// Platform Components foundation endpoints (GET /devices/{id}/component-states
// and GET /platform/components); it renders nothing when either is unavailable
// or the device has no managed components (e.g. connectors).

const STATUS_STYLES: Record<string, string> = {
  current: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  outdated: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  missing: "border-red-400/25 bg-red-400/10 text-red-300",
  unknown: "border-slate-400/20 bg-slate-400/10 text-slate-300",
};

function StatusBadge({ health, status }: { health: string; status: string }) {
  const cls = STATUS_STYLES[health] ?? STATUS_STYLES.unknown;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
      {status}
    </span>
  );
}

export default function ComponentStatesPanel({ deviceId }: { deviceId: number }) {
  const [states, setStates] = useState<DeviceComponentState[] | null>(null);
  const [lifecycles, setLifecycles] = useState<Record<string, ComponentLifecycle[]>>({});

  useEffect(() => {
    let alive = true;
    getDeviceComponentStates(deviceId)
      .then((resp) => { if (alive) setStates(resp.components); })
      .catch(() => { if (alive) setStates([]); });
    getPlatformComponents()
      .then((resp) => {
        if (!alive) return;
        const map: Record<string, ComponentLifecycle[]> = {};
        for (const component of resp.components) map[component.id] = component.lifecycle;
        setLifecycles(map);
      })
      .catch(() => { /* lifecycle metadata is optional; versions still render */ });
    return () => { alive = false; };
  }, [deviceId]);

  // Loading or nothing to show (connector / endpoint unavailable) → render nothing.
  if (states === null || states.length === 0) return null;

  return (
    <section
      className="rounded-xl border p-3"
      style={{ borderColor: "var(--th-border-card)", background: "var(--th-bg-input, transparent)" }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className="flex h-5 w-5 items-center justify-center rounded-md"
          style={{ background: "var(--th-bg-shell)", color: "var(--th-text-muted)" }}
        >
          <Boxes className="h-3 w-3" />
        </span>
        <h3 className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>
          Components
        </h3>
      </div>

      <div className="space-y-2.5">
        {states.map((state) => {
          const operations = (lifecycles[state.component_id] ?? []).map((entry) => entry.label);
          return (
            <div
              key={state.component_id}
              className="rounded-lg border p-2.5"
              style={{ borderColor: "var(--th-border-subtle)" }}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12.5px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                  {state.display_name}
                </span>
                <StatusBadge health={state.health} status={state.status} />
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-3 text-[11.5px]" style={{ color: "var(--th-text-muted)" }}>
                <span>
                  Installed:{" "}
                  <span className="font-mono" style={{ color: "var(--th-text-primary)" }}>
                    {state.installed_version ?? "—"}
                  </span>
                </span>
                <span>
                  Desired:{" "}
                  <span className="font-mono" style={{ color: "var(--th-text-primary)" }}>
                    {state.desired_version ?? "—"}
                  </span>
                </span>
              </div>
              {operations.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {operations.map((op) => (
                    <span
                      key={op}
                      className="rounded border px-1.5 py-0.5 text-[10px] font-medium"
                      style={{ borderColor: "var(--th-border-subtle)", color: "var(--th-text-muted)" }}
                    >
                      {op}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
