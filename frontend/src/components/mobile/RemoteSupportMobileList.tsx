import { AlertTriangle, CheckCircle2, Loader2, PackageX, Search, Wrench } from "lucide-react";
import { RemoteSupportDevice } from "../../api/remoteSupport";
import { Button, ConnectButton, EmptyState } from "../ui";

/**
 * Remote Support — mobile view (docs/reference/MOBILE-DESIGN-SPEC.md —
 * Remote Support). Reuses the SAME filtered device list, search state, and
 * action handlers/state as the desktop RemoteSupport page — no business
 * logic duplication, only a mobile-appropriate presentation grouped into
 * Issues / Online & ready / Not installed.
 */

type ActionState = "idle" | "loading" | "success" | "error";

const STATUS_TONE: Record<string, string> = {
  online: "var(--th-status-online)",
  warning: "var(--th-status-warning)",
};

function DeviceRow({
  device,
  busy,
  onConnect,
  onRepair,
}: {
  device: RemoteSupportDevice;
  busy: ActionState | undefined;
  onConnect: () => void;
  onRepair: () => void;
}) {
  const isIssue = device.remote_support_status !== "online" && device.install_status !== "not_installed";
  const tone = STATUS_TONE[device.remote_support_status] ?? "var(--th-status-offline)";
  return (
    <div className="th-mrow" data-static="true">
      <span className="h-2 w-2 flex-none rounded-full" style={{ background: tone }} aria-hidden="true" />
      <span className="th-mrow-label">
        <strong>{device.hostname ?? `Device #${device.device_id}`}</strong>
        <small>
          <span style={{ color: tone }}>{device.install_status === "not_installed" ? "Not installed" : device.remote_support_status.charAt(0).toUpperCase() + device.remote_support_status.slice(1)}</span>
          {device.app_version && <span className="font-mono"> · v{device.app_version}</span>}
          {device.domain && <span> · {device.domain}</span>}
        </small>
      </span>
      <span className="th-mrow-end">
        {isIssue && (
          <button type="button" onClick={onRepair} disabled={busy === "loading"} aria-label="Repair" title="Repair" className="th-onb-action !h-8 !w-8" style={{ color: "var(--th-status-warning)" }}>
            {busy === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
          </button>
        )}
        <ConnectButton size="md" onClick={onConnect} disabled={!device.techi_remote_id} />
      </span>
    </div>
  );
}

function Section({ title, count, tone, icon: Icon, children }: { title: string; count: number; tone: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="th-onb-card overflow-hidden th-onb-enter">
      <div className="th-onb-card-head">
        <div className="th-onb-card-title">
          <span className="th-onb-icon" style={{ "--onb-tone": tone } as React.CSSProperties}><Icon className="h-4 w-4" /></span>
          <span className="min-w-0"><span className="block truncate">{title}</span></span>
        </div>
        <span className="th-status-chip !h-6 tabular-nums">{count}</span>
      </div>
      {children}
    </section>
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
  onRetry: () => void;
}) {
  const notInstalled = devices.filter((d) => d.install_status === "not_installed");
  const online = devices.filter((d) => d.remote_support_status === "online" && d.install_status !== "not_installed");
  const issues = devices.filter((d) => d.remote_support_status !== "online" && d.install_status !== "not_installed");

  const stats = [
    { label: "Ready", value: online.length, tone: "var(--th-status-online)", icon: CheckCircle2 },
    { label: "Issues", value: issues.length, tone: issues.length ? "var(--th-status-warning)" : "var(--th-text-faint)", icon: AlertTriangle },
    { label: "Not installed", value: notInstalled.length, tone: "var(--th-text-muted)", icon: PackageX },
  ];

  return (
    <div className="th-onb flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        {stats.map(({ label, value, tone, icon: Icon }) => (
          <div key={label} className="th-onb-card th-malert-stat">
            <span className="flex items-center gap-1.5 truncate text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
              <Icon className="h-3.5 w-3.5 flex-none" style={{ color: tone }} />
              <span className="truncate">{label}</span>
            </span>
            <span className="text-[22px] font-semibold leading-7 tabular-nums" style={{ color: loading ? "var(--th-text-faint)" : "var(--th-text-primary)" }}>{loading ? "—" : value}</span>
          </div>
        ))}
      </div>

      <label className="th-search h-10">
        <Search className="h-4 w-4 flex-none" />
        <input type="search" value={search} onChange={(e) => onSearchChange(e.target.value)} placeholder="Search devices…" aria-label="Search Remote Support devices" enterKeyHint="search" />
      </label>

      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2].map((i) => <div key={i} className="th-onb-card h-14 animate-pulse" style={{ opacity: 1 - i * 0.2 }} />)}
        </div>
      ) : error ? (
        <div className="th-onb-card">
          <EmptyState className="py-10" icon={<AlertTriangle className="h-5 w-5" />} title="Unable to load Remote Support" description={error} action={<Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button>} />
        </div>
      ) : devices.length === 0 ? (
        <div className="th-onb-card">
          <EmptyState className="py-10" icon={<Search className="h-5 w-5" />} title="No devices found" description={search ? "Nothing matches this search." : undefined} />
        </div>
      ) : (
        <>
          <Section title="Issues" count={issues.length} tone="var(--th-status-warning)" icon={AlertTriangle}>
            {issues.map((d) => <DeviceRow key={d.device_id} device={d} busy={actionStates[d.device_id]?.repair} onConnect={() => onConnect(d)} onRepair={() => onRepair(d)} />)}
          </Section>
          <Section title="Online & ready" count={online.length} tone="var(--th-status-online)" icon={CheckCircle2}>
            {online.map((d) => <DeviceRow key={d.device_id} device={d} busy={actionStates[d.device_id]?.repair} onConnect={() => onConnect(d)} onRepair={() => onRepair(d)} />)}
          </Section>
          <Section title="Not installed" count={notInstalled.length} tone="var(--th-text-muted)" icon={PackageX}>
            {notInstalled.map((d) => <DeviceRow key={d.device_id} device={d} busy={actionStates[d.device_id]?.repair} onConnect={() => onConnect(d)} onRepair={() => onRepair(d)} />)}
          </Section>
        </>
      )}
    </div>
  );
}
