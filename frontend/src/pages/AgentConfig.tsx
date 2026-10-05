import { useEffect, useRef, useState } from "react";
import { Check, ClipboardCopy, Info, RotateCcw, Save } from "lucide-react";
import {
  AgentConfig,
  getAgentConfig,
  getHeartbeatScript,
  putAgentConfig,
} from "../api/agentConfig";
import AgentCommandsPanel from "../components/AgentCommandsPanel";

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

export default function AgentConfigPage() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [heartbeatInputs, setHeartbeatInputs] = useState<Record<string, string>>({});
  const [inventoryInputs, setInventoryInputs] = useState<Record<string, string>>({});
  const [managedPasswordEnabled, setManagedPasswordEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [remoteSaving, setRemoteSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [remoteSaved, setRemoteSaved] = useState(false);
  const [copying, setCopying] = useState<CopyTarget>(null);
  const [copied, setCopied] = useState<CopyTarget>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoading(true);
    getAgentConfig()
      .then((cfg) => {
        setConfig(cfg);
        setHeartbeatInputs(Object.fromEntries(PLATFORM_ROWS.map(([id]) => [id, String(cfg.platform_heartbeat_intervals[id] ?? cfg.heartbeat_interval_seconds)])));
        setInventoryInputs(Object.fromEntries(PLATFORM_ROWS.map(([id]) => [id, String(cfg.platform_inventory_intervals[id] ?? 1800)])));
        setManagedPasswordEnabled(cfg.remote_support_managed_password_enabled);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  async function handleSaveHeartbeat() {
    const heartbeat: Record<string, number> = {};
    const inventory: Record<string, number> = {};
    for (const [id, label] of PLATFORM_ROWS) {
      const hb = parseInt(heartbeatInputs[id], 10);
      const inv = parseInt(inventoryInputs[id], 10);
      if (isNaN(hb) || hb < 60 || hb > 600) {
        setError(`${label} heartbeat must be between 60 and 600 seconds.`);
        return;
      }
      if (isNaN(inv) || inv < 300 || inv > 86400) {
        setError(`${label} inventory must be between 300 and 86400 seconds.`);
        return;
      }
      heartbeat[id] = hb;
      inventory[id] = inv;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await putAgentConfig({
        platform_heartbeat_intervals: heartbeat,
        platform_inventory_intervals: inventory,
      });
      setConfig(updated);
      setHeartbeatInputs(Object.fromEntries(PLATFORM_ROWS.map(([id]) => [id, String(updated.platform_heartbeat_intervals[id] ?? updated.heartbeat_interval_seconds)])));
      setInventoryInputs(Object.fromEntries(PLATFORM_ROWS.map(([id]) => [id, String(updated.platform_inventory_intervals[id] ?? 1800)])));
      setManagedPasswordEnabled(updated.remote_support_managed_password_enabled);
      setSaved(true);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveRemoteSupport() {
    setRemoteSaving(true);
    setRemoteError(null);
    try {
      const updated = await putAgentConfig({
        remote_support_managed_password_enabled: managedPasswordEnabled,
      });
      setConfig(updated);
      setHeartbeatInputs(Object.fromEntries(PLATFORM_ROWS.map(([id]) => [id, String(updated.platform_heartbeat_intervals[id] ?? updated.heartbeat_interval_seconds)])));
      setInventoryInputs(Object.fromEntries(PLATFORM_ROWS.map(([id]) => [id, String(updated.platform_inventory_intervals[id] ?? 1800)])));
      setManagedPasswordEnabled(updated.remote_support_managed_password_enabled);
      setRemoteSaved(true);
      if (remoteSaveTimer.current) clearTimeout(remoteSaveTimer.current);
      remoteSaveTimer.current = setTimeout(() => setRemoteSaved(false), 2500);
    } catch (err) {
      setRemoteError(String(err));
    } finally {
      setRemoteSaving(false);
    }
  }

  async function copyScript(seconds: number, target: CopyTarget) {
    setCopying(target);
    setError(null);
    try {
      const script = await getHeartbeatScript(seconds);
      await navigator.clipboard.writeText(script);
      setCopied(target);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 2500);
    } catch (err) {
      setError(String(err));
    } finally {
      setCopying(null);
    }
  }

  const currentInterval = config?.platform_heartbeat_intervals?.windows ?? config?.heartbeat_interval_seconds ?? 300;
  const heartbeatDirty = config !== null && PLATFORM_ROWS.some(([id]) => {
    const hb = config.platform_heartbeat_intervals[id] ?? config.heartbeat_interval_seconds;
    const inv = config.platform_inventory_intervals[id] ?? 1800;
    return heartbeatInputs[id] !== String(hb) || inventoryInputs[id] !== String(inv);
  });
  const remoteSupportDirty = config !== null && managedPasswordEnabled !== config.remote_support_managed_password_enabled;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="mx-auto max-w-2xl space-y-6">
      {/* Header */}
      <div>
        <h1
          className="mb-1 text-xl font-bold tracking-tight"
          style={{ color: "var(--th-text-primary)" }}
        >
          Agent Configuration
        </h1>
        <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>
          Platform-wide heartbeat policy and bulk command center.
        </p>
      </div>

      {/* How each column reaches the fleet.
          Heartbeat is served on every heartbeat response (agent.py get_heartbeat_interval →
          heartbeat_interval_seconds) and applied by the agent on the next cycle
          (main.go pendingIntervalChange → agent.go ticker.Reset), so it needs no push channel.
          Inventory is read only via get_inventory_interval("mikrotik") — the agent has no
          inventory-interval code at all, so the other rows are stored but never applied. */}
      <div
        className="flex gap-3 rounded-lg p-4 text-sm"
        style={{
          background: "var(--th-bg-drawer-section)",
          border: "1px solid var(--th-border-drawer-section)",
        }}
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
        <div style={{ color: "var(--th-text-muted)" }}>
          <p className="mb-1 font-semibold text-sky-400">How these settings reach the fleet</p>
          <p>
            <span style={{ color: "var(--th-text-primary)" }}>Heartbeat</span> applies
            automatically — the new interval is returned on the next heartbeat and takes effect
            within one cycle. No GPO or PowerShell needed; the scripts below are only for devices
            that are not checking in.
          </p>
          <p className="mt-2">
            <span style={{ color: "var(--th-text-primary)" }}>Inventory</span> is currently
            applied for RouterOS only. Values saved for the other platforms are stored but not yet
            honoured by the agent.
          </p>
        </div>
      </div>

      {/* Policy card */}
      <div
        className="rounded-xl p-5 space-y-5"
        style={{
          background: "var(--th-bg-drawer-section)",
          border: "1px solid var(--th-border-drawer-section)",
        }}
      >
        <p className="text-xs font-bold uppercase tracking-widest" style={{ color: "var(--th-text-muted)" }}>
          Heartbeat & Inventory Policy
        </p>

        {loading ? (
          <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>Loading…</p>
        ) : (
          <div className="space-y-4">
            <div className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--th-border-subtle)" }}>
              <div className="grid grid-cols-[1fr_112px_112px] gap-2 px-3 py-2 text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--th-text-muted)", background: "var(--th-bg-shell)" }}>
                <span>Platform</span>
                <span>Heartbeat</span>
                <span>Inventory</span>
              </div>
              {PLATFORM_ROWS.map(([id, label]) => (
                <div key={id} className="grid grid-cols-[1fr_112px_112px] items-center gap-2 border-t px-3 py-2" style={{ borderColor: "var(--th-border-subtle)" }}>
                  <span className="text-sm font-medium" style={{ color: "var(--th-text-primary)" }}>{label}</span>
                  <input
                    type="number"
                    min={60}
                    max={600}
                    aria-label={`${label} heartbeat interval`}
                    value={heartbeatInputs[id] ?? ""}
                    onChange={(e) => {
                      setHeartbeatInputs((prev) => ({ ...prev, [id]: e.target.value }));
                      setError(null);
                    }}
                    className="w-full rounded-md border px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500/50"
                    style={{ background: "var(--th-bg-input, var(--th-bg-shell))", borderColor: "var(--th-border-subtle)", color: "var(--th-text-primary)" }}
                  />
                  <input
                    type="number"
                    min={300}
                    max={86400}
                    aria-label={`${label} inventory interval`}
                    value={inventoryInputs[id] ?? ""}
                    onChange={(e) => {
                      setInventoryInputs((prev) => ({ ...prev, [id]: e.target.value }));
                      setError(null);
                    }}
                    className="w-full rounded-md border px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500/50"
                    style={{ background: "var(--th-bg-input, var(--th-bg-shell))", borderColor: "var(--th-border-subtle)", color: "var(--th-text-primary)" }}
                  />
                </div>
              ))}
            </div>

            {/* Read-only thresholds */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>
                  Online Threshold
                </p>
                <p className="text-sm font-medium text-emerald-400">
                  {config?.online_threshold_minutes ?? 6} min
                  <span className="ml-2 text-xs font-normal" style={{ color: "var(--th-text-muted)" }}>(read-only)</span>
                </p>
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>
                  Stale Threshold
                </p>
                <p className="text-sm font-medium text-amber-400">
                  {config?.stale_threshold_minutes ?? 25} min
                  <span className="ml-2 text-xs font-normal" style={{ color: "var(--th-text-muted)" }}>(read-only)</span>
                </p>
              </div>
            </div>

            {/* Error */}
            {error && (
              <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400">
                {error}
              </p>
            )}

            {/* Save button */}
            <button
              type="button"
              onClick={handleSaveHeartbeat}
              disabled={saving || !heartbeatDirty}
              className="flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-semibold transition disabled:opacity-40"
              style={{
                background: "var(--th-accent)",
                color: "#fff",
              }}
            >
              {saved ? (
                <><Check className="h-3.5 w-3.5" /> Saved</>
              ) : saving ? (
                "Saving…"
              ) : (
                <><Save className="h-3.5 w-3.5" /> Save interval policy</>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Remote Support card */}
      <div
        className="rounded-xl p-5 space-y-4"
        style={{
          background: "var(--th-bg-drawer-section)",
          border: "1px solid var(--th-border-drawer-section)",
        }}
      >
        <div>
          <p className="text-xs font-bold uppercase tracking-widest" style={{ color: "var(--th-text-muted)" }}>
            TECHI Remote Support
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
            Controls whether Connect links include the global managed password for direct sessions.
          </p>
        </div>

        {loading ? (
          <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>Loading…</p>
        ) : (
          <label
            className="flex cursor-pointer items-center justify-between gap-4 rounded-lg px-4 py-3"
            style={{
              background: "var(--th-bg-shell)",
              border: "1px solid var(--th-border-subtle)",
            }}
          >
            <span>
              <span className="block text-sm font-semibold" style={{ color: "var(--th-text-primary)" }}>
                Auto-connect with managed password
              </span>
              <span className="mt-0.5 block text-xs" style={{ color: "var(--th-text-muted)" }}>
                When enabled, Connect uses the global password; unmatched devices will still ask manually.
              </span>
            </span>
            <input
              type="checkbox"
              checked={managedPasswordEnabled}
              onChange={(e) => {
                setManagedPasswordEnabled(e.target.checked);
                setRemoteError(null);
              }}
              className="h-5 w-5 shrink-0 rounded border-white/15 accent-orange-500"
              aria-label="Auto-connect with managed password"
            />
          </label>
        )}

        {remoteError && (
          <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400">
            {remoteError}
          </p>
        )}

        {!loading && (
          <button
            type="button"
            onClick={handleSaveRemoteSupport}
            disabled={remoteSaving || !remoteSupportDirty}
            className="flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-semibold transition disabled:opacity-40"
            style={{
              background: "var(--th-accent)",
              color: "#fff",
            }}
          >
            {remoteSaved ? (
              <><Check className="h-3.5 w-3.5" /> Saved</>
            ) : remoteSaving ? (
              "Saving…"
            ) : (
              <><Save className="h-3.5 w-3.5" /> Save Remote Support</>
            )}
          </button>
        )}
      </div>

      {/* Rollout scripts card */}
      <div
        className="rounded-xl p-5 space-y-4"
        style={{
          background: "var(--th-bg-drawer-section)",
          border: "1px solid var(--th-border-drawer-section)",
        }}
      >
        <div>
          <p className="text-xs font-bold uppercase tracking-widest" style={{ color: "var(--th-text-muted)" }}>
            Rollout Scripts
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
            Generated PowerShell. Run as Administrator on each endpoint, or deploy via GPO
            Scheduled Task targeting the TECHI computers OU.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          {/* Rollout */}
          <button
            type="button"
            onClick={() => copyScript(currentInterval, "rollout")}
            disabled={copying === "rollout"}
            className="flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-semibold transition disabled:opacity-50"
            style={{
              background: "var(--th-bg-shell)",
              border: "1px solid var(--th-border-subtle)",
              color: "var(--th-text-primary)",
            }}
          >
            {copied === "rollout" ? (
              <><Check className="h-3.5 w-3.5 text-emerald-400" /> Copied rollout</>
            ) : (
              <><ClipboardCopy className="h-3.5 w-3.5" /> Copy rollout script ({currentInterval}s)</>
            )}
          </button>

          {/* Rollback */}
          <button
            type="button"
            onClick={() => copyScript(60, "rollback")}
            disabled={copying === "rollback"}
            className="flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-semibold transition disabled:opacity-50"
            style={{
              background: "var(--th-bg-shell)",
              border: "1px solid var(--th-border-subtle)",
              color: "var(--th-text-primary)",
            }}
          >
            {copied === "rollback" ? (
              <><Check className="h-3.5 w-3.5 text-emerald-400" /> Copied rollback</>
            ) : (
              <><RotateCcw className="h-3.5 w-3.5" /> Copy rollback script (60s)</>
            )}
          </button>
        </div>

        {/* GPO hint */}
        <div
          className="flex gap-2 rounded-md px-3 py-2 text-xs"
          style={{
            background: "var(--th-bg-shell)",
            color: "var(--th-text-muted)",
          }}
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <strong style={{ color: "var(--th-text-primary)" }}>GPO deployment: </strong>
            Computer Configuration → Preferences → Windows Settings → Files (deploy config) +
            Scheduled Task (run script as SYSTEM). Agents re-read the config on next service start.
          </span>
        </div>
      </div>
      </div>

      {/* Command Center */}
      <div>
        <h2
          className="mb-1 text-base font-bold tracking-tight"
          style={{ color: "var(--th-text-primary)" }}
        >
          Command Center
        </h2>
        <p className="mb-4 text-xs" style={{ color: "var(--th-text-muted)" }}>
          Send bulk commands to all devices or a specific target. Commands are delivered via the
          next heartbeat and executed by agent v2.0+.
        </p>
        <AgentCommandsPanel />
      </div>
    </div>
  );
}
