import type { Device } from "../api/devices";
import { humanize } from "../utils/deviceStatus";
import { cpuView, osView, storageView } from "../utils/system";
import { Kv } from "./ui";

/** CPU, memory and storage as three equal mini-stats; storage with how full it is. */
function HardwareStats({ device }: { device: Device }) {
  const cpu = cpuView(device.cpu);
  const disk = storageView(device.storage);
  return (
    <dl className="th-hw-stats" aria-label="Hardware">
      <div className="th-hw-stat">
        <dt>CPU</dt>
        <dd title={cpu?.raw ? `${cpu.name}\n${cpu.raw}` : (cpu?.name ?? undefined)}>
          <span data-wrap>{cpu?.name ?? "—"}</span>
        </dd>
      </div>
      <div className="th-hw-stat">
        <dt>Memory</dt>
        <dd>
          <span>{device.ram || "—"}</span>
        </dd>
      </div>
      <div className="th-hw-stat">
        <dt>Storage</dt>
        <dd>
          {disk ? (
            <>
              <span>
                {disk.freeGb} GB free of {disk.totalGb} GB
              </span>
              <span
                className="th-hw-bar"
                role="img"
                aria-label={`${disk.usedPct}% used`}
                title={`${disk.usedPct}% used`}
                data-tone={disk.usedPct >= 90 ? "critical" : disk.usedPct >= 80 ? "warning" : undefined}
              >
                <i style={{ width: `${disk.usedPct}%` }} />
              </span>
            </>
          ) : (
            <span title={device.storage || undefined}>{device.storage || "—"}</span>
          )}
        </dd>
      </div>
    </dl>
  );
}

/**
 * Overview → Identity: who is signed in and the OS on full lines, domain and
 * platform side by side, the hardware as three mini-stats and the capabilities the
 * agent reported as chips.
 */
export default function DeviceIdentityCard({
  device,
  liveUser,
  linux,
}: {
  device: Device;
  /** The signed-in user from the live stream, when it is streaming. */
  liveUser?: string | null;
  /** Linux support is on: show kernel, architecture and capabilities. */
  linux: boolean;
}) {
  const os = osView(device);
  const user = liveUser || device.current_user || null;
  const userSource =
    device.user_source && device.user_source !== "no_interactive_user" && device.user_source !== "fallback"
      ? device.user_source
      : null;
  const session =
    device.user_session_state && device.user_session_state !== "unknown" ? device.user_session_state : null;
  const capabilities = linux && device.capabilities ? Object.entries(device.capabilities) : [];

  return (
    <section className="mb-3.5" aria-label="Identity">
      <p className="premium-kicker mb-2">Identity</p>
      <div className="th-drawer-card">
        <dl className="th-kv">
          <Kv label="Current user" span>
            {(user || userSource || session) && (
              <>
                <span className={user ? undefined : "th-kv-muted"}>{user ?? "—"}</span>
                {userSource && (
                  <span
                    className={`inline-flex h-[18px] items-center rounded px-1 text-[11px] font-semibold ${
                      userSource === "rdp_session"
                        ? "border border-purple-400/25 bg-purple-400/[0.1] text-purple-300"
                        : "border border-sky-400/25 bg-sky-400/[0.1] text-sky-300"
                    }`}
                    title={userSource}
                  >
                    {userSource === "rdp_session" ? "RDP" : "Console"}
                  </span>
                )}
                {session && <span className="th-kv-muted">· Session: {session}</span>}
              </>
            )}
          </Kv>
          <Kv label="OS" span>
            {os.name}
            {os.detail && <span className="th-kv-muted">· {os.detail}</span>}
          </Kv>
          <Kv label="Domain">{device.domain}</Kv>
          <Kv label="Platform">{humanize(device.platform || device.os_name || "")}</Kv>
          {linux && device.kernel_version && (
            <Kv label="Kernel" mono>
              {device.kernel_version}
            </Kv>
          )}
          {linux && device.architecture && (
            <Kv label="Architecture" mono>
              {device.architecture}
            </Kv>
          )}
        </dl>
        {(device.cpu || device.ram || device.storage) && <HardwareStats device={device} />}
        {/* Capabilities — real data reported by the agent; only when Linux
            support is on and the device reported some. */}
        {capabilities.length > 0 && (
          <dl className="th-kv mt-2">
            <Kv label="Capabilities" span>
              {capabilities.map(([name, version]) => (
                <span key={name} className="th-kv-chip">
                  {name}
                  {version ? <span className="font-mono font-normal opacity-70">{version}</span> : null}
                </span>
              ))}
            </Kv>
          </dl>
        )}
      </div>
    </section>
  );
}
