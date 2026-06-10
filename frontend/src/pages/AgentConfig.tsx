import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ClipboardCopy, Info, RotateCcw, Save } from "lucide-react";
import {
  AgentConfig,
  getAgentConfig,
  getHeartbeatScript,
  putAgentConfig,
} from "../api/agentConfig";

type CopyTarget = "rollout" | "rollback" | null;

export default function AgentConfigPage() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [intervalInput, setIntervalInput] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copying, setCopying] = useState<CopyTarget>(null);
  const [copied, setCopied] = useState<CopyTarget>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoading(true);
    getAgentConfig()
      .then((cfg) => {
        setConfig(cfg);
        setIntervalInput(String(cfg.heartbeat_interval_seconds));
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    const val = parseInt(intervalInput, 10);
    if (isNaN(val) || val < 60 || val > 600) {
      setError("Heartbeat interval must be between 60 and 600 seconds.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await putAgentConfig({ heartbeat_interval_seconds: val });
      setConfig(updated);
      setIntervalInput(String(updated.heartbeat_interval_seconds));
      setSaved(true);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
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

  const currentInterval = config?.heartbeat_interval_seconds ?? 180;
  const dirty = config !== null && parseInt(intervalInput, 10) !== currentInterval;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      {/* Header */}
      <div>
        <h1
          className="mb-1 text-xl font-bold tracking-tight"
          style={{ color: "var(--th-text-primary)" }}
        >
          Agent Configuration
        </h1>
        <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>
          Platform-wide heartbeat policy. Changes take effect after agents are restarted with the
          rollout script.
        </p>
      </div>

      {/* Agent capability notice */}
      <div
        className="flex gap-3 rounded-lg p-4 text-sm"
        style={{
          background: "var(--th-bg-drawer-section)",
          border: "1px solid var(--th-border-drawer-section)",
        }}
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <div style={{ color: "var(--th-text-muted)" }}>
          <p className="mb-1 font-semibold text-amber-400">
            Automatic rollout not supported by current agent
          </p>
          <p>
            The installed TechiAgent MSI binary does not support the{" "}
            <code className="rounded bg-white/10 px-1 text-xs">apply_agent_config</code> remote
            action. Interval changes must be propagated manually via the PowerShell scripts below
            or through a GPO Scheduled Task.
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
          Heartbeat Policy
        </p>

        {loading ? (
          <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>Loading…</p>
        ) : (
          <div className="space-y-4">
            {/* Editable: heartbeat interval */}
            <div>
              <label
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide"
                style={{ color: "var(--th-text-muted)" }}
              >
                Heartbeat Interval (seconds)
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min={60}
                  max={600}
                  id="heartbeat-interval"
                  name="heartbeat-interval"
                  aria-label="Heartbeat interval in seconds"
                  value={intervalInput}
                  onChange={(e) => {
                    setIntervalInput(e.target.value);
                    setError(null);
                  }}
                  className="w-28 rounded-md border px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500/50"
                  style={{
                    background: "var(--th-bg-input, var(--th-bg-shell))",
                    borderColor: "var(--th-border-subtle)",
                    color: "var(--th-text-primary)",
                  }}
                />
                <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                  60 – 600 s &nbsp;·&nbsp; recommended: 180 s
                </span>
              </div>
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
              onClick={handleSave}
              disabled={saving || !dirty}
              className="flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-semibold transition disabled:opacity-40"
              style={{
                background: "var(--th-accent-orange, #ff553f)",
                color: "#fff",
              }}
            >
              {saved ? (
                <><Check className="h-3.5 w-3.5" /> Saved</>
              ) : saving ? (
                "Saving…"
              ) : (
                <><Save className="h-3.5 w-3.5" /> Save policy</>
              )}
            </button>
          </div>
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
  );
}
