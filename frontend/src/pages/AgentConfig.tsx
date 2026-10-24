import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Activity,
  Check,
  ClipboardCopy,
  Clock,
  Gauge,
  Info,
  KeyRound,
  Monitor,
  Package,
  RotateCcw,
  ScrollText,
  Timer,
} from "lucide-react";
import { AgentConfig, getAgentConfig, getHeartbeatScript, putAgentConfig } from "../api/agentConfig";
import AgentCommandsPanel from "../components/AgentCommandsPanel";
import { Button, EmptyState, PageHeader } from "../components/ui";
import { CardHead } from "../components/ui/PanelCard";
import SaveFooter, { useSaveState } from "../components/ui/SaveFooter";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";

type CopyTarget = "rollout" | "rollback" | null;
const PLATFORM_ROWS = [
  ["windows", "Windows"],
  ["linux", "Linux"],
  ["macos", "macOS"],
  ["mikrotik", "RouterOS"],
  ["synology", "Synology"],
  ["qnap", "QNAP"],
  ["truenas", "TrueNAS"],
  ["vmware", "VMware"],
  ["proxmox", "Proxmox"],
] as const;
/** Platforms whose agents can collect installed software. */
const SOFTWARE_ROWS = [
  ["windows", "Windows"],
  ["linux", "Linux"],
  ["macos", "macOS"],
] as const;
const INVENTORY_MIN = 300;
const INVENTORY_MAX = 86400;

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

function intervalsFrom(cfg: AgentConfig) {
  return {
    heartbeat: Object.fromEntries(
      PLATFORM_ROWS.map(([id]) => [id, String(cfg.platform_heartbeat_intervals[id] ?? cfg.heartbeat_interval_seconds)]),
    ),
    inventory: Object.fromEntries(
      PLATFORM_ROWS.map(([id]) => [id, String(cfg.platform_inventory_intervals[id] ?? 1800)]),
    ),
  };
}

function softwareFrom(cfg: AgentConfig): Record<string, boolean> {
  return Object.fromEntries(SOFTWARE_ROWS.map(([id]) => [id, cfg.platform_collect_software?.[id] ?? true]));
}

function keepEdits(current: Record<string, string>, seeded: Record<string, string>, next: Record<string, string>) {
  return Object.fromEntries(PLATFORM_ROWS.map(([id]) => [id, current[id] === seeded[id] ? next[id] : current[id]]));
}

export default function AgentConfigPage() {
  const { data, loading, error: loadError, setData } = useCachedQuery("page.agent-config", getAgentConfig);
  const config = data ?? null;
  const [seededFrom, setSeededFrom] = useState<AgentConfig | null>(null);
  const [heartbeatInputs, setHeartbeatInputs] = useState<Record<string, string>>({});
  const [inventoryInputs, setInventoryInputs] = useState<Record<string, string>>({});
  const [managedPasswordEnabled, setManagedPasswordEnabled] = useState(true);
  const [softwareInputs, setSoftwareInputs] = useState<Record<string, boolean>>({});
  const [copying, setCopying] = useState<CopyTarget>(null);
  const [copied, setCopied] = useState<CopyTarget>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const policyState = useSaveState();
  const remoteState = useSaveState();
  const softwareState = useSaveState();

  const apply = (cfg: AgentConfig) => {
    setData(cfg);
    setSeededFrom(cfg);
    const next = intervalsFrom(cfg);
    setHeartbeatInputs(next.heartbeat);
    setInventoryInputs(next.inventory);
    setManagedPasswordEnabled(cfg.remote_support_managed_password_enabled);
    setSoftwareInputs(softwareFrom(cfg));
  };

  // A cached copy seeds the form at once; the fresh answer then replaces only
  // the values the operator has not changed since.
  if (config && config !== seededFrom) {
    const next = intervalsFrom(config);
    setSeededFrom(config);
    if (!seededFrom) {
      setHeartbeatInputs(next.heartbeat);
      setInventoryInputs(next.inventory);
      setManagedPasswordEnabled(config.remote_support_managed_password_enabled);
      setSoftwareInputs(softwareFrom(config));
    } else {
      const seeded = intervalsFrom(seededFrom);
      setHeartbeatInputs(keepEdits(heartbeatInputs, seeded.heartbeat, next.heartbeat));
      setInventoryInputs(keepEdits(inventoryInputs, seeded.inventory, next.inventory));
      if (managedPasswordEnabled === seededFrom.remote_support_managed_password_enabled) {
        setManagedPasswordEnabled(config.remote_support_managed_password_enabled);
      }
      const seededSoftware = softwareFrom(seededFrom);
      const nextSoftware = softwareFrom(config);
      setSoftwareInputs(
        Object.fromEntries(
          SOFTWARE_ROWS.map(([id]) => [
            id,
            softwareInputs[id] === seededSoftware[id] ? nextSoftware[id] : softwareInputs[id],
          ]),
        ),
      );
    }
  }

  const ceiling = config?.maximum_allowed_interval_seconds ?? 600;
  const floorFor = (id: string) =>
    config?.platform_minimum_intervals?.[id] ?? config?.minimum_allowed_interval_seconds ?? 60;

  const original = config ? intervalsFrom(config) : null;
  // Only a changed value is held to the limits, as on the server: a platform
  // the growing fleet has pushed below its floor must not block the others.
  const heartbeatProblem = (id: string): "floor" | "ceiling" | null => {
    if (!original || heartbeatInputs[id] === original.heartbeat[id]) return null;
    const hb = Number(heartbeatInputs[id]);
    if (!Number.isInteger(hb) || hb < floorFor(id)) return "floor";
    if (hb > ceiling) return "ceiling";
    return null;
  };
  const inventoryProblem = (id: string) => {
    if (!original || inventoryInputs[id] === original.inventory[id]) return false;
    const inv = Number(inventoryInputs[id]);
    return !Number.isInteger(inv) || inv < INVENTORY_MIN || inv > INVENTORY_MAX;
  };
  // The first problem in the table, shown in the footer and blocking save.
  const rowProblem = (id: string, label: string): string | null => {
    const hb = heartbeatProblem(id);
    if (hb === "floor") return `${label}: heartbeat must be at least ${floorFor(id)}s for the devices it covers.`;
    if (hb === "ceiling")
      return `${label}: heartbeat above ${ceiling}s lets healthy devices show as stale between heartbeats.`;
    if (inventoryProblem(id))
      return `${label}: inventory must be between ${INVENTORY_MIN} and ${formatCount(INVENTORY_MAX)}s.`;
    return null;
  };
  // A platform whose capacity floor is above the online ceiling has no valid
  // interval left: that needs more host capacity or a longer online window.
  const squeezed = config ? PLATFORM_ROWS.filter(([id]) => floorFor(id) > ceiling) : [];
  const problems = PLATFORM_ROWS.map(([id, label]) => rowProblem(id, label)).filter(Boolean) as string[];

  const policyDirty =
    original !== null &&
    PLATFORM_ROWS.some(
      ([id]) => heartbeatInputs[id] !== original.heartbeat[id] || inventoryInputs[id] !== original.inventory[id],
    );
  const remoteDirty = config !== null && managedPasswordEnabled !== config.remote_support_managed_password_enabled;
  const softwareDirty =
    config !== null && SOFTWARE_ROWS.some(([id]) => softwareInputs[id] !== softwareFrom(config)[id]);

  const savePolicy = () => {
    if (problems.length) return;
    void policyState.run(
      async () => {
        apply(
          await putAgentConfig({
            platform_heartbeat_intervals: Object.fromEntries(
              PLATFORM_ROWS.map(([id]) => [id, Number(heartbeatInputs[id])]),
            ),
            platform_inventory_intervals: Object.fromEntries(
              PLATFORM_ROWS.map(([id]) => [id, Number(inventoryInputs[id])]),
            ),
          }),
        );
      },
      "Interval policy saved; devices pick it up on their next heartbeat",
      "Failed to save the interval policy",
    );
  };

  const saveRemote = () =>
    void remoteState.run(
      async () => {
        apply(await putAgentConfig({ remote_support_managed_password_enabled: managedPasswordEnabled }));
      },
      "Remote Support setting saved",
      "Failed to save the Remote Support setting",
    );

  const saveSoftware = () =>
    void softwareState.run(
      async () => {
        apply(await putAgentConfig({ platform_collect_software: softwareInputs }));
      },
      "Saved; agents from 2.1.42 pick it up on their next heartbeat",
      "Failed to save the software collection setting",
    );

  async function copyScript(seconds: number, target: CopyTarget) {
    setCopying(target);
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(await getHeartbeatScript(seconds));
      setCopied(target);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 2500);
    } catch (err) {
      setCopyError(message(err, "Couldn't copy the script"));
    } finally {
      setCopying(null);
    }
  }

  const windowsInterval = config?.platform_heartbeat_intervals?.windows ?? config?.heartbeat_interval_seconds ?? 300;
  const load = config?.projected_requests_per_second ?? 0;

  return (
    <section className="premium-page th-onb space-y-4">
      <PageHeader
        title="Agent Configuration"
        description="The heartbeat and inventory policy every agent follows, and the bulk command center."
      />

      {loadError && (
        <div className="th-onb-card">
          <EmptyState
            icon={<Info className="h-5 w-5" />}
            title="Couldn't load the agent configuration"
            description={loadError}
          />
        </div>
      )}

      {/* ── summary ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Devices served",
            value: config ? formatCount(config.active_device_count) : "—",
            hint: "Active agents on this policy",
            icon: Monitor,
            tone: "var(--th-accent)",
          },
          {
            label: "Heartbeat load",
            value: config ? `${load.toFixed(1)}/s` : "—",
            hint: `At ${windowsInterval}s for Windows`,
            icon: Gauge,
            tone: TONE.info,
          },
          {
            label: "Online for",
            value: config ? `${config.online_threshold_minutes} min` : "—",
            hint: "After the last heartbeat",
            icon: Activity,
            tone: TONE.online,
          },
          {
            label: "Stale after",
            value: config ? `${config.stale_threshold_minutes} min` : "—",
            hint: "Then offline once timed out",
            icon: Clock,
            tone: TONE.warning,
          },
        ].map((item, index) => (
          <div
            key={item.label}
            className="th-onb-card th-onb-stat th-onb-enter"
            style={{ "--i": index } as CSSProperties}
          >
            <span className="th-onb-icon" style={{ "--onb-tone": item.tone } as CSSProperties}>
              <item.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                {item.label}
              </div>
              <div
                className="text-[24px] font-semibold leading-8 tabular-nums"
                style={{ color: "var(--th-text-primary)" }}
              >
                {item.value}
              </div>
              <div className="truncate text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                {item.hint}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* ── interval policy ─────────────────────────────────────────────── */}
        <div className="th-onb-card th-onb-enter" style={{ "--i": 4 } as CSSProperties}>
          <CardHead
            icon={Timer}
            tone="var(--th-accent)"
            title="Heartbeat & inventory policy"
            subtitle={
              config
                ? `Heartbeat allowed up to ${ceiling}s; the lower bound depends on how many devices each platform has`
                : "Loading…"
            }
          />
          <div className="th-onb-note mx-5 mt-4" style={{ "--onb-tone": "var(--th-status-info)" } as CSSProperties}>
            <Info className="h-4 w-4" />
            <span>
              <strong>Heartbeat</strong> reaches every agent on its next heartbeat, with no GPO or script.{" "}
              <strong>Inventory</strong> is applied for RouterOS only today; the other values are stored for when the
              agent supports them.
            </span>
          </div>
          {squeezed.length > 0 && (
            <div
              className="th-onb-note mx-5 mt-3"
              style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
              role="alert"
            >
              <Info className="h-4 w-4" />
              <span>
                <strong>{squeezed.map(([, label]) => label).join(", ")}</strong> has outgrown the heartbeat budget: its
                devices need at least {floorFor(squeezed[0][0])}s, but anything above {ceiling}s lets them show as
                stale. Raise <code className="font-mono">HEARTBEAT_RATE_BUDGET_PER_SEC</code> together with host
                capacity, or lengthen the online window.
              </span>
            </div>
          )}
          {loading ? (
            <div className="py-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.12 }} />
              ))}
            </div>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="th-alerts-table th-policy-table">
                <colgroup>
                  <col />
                  <col className="w-[180px]" />
                  <col className="w-[180px]" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th>Heartbeat</th>
                    <th>Inventory</th>
                  </tr>
                </thead>
                <tbody>
                  {PLATFORM_ROWS.map(([id, label], index) => {
                    const hbBad = heartbeatProblem(id) !== null;
                    const invBad = inventoryProblem(id);
                    return (
                      <tr key={id} className="th-alerts-row" style={{ "--row": index } as CSSProperties}>
                        <td>
                          <span className="th-alerts-primary">{label}</span>
                          <span
                            className="th-alerts-secondary"
                            style={floorFor(id) > ceiling ? { color: "var(--th-status-critical)" } : undefined}
                          >
                            {floorFor(id) > ceiling
                              ? `Needs ${floorFor(id)}s, above the ${ceiling}s ceiling`
                              : `Heartbeat ${floorFor(id)}–${ceiling}s`}
                          </span>
                        </td>
                        <td>
                          <label className="th-policy-input" data-invalid={hbBad || undefined}>
                            <input
                              type="number"
                              min={floorFor(id)}
                              max={ceiling}
                              value={heartbeatInputs[id] ?? ""}
                              aria-label={`${label} heartbeat interval`}
                              onChange={(e) => setHeartbeatInputs((prev) => ({ ...prev, [id]: e.target.value }))}
                            />
                            <span>s</span>
                          </label>
                        </td>
                        <td>
                          <label className="th-policy-input" data-invalid={invBad || undefined}>
                            <input
                              type="number"
                              min={INVENTORY_MIN}
                              max={INVENTORY_MAX}
                              value={inventoryInputs[id] ?? ""}
                              aria-label={`${label} inventory interval`}
                              onChange={(e) => setInventoryInputs((prev) => ({ ...prev, [id]: e.target.value }))}
                            />
                            <span>s</span>
                          </label>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <SaveFooter
            dirty={policyDirty && problems.length === 0}
            saving={policyState.saving}
            saved={policyState.saved}
            error={policyState.error ?? (policyDirty ? (problems[0] ?? null) : null)}
            label="Save interval policy"
            onSave={savePolicy}
          />
        </div>

        <div className="flex flex-col gap-4">
          {/* ── remote support ─────────────────────────────────────────── */}
          <div className="th-onb-card th-onb-enter" style={{ "--i": 5 } as CSSProperties}>
            <CardHead
              icon={KeyRound}
              tone={TONE.info}
              title="Remote Support"
              subtitle="What Connect links carry for direct sessions"
            />
            <div className="th-onb-body flex-1">
              <div className="flex items-start justify-between gap-4">
                <span>
                  <span className="block text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
                    Auto-connect with the managed password
                  </span>
                  <span className="mt-0.5 block text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                    Connect sends the managed password; devices whose password differs still ask for it.
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={managedPasswordEnabled}
                  aria-label="Auto-connect with managed password"
                  className="th-onb-switch mt-0.5 flex-none"
                  disabled={loading}
                  onClick={() => setManagedPasswordEnabled((v) => !v)}
                >
                  <i />
                </button>
              </div>
            </div>
            <SaveFooter
              dirty={remoteDirty}
              saving={remoteState.saving}
              saved={remoteState.saved}
              error={remoteState.error}
              label="Save"
              onSave={saveRemote}
            />
          </div>

          {/* ── installed software ─────────────────────────────────────── */}
          <div className="th-onb-card th-onb-enter" style={{ "--i": 6 } as CSSProperties}>
            <CardHead
              icon={Package}
              tone={TONE.info}
              title="Installed software"
              subtitle="The software list on each device, and its Uninstall"
            />
            <div className="th-onb-body flex-1 space-y-3">
              {SOFTWARE_ROWS.map(([id, label]) => (
                <div key={id} className="flex items-start justify-between gap-4">
                  <span>
                    <span className="block text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
                      Collect on {label}
                    </span>
                    <span className="mt-0.5 block text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                      Read once an hour from the device. Agents before 2.1.42 keep their own setting.
                    </span>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={softwareInputs[id] ?? true}
                    aria-label={`Collect installed software on ${label}`}
                    className="th-onb-switch mt-0.5 flex-none"
                    disabled={loading}
                    onClick={() => setSoftwareInputs((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }))}
                  >
                    <i />
                  </button>
                </div>
              ))}
            </div>
            <SaveFooter
              dirty={softwareDirty}
              saving={softwareState.saving}
              saved={softwareState.saved}
              error={softwareState.error}
              label="Save"
              onSave={saveSoftware}
            />
          </div>

          {/* ── rollout scripts ────────────────────────────────────────── */}
          <div className="th-onb-card th-onb-enter flex-1" style={{ "--i": 7 } as CSSProperties}>
            <CardHead
              icon={ScrollText}
              tone={TONE.maintenance}
              title="Rollout scripts"
              subtitle="Only for devices that are not checking in"
            />
            <div className="th-onb-body flex-1">
              <p className="th-onb-hint">
                PowerShell that writes the interval into the agent's config. Run it as Administrator, or deploy it
                through a GPO scheduled task on the TECHI computers OU.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  variant="secondary"
                  onClick={() => void copyScript(windowsInterval, "rollout")}
                  disabled={copying === "rollout"}
                >
                  {copied === "rollout" ? <Check className="h-4 w-4" /> : <ClipboardCopy className="h-4 w-4" />}
                  {copied === "rollout" ? "Copied" : `Rollout (${windowsInterval}s)`}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void copyScript(60, "rollback")}
                  disabled={copying === "rollback"}
                >
                  {copied === "rollback" ? <Check className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                  {copied === "rollback" ? "Copied" : "Rollback (60s)"}
                </Button>
              </div>
              {copyError && (
                <div
                  className="th-onb-note th-onb-reveal"
                  style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
                  role="alert"
                >
                  <Info className="h-4 w-4" />
                  <span>{copyError}</span>
                </div>
              )}
              <div className="th-onb-note" style={{ "--onb-tone": "var(--th-text-faint)" } as CSSProperties}>
                <Info className="h-4 w-4" />
                <span>
                  <strong>GPO:</strong> Computer Configuration → Preferences → Windows Settings → Files (the config) and
                  a Scheduled Task (the script, as SYSTEM). Agents read the config again when their service restarts.
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── command center ───────────────────────────────────────────────── */}
      <div className="pt-2">
        <h2 className="text-[17px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
          Command Center
        </h2>
        <p className="text-[13px]" style={{ color: "var(--th-text-muted)" }}>
          Bulk commands for every device or a chosen target, delivered on the next heartbeat and run by agent 2.0 or
          later.
        </p>
      </div>
      <AgentCommandsPanel />
    </section>
  );
}
