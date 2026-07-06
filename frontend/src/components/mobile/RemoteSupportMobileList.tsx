import { AlertTriangle, ExternalLink, Loader2, Search, Wrench } from "lucide-react";
import { RemoteSupportDevice } from "../../api/remoteSupport";
import { MBadge } from "./primitives";

/**
 * Remote Support — mobile view (docs/reference/MOBILE-DESIGN-SPEC.md —
 * Remote Support). Reuses the SAME filtered device list, search state, and
 * action handlers/state as the desktop RemoteSupport page — no business
 * logic duplication, only a mobile-appropriate presentation grouped into
 * Issues / Online & ready / Not installed.
 */

type ActionState = "idle" | "loading" | "success" | "error";

function DeviceRow({
  device,
  busy,
  onConnect,
  onRepair,
  onRestart,
}: {
  device: RemoteSupportDevice;
  busy: ActionState | undefined;
  onConnect: () => void;
  onRepair: () => void;
  onRestart: () => void;
}) {
  const isIssue = device.remote_support_status !== "online" && device.install_status !== "not_installed";
  return (
    <div className="flex items-center gap-3 px-4 py-[11px]" style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-extrabold" style={{ color: "var(--th-text-primary)" }}>
          {device.hostname ?? `Device #${device.device_id}`}
        </p>
        <div className="mt-[3px] flex flex-wrap items-center gap-[6px] text-[11px]" style={{ color: "var(--th-text-muted)" }}>
          <MBadge
            variant={device.remote_support_status === "online" ? "online" : device.remote_support_status === "warning" ? "warning" : "offline"}
          >
            {device.remote_support_status}
          </MBadge>
          {device.app_version && <span className="font-mono">v{device.app_version}</span>}
          {device.domain && <span>{device.domain}</span>}
        </div>
      </div>
      {isIssue && (
        <button
          type="button"
          onClick={onRepair}
          disabled={busy === "loading"}
          aria-label="Repair"
          className="flex h-9 w-9 flex-none items-center justify-center rounded-lg disabled:opacity-50"
          style={{ background: "var(--th-chip-bg)", border: "1px solid var(--th-border-subtle)", color: "var(--th-status-warning)" }}
        >
          {busy === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
        </button>
      )}
      <button
        type="button"
        onClick={onConnect}
        disabled={!device.techi_remote_id}
        className="flex h-9 flex-none items-center gap-1.5 rounded-lg px-3 text-[12px] font-bold text-white disabled:opacity-40"
        style={{ background: "var(--th-accent)" }}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Connect
      </button>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="overflow-hidden rounded-[14px]" style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}>
      <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
        <p className="text-[11px] font-extrabold uppercase tracking-[0.08em]" style={{ color: "var(--th-text-muted)" }}>
          {title}
        </p>
        <span className="ml-auto text-[11px] font-bold" style={{ color: "var(--th-text-muted)" }}>{count}</span>
      </div>
      {children}
    </div>
  );
}

export function RemoteSupportMobileList({
  devices,
  loading,
  error,
  search,
  onSearchChange,
  actionStates,
  onConnect,
  onRepair,
  onRestart,
  onRetry,
}: {
  devices: RemoteSupportDevice[];
  loading: boolean;
  error: string | null;
  search: string;
  onSearchChange: (v: string) => void;
  actionStates: Record<number, { repair?: ActionState; restart?: ActionState }>;
  onConnect: (d: RemoteSupportDevice) => void;
  onRepair: (d: RemoteSupportDevice) => void;
  onRestart: (d: RemoteSupportDevice) => void;
  onRetry: () => void;
}) {
  const notInstalled = devices.filter((d) => d.install_status === "not_installed");
  const online = devices.filter((d) => d.remote_support_status === "online" && d.install_status !== "not_installed");
  const issues = devices.filter((d) => d.remote_support_status !== "online" && d.install_status !== "not_installed");

  return (
    <div className="flex flex-col gap-[10px]">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "var(--th-text-muted)" }} />
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search devices…"
          className="w-full rounded-lg border py-2.5 pl-9 pr-3 text-[13px] font-medium outline-none"
          style={{ background: "var(--th-chip-bg)", borderColor: "var(--th-border-subtle)", color: "var(--th-text-primary)" }}
        />
      </div>

      {loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-[14px]" style={{ background: "var(--th-bg-card)" }} />
          ))}
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 rounded-[14px] py-10 text-center" style={{ background: "var(--th-bg-card)" }}>
          <AlertTriangle className="h-6 w-6" style={{ color: "var(--th-status-critical)" }} />
          <p className="text-[13px] font-bold" style={{ color: "var(--th-text-primary)" }}>{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg px-4 py-2 text-[12px] font-bold"
            style={{ background: "var(--th-accent-glow)", color: "var(--th-accent)", border: "1px solid var(--th-accent-border)" }}
          >
            Try again
          </button>
        </div>
      ) : devices.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-[14px] py-10 text-center" style={{ background: "var(--th-bg-card)" }}>
          <p className="text-[13px] font-bold" style={{ color: "var(--th-text-primary)" }}>No devices found</p>
        </div>
      ) : (
        <>
          <Section title="Issues" count={issues.length}>
            {issues.map((d) => (
              <DeviceRow
                key={d.device_id}
                device={d}
                busy={actionStates[d.device_id]?.repair}
                onConnect={() => onConnect(d)}
                onRepair={() => onRepair(d)}
                onRestart={() => onRestart(d)}
              />
            ))}
          </Section>
          <Section title="Online & ready" count={online.length}>
            {online.map((d) => (
              <DeviceRow
                key={d.device_id}
                device={d}
                busy={actionStates[d.device_id]?.repair}
                onConnect={() => onConnect(d)}
                onRepair={() => onRepair(d)}
                onRestart={() => onRestart(d)}
              />
            ))}
          </Section>
          <Section title="Not installed" count={notInstalled.length}>
            {notInstalled.map((d) => (
              <DeviceRow
                key={d.device_id}
                device={d}
                busy={actionStates[d.device_id]?.repair}
                onConnect={() => onConnect(d)}
                onRepair={() => onRepair(d)}
                onRestart={() => onRestart(d)}
              />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}
