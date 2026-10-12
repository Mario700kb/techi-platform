import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Eye, EyeOff, History, Info, Play, RefreshCw, Shield, Terminal, X } from "lucide-react";
import {
  ADMIN_ONLY_BULK_COMMANDS,
  BatchProgressResponse,
  BatchSummary,
  BULK_COMMAND_CATEGORIES,
  BULK_COMMAND_DESCRIPTIONS,
  BULK_COMMAND_LABELS,
  BULK_COMMAND_TYPES,
  BulkCommandType,
  COMMAND_STATUS_LABELS,
  DESTRUCTIVE_BULK_COMMANDS,
  OWNER_ONLY_BULK_COMMANDS,
  TWO_STEP_CONFIRM_COMMANDS,
  cancelBatch,
  getBatchProgress,
  getCommandHistory,
  sendBulkCommand,
} from "../api/agentCommands";
import { AgentPackage, getAgentPackages } from "../api/agentPackages";
import { Client, DeviceGroup, getClients, getGroups } from "../api/clients";
import { useAuth } from "../auth/AuthContext";
import { usePlatformFeatures } from "../hooks/usePlatformFeatures";
import { useAppData } from "../contexts/AppDataContext";
import { formatCount } from "../utils/number";
import { formatLocalDateTime, timeAgo } from "../utils/time";
import { Button, EmptyState, Modal, SelectField } from "./ui";
import { CardHead } from "./ui/PanelCard";

const POLL_INTERVAL = 3000;

// ── small helpers ──────────────────────────────────────────────────────── //

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div
      className="th-onb-meter !h-1.5 !w-full"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <i
        className="transition-[width] duration-500"
        style={{ width: `${percent}%`, "--meter-tone": "var(--th-accent)" } as React.CSSProperties}
      />
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  queued: "var(--th-status-warning)",
  delivered: "var(--th-status-warning)",
  executing: "var(--th-status-info)",
  completed: "var(--th-status-online)",
  failed: "var(--th-status-critical)",
  timeout: "var(--th-text-faint)",
  cancelled: "var(--th-text-faint)",
};

/** Pure UI derivation from existing batch count fields — no new business logic. */
function batchOverallStatus(b: { finished: boolean; failed: number; timeout: number }): {
  label: string;
  tone: string;
} {
  if (!b.finished) return { label: "Running", tone: "var(--th-status-info)" };
  if (b.failed > 0) return { label: `Failed (${b.failed})`, tone: "var(--th-status-critical)" };
  if (b.timeout > 0) return { label: `Timeout (${b.timeout})`, tone: "var(--th-text-faint)" };
  return { label: "Completed", tone: "var(--th-status-online)" };
}

function StatusChip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className="th-status-chip" style={{ "--chip-tone": tone } as React.CSSProperties}>
      <i />
      {children}
    </span>
  );
}

const inputCls = "w-full rounded-lg border px-3";
const inputStyle = {} as React.CSSProperties;

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1.5 block text-[12px] font-medium" style={{ color: "var(--th-text-secondary)" }}>
      {children}
    </span>
  );
}

function Note({ tone, icon: Icon = Info, children }: { tone: string; icon?: typeof Info; children: React.ReactNode }) {
  return (
    <div className="th-onb-note" style={{ "--onb-tone": tone } as React.CSSProperties}>
      <Icon className="h-4 w-4" />
      <span>{children}</span>
    </div>
  );
}

const InfoNote = ({ children }: { children: React.ReactNode }) => <Note tone="var(--th-status-info)">{children}</Note>;
const WarnNote = ({ children }: { children: React.ReactNode }) => (
  <Note tone="var(--th-status-warning)" icon={AlertTriangle}>
    {children}
  </Note>
);

// ── Confirm modal ──────────────────────────────────────────────────────── //

interface ConfirmModalProps {
  commandType: BulkCommandType;
  targetLabel: string;
  target: "all" | "online" | "client" | "group" | "devices" | "outdated_agents";
  deviceCount: number | null;
  twoStep: boolean;
  sending: boolean;
  error?: string | null;
  scriptPreview?: string;
  selfUpdatePackage?: AgentPackage | null;
  onConfirm: () => void;
  onClose: () => void;
}

function ConfirmModal({
  commandType,
  targetLabel,
  target,
  deviceCount,
  twoStep,
  sending,
  error,
  scriptPreview,
  selfUpdatePackage,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [confirmInput, setConfirmInput] = useState("");

  const isAllDevices = target === "all";
  const isSelfUpdate = commandType === "self_update";
  const expectedText = deviceCount !== null ? String(deviceCount) : "";
  // Require a real, known device count before allowing the type-to-confirm
  // step to pass — previously an empty expectedText (unknown count) made an
  // empty input trivially match, defeating the confirmation.
  const canConfirm = !twoStep || step === 1 || (expectedText !== "" && confirmInput === expectedText);

  function submitConfirm(e?: React.FormEvent) {
    e?.preventDefault();
    if (!sending && canConfirm) onConfirm();
  }

  const danger = { "--onb-tone": "var(--th-status-critical)" } as React.CSSProperties;

  return (
    <Modal
      title={isSelfUpdate ? "Update agent" : twoStep && step === 2 ? "Confirm once more" : "Confirm bulk action"}
      subtitle={
        <>
          <strong style={{ color: "var(--th-text-primary)" }}>{BULK_COMMAND_LABELS[commandType]}</strong> →{" "}
          {targetLabel}
          {deviceCount !== null && !isAllDevices ? ` (${deviceCount} device${deviceCount !== 1 ? "s" : ""})` : ""}
        </>
      }
      icon={AlertTriangle}
      tone="danger"
      size="sm"
      busy={sending}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={sending} data-autofocus>
            Cancel
          </Button>
          {twoStep && step === 1 ? (
            <Button type="button" variant="danger" onClick={() => setStep(2)}>
              Continue
            </Button>
          ) : (
            <Button type="submit" form="bulk-confirm-form" variant="danger" disabled={sending || !canConfirm}>
              {sending ? "Sending…" : isSelfUpdate ? "Confirm update" : "Confirm and send"}
            </Button>
          )}
        </>
      }
    >
      <form id="bulk-confirm-form" onSubmit={submitConfirm} className="flex flex-col gap-4">
        {isSelfUpdate && (
          <>
            <div className="th-onb-note" style={danger}>
              <AlertTriangle className="h-4 w-4" />
              <span>
                The agent restarts during the update and the PC may be offline for about 30 seconds. Remote Support is{" "}
                <strong>not affected</strong>.
              </span>
            </div>
            {selfUpdatePackage && (
              <dl className="th-onb-meta">
                <div>
                  <dt>Target version</dt>
                  <dd className="tabular-nums">{selfUpdatePackage.version}</dd>
                </div>
                <div>
                  <dt>SHA-256</dt>
                  <dd className="font-mono !text-[12px]">
                    {selfUpdatePackage.sha256 ? `${selfUpdatePackage.sha256.slice(0, 12)}…` : "—"}
                  </dd>
                </div>
              </dl>
            )}
          </>
        )}

        {isAllDevices && (
          <div className="th-onb-alldevices">
            <span className="tabular-nums">{deviceCount ?? "?"}</span>
            <small>This goes to every device</small>
          </div>
        )}

        {scriptPreview && (
          <div className="th-onb-field">
            Script preview
            <pre className="th-onb-code max-h-32 overflow-y-auto whitespace-pre-wrap p-3">{scriptPreview}</pre>
          </div>
        )}

        {step === 1 && (
          <div className="th-onb-note" style={danger}>
            <AlertTriangle className="h-4 w-4" />
            <span>
              This is sent to every targeted device and <strong>cannot be undone</strong>.
            </span>
          </div>
        )}

        {twoStep && step === 2 && (
          <label className="th-onb-field th-onb-reveal">
            <span>
              Type <strong style={{ color: "var(--th-text-primary)" }}>{expectedText}</strong>, the device count, to
              confirm
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={expectedText}
              data-autofocus
            />
          </label>
        )}

        {error && (
          <div className="th-onb-note th-onb-reveal" style={danger} role="alert">
            <AlertTriangle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        )}
      </form>
    </Modal>
  );
}

// ── Full output modal ──────────────────────────────────────────────────── //

interface OutputModalProps {
  hostname: string;
  output: string | null;
  error: string | null;
  onClose: () => void;
}

function OutputModal({ hostname, output, error, onClose }: OutputModalProps) {
  return (
    <Modal
      title={hostname}
      subtitle="Command output"
      icon={Terminal}
      tone={error ? "danger" : "accent"}
      size="lg"
      onClose={onClose}
      footer={
        <Button type="button" variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {output && (
        <div className="th-onb-field">
          Output
          <pre className="th-onb-code max-h-[50vh] overflow-auto whitespace-pre-wrap p-3">{output}</pre>
        </div>
      )}
      {error && (
        <div className="th-onb-field">
          <span style={{ color: "var(--th-status-critical)" }}>Error</span>
          <pre
            className="th-onb-code max-h-[40vh] overflow-auto whitespace-pre-wrap p-3"
            style={{ color: "var(--th-status-critical)" }}
          >
            {error}
          </pre>
        </div>
      )}
      {!output && !error && <p className="th-onb-hint">No output captured.</p>}
    </Modal>
  );
}

// ── Payload fields per command type ───────────────────────────────────── //

interface PayloadEditorProps {
  commandType: BulkCommandType;
  payload: Record<string, string>;
  onChange: (p: Record<string, string>) => void;
}

function PayloadEditor({ commandType, payload, onChange }: PayloadEditorProps) {
  const [showPwd, setShowPwd] = useState(false);

  const set = (k: string, v: string) => onChange({ ...payload, [k]: v });

  if (commandType === "set_remote_password") {
    return (
      <div className="space-y-3">
        <div>
          <FieldLabel>New Password</FieldLabel>
          <div className="relative">
            <input
              type={showPwd ? "text" : "password"}
              value={payload["password"] ?? ""}
              onChange={(e) => set("password", e.target.value)}
              placeholder="Enter new remote password"
              className={inputCls + " pr-9"}
              style={inputStyle}
            />
            <button
              type="button"
              onClick={() => setShowPwd((v) => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2"
              style={{ color: "var(--th-text-muted)" }}
              aria-label={showPwd ? "Hide password" : "Show password"}
            >
              {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div>
          <FieldLabel>Confirm Password</FieldLabel>
          <input
            type={showPwd ? "text" : "password"}
            value={payload["confirm"] ?? ""}
            onChange={(e) => set("confirm", e.target.value)}
            placeholder="Repeat password"
            className={inputCls}
            style={{
              ...inputStyle,
              borderColor:
                payload["confirm"] && payload["password"] !== payload["confirm"]
                  ? "color-mix(in srgb, var(--th-status-critical) 60%, transparent)"
                  : (inputStyle as Record<string, string>)["borderColor"],
            }}
          />
          {payload["confirm"] && payload["password"] !== payload["confirm"] && (
            <p className="mt-1 text-[12px]" style={{ color: "var(--th-status-critical)" }}>
              Passwords do not match
            </p>
          )}
        </div>
        <WarnNote>Password will be set on all targeted devices via next heartbeat.</WarnNote>
      </div>
    );
  }

  if (commandType === "change_heartbeat_interval") {
    return (
      <div className="space-y-2">
        <FieldLabel>Interval (seconds) — min 60, max 3600</FieldLabel>
        <input
          type="number"
          min={60}
          max={3600}
          value={payload["seconds"] ?? "120"}
          onChange={(e) => set("seconds", e.target.value)}
          className={inputCls}
          style={{ ...inputStyle, maxWidth: "8rem" }}
        />
        <InfoNote>
          Applies live on the next heartbeat — no agent restart required. Value is not persisted in config.json; backend
          re-sends it on every heartbeat.
        </InfoNote>
      </div>
    );
  }

  if (commandType === "reboot_pc") {
    return (
      <div className="space-y-2">
        <FieldLabel>Delay before reboot (seconds)</FieldLabel>
        <input
          type="number"
          min={0}
          max={3600}
          value={payload["delay_seconds"] ?? "60"}
          onChange={(e) => set("delay_seconds", e.target.value)}
          className={inputCls}
          style={{ ...inputStyle, maxWidth: "8rem" }}
        />
        <WarnNote>
          This will reboot the physical device. The device will be offline during restart. Ensure no critical work is
          running before sending.
        </WarnNote>
      </div>
    );
  }

  if (commandType === "run_powershell") {
    return (
      <div className="space-y-3">
        <div>
          <FieldLabel>PowerShell Script</FieldLabel>
          <textarea
            rows={5}
            placeholder={"# Script runs as SYSTEM on each device\nWrite-Host 'Hello from TECHI'"}
            value={payload["script"] ?? ""}
            onChange={(e) => set("script", e.target.value)}
            className={inputCls}
            style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace" }}
          />
        </div>
        <div>
          <FieldLabel>Script Timeout (seconds)</FieldLabel>
          <input
            type="number"
            min={5}
            max={300}
            value={payload["timeout_seconds"] ?? "30"}
            onChange={(e) => set("timeout_seconds", e.target.value)}
            className={inputCls}
            style={{ ...inputStyle, maxWidth: "8rem" }}
          />
        </div>
        <Note tone="var(--th-status-critical)" icon={Shield}>
          Runs as <strong>SYSTEM</strong> on every targeted device and needs the owner role. Output is captured and
          shown in the batch progress.
        </Note>
      </div>
    );
  }

  if (commandType === "run_command") {
    return (
      <div className="space-y-3">
        <div>
          <FieldLabel>Execution Engine</FieldLabel>
          <SelectField
            value={payload["engine"] ?? "bash"}
            onChange={(e) => set("engine", e.target.value)}
            className={inputCls}
            style={{ ...inputStyle, maxWidth: "12rem" }}
          >
            <option value="bash">Bash</option>
            <option value="sh">sh</option>
            <option value="busybox">BusyBox</option>
            <option value="python3">Python 3</option>
          </SelectField>
          <p className="th-onb-hint mt-1">Linux defaults to Bash; other platforms resolve through their adapter.</p>
        </div>
        <div>
          <FieldLabel>Command / Script</FieldLabel>
          <textarea
            rows={5}
            placeholder={"# Runs on Linux targets\nsystemctl status 3cxpbx"}
            value={payload["command"] ?? ""}
            onChange={(e) => set("command", e.target.value)}
            className={inputCls}
            style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace" }}
          />
        </div>
        <Note tone="var(--th-accent)" icon={Shield}>
          Runs on Linux devices through the chosen engine; Windows targets use Run PowerShell. Needs the admin role.
        </Note>
      </div>
    );
  }

  if (commandType === "register_protocol") {
    return (
      <InfoNote>
        Registers the <code className="font-mono">techiremotesupport://</code> URL scheme in the Windows Registry on
        each device. No payload required — the path is derived from the installed TECHI Remote Support location.
      </InfoNote>
    );
  }

  if (commandType === "self_update") {
    return (
      <InfoNote>
        Download URL, version and SHA256 come from the active package in Agent Packages — nothing to fill in by hand.
      </InfoNote>
    );
  }

  return null;
}

// ── main component ─────────────────────────────────────────────────────── //

export default function AgentCommandsPanel() {
  const { user } = useAuth();
  const { fleetOverview } = useAppData();
  const platformFeatures = usePlatformFeatures();
  const isAdmin = user?.role === "admin" || user?.role === "owner";
  const isOwner = user?.role === "owner";

  // Send form
  const [commandType, setCommandType] = useState<BulkCommandType>("ping");
  const [target, setTarget] = useState<"all" | "online" | "client" | "group" | "devices" | "outdated_agents">("online");
  const [clientId, setClientId] = useState<number | null>(null);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [deviceIdsInput, setDeviceIdsInput] = useState("");
  const [timeoutSecs, setTimeoutSecs] = useState(30);
  const [payload, setPayload] = useState<Record<string, string>>({});

  // Clients / groups
  const [clients, setClients] = useState<Client[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);

  // Send state
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Active batch
  const [activeBatch, setActiveBatch] = useState<BatchProgressResponse | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // History
  const [history, setHistory] = useState<BatchSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [cancelling, setCancelling] = useState(false);
  const [outputModal, setOutputModal] = useState<{
    hostname: string;
    output: string | null;
    error: string | null;
  } | null>(null);

  // Active windows-amd64 package — shown in the self_update confirm modal
  // (Version aktual / SHA256). Lazy-loaded only when that command is selected.
  const [selfUpdatePackage, setSelfUpdatePackage] = useState<AgentPackage | null>(null);

  useEffect(() => {
    getClients()
      .then(setClients)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (clientId) {
      getGroups(clientId)
        .then(setGroups)
        .catch(() => setGroups([]));
    } else {
      setGroups([]);
      setGroupId(null);
    }
  }, [clientId]);

  useEffect(() => {
    if (commandType !== "self_update") return;
    getAgentPackages()
      .then((packages) => {
        const active = packages.find(
          (p) => p.is_active && p.platform === "windows-amd64" && p.file_type === "agent_binary",
        );
        setSelfUpdatePackage(active ?? null);
      })
      .catch(() => setSelfUpdatePackage(null));
  }, [commandType]);

  useEffect(() => {
    setPayload({});
    // Sensible default timeouts per command
    const defaults: Partial<Record<BulkCommandType, number>> = {
      ping: 15,
      restart_agent: 60,
      restart_device: 60,
      reboot_pc: 180,
      collect_inventory: 60,
      sync_rustdesk: 60,
      restart_rustdesk: 30,
      set_remote_password: 300,
      change_heartbeat_interval: 20,
      run_powershell: 60,
      run_command: 60,
      register_protocol: 20,
      self_update: 180,
    };
    setTimeoutSecs(defaults[commandType] ?? 30);
  }, [commandType]);

  // Poll active batch
  const startPolling = useCallback((batchId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const progress = await getBatchProgress(batchId);
        setActiveBatch(progress);
        if (progress.finished) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
        }
      } catch {
        clearInterval(pollRef.current!);
        pollRef.current = null;
      }
    }, POLL_INTERVAL);
  }, []);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  function buildPayload(): Record<string, unknown> {
    if (commandType === "set_remote_password") {
      return { password: payload["password"] ?? "" };
    }
    if (commandType === "change_heartbeat_interval") {
      return { seconds: parseInt(payload["seconds"] ?? "120", 10) };
    }
    if (commandType === "reboot_pc") {
      return { delay_seconds: parseInt(payload["delay_seconds"] ?? "60", 10) };
    }
    if (commandType === "run_powershell") {
      return {
        script: payload["script"] ?? "",
        timeout_seconds: parseInt(payload["timeout_seconds"] ?? "30", 10),
      };
    }
    if (commandType === "run_command") {
      return {
        command: payload["command"] ?? "",
        engine: payload["engine"] ?? "bash",
      };
    }
    return {};
  }

  function isFormValid(): boolean {
    if (target === "client" && !clientId) return false;
    if (target === "group" && !groupId) return false;
    if (target === "devices" && !deviceIdsInput.trim()) return false;
    if (commandType === "set_remote_password") {
      if (!payload["password"]) return false;
      if (payload["password"] !== payload["confirm"]) return false;
    }
    if (commandType === "run_powershell" && !payload["script"]) return false;
    if (commandType === "run_command" && !payload["command"]) return false;
    if (OWNER_ONLY_BULK_COMMANDS.has(commandType) && !isOwner) return false;
    if (ADMIN_ONLY_BULK_COMMANDS.has(commandType) && !isAdmin) return false;
    return true;
  }

  async function handleSend() {
    setSendError(null);
    setSending(true);
    try {
      const deviceIds = deviceIdsInput
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));

      const resolvedTarget = target;

      const result = await sendBulkCommand({
        command_type: commandType,
        payload: buildPayload(),
        target: resolvedTarget,
        client_id: resolvedTarget === "client" ? (clientId ?? undefined) : undefined,
        group_id: resolvedTarget === "group" ? (groupId ?? undefined) : undefined,
        device_ids: resolvedTarget === "devices" ? deviceIds : undefined,
        timeout_seconds: timeoutSecs,
      });

      const progress = await getBatchProgress(result.batch_id);
      setActiveBatch(progress);
      await loadHistory();
      if (!progress.finished) startPolling(result.batch_id);
      setConfirmOpen(false);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send the command");
    } finally {
      setSending(false);
    }
  }

  async function handleCancel() {
    if (!activeBatch) return;
    setCancelling(true);
    try {
      await cancelBatch(activeBatch.batch_id);
      const progress = await getBatchProgress(activeBatch.batch_id);
      setActiveBatch(progress);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch (err) {
      setSendError(err instanceof Error ? `Could not cancel the batch: ${err.message}` : "Could not cancel the batch");
    } finally {
      setCancelling(false);
    }
  }

  async function loadHistory() {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setHistory(await getCommandHistory(20));
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Could not load the command history");
    } finally {
      setHistoryLoading(false);
    }
  }

  // History is visible by default now — load it once on mount instead of on accordion expand.
  useEffect(() => {
    void loadHistory();
  }, []);

  async function loadBatchFromHistory(batchId: string) {
    try {
      const progress = await getBatchProgress(batchId);
      setActiveBatch(progress);
      if (!progress.finished) startPolling(batchId);
    } catch (err) {
      setHistoryError(err instanceof Error ? `Could not open the batch: ${err.message}` : "Could not open the batch");
    }
  }

  const needsConfirm = DESTRUCTIVE_BULK_COMMANDS.has(commandType);
  const needsTwoStep = TWO_STEP_CONFIRM_COMMANDS.has(commandType);

  const targetLabel =
    target === "all"
      ? "All devices"
      : target === "online"
        ? "Online devices"
        : target === "outdated_agents"
          ? "Devices needing agent update"
          : target === "client"
            ? (clients.find((c) => c.id === clientId)?.name ?? `Client #${clientId}`)
            : target === "group"
              ? (groups.find((g) => g.id === groupId)?.name ?? `Group #${groupId}`)
              : `${deviceIdsInput || "…"} (device IDs)`;

  // Best-effort device count shown in the confirm modal, before anything is
  // sent — uses fleetOverview already fetched by AppDataContext, no new
  // network calls. "group" has no precomputed count available client-side
  // without a new endpoint (out of scope for this UI-only change).
  const deviceCount =
    target === "all"
      ? (fleetOverview?.stats.total ?? null)
      : target === "online"
        ? (fleetOverview?.stats.online ?? null)
        : target === "outdated_agents"
          ? (fleetOverview?.agents_outdated ?? null)
          : target === "client"
            ? clientId != null
              ? (fleetOverview?.tree_counts.by_client[String(clientId)] ?? null)
              : null
            : target === "devices"
              ? deviceIdsInput
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean).length || null
              : null;
  const finalStatus = activeBatch ? batchOverallStatus(activeBatch) : null;

  // Which commands this user can see
  const visibleCommands = BULK_COMMAND_TYPES.filter((t) => {
    // Platform Expansion: run_command (Linux) only when FEATURE_LINUX is on, so
    // the flag-off Command Center is identical to today.
    if (t === "run_command" && !platformFeatures.FEATURE_LINUX) return false;
    // The server sends the platform interval on every heartbeat and the agent
    // applies it after any action, so a per-device interval change is undone
    // within one cycle. The interval policy above is the only real control.
    if (t === "change_heartbeat_interval") return false;
    if (OWNER_ONLY_BULK_COMMANDS.has(t)) return isOwner;
    if (ADMIN_ONLY_BULK_COMMANDS.has(t)) return isAdmin;
    return true;
  });

  return (
    <>
      {/* ── Confirm modal ──────────────────────────────────────────── */}
      {confirmOpen && (
        <ConfirmModal
          commandType={commandType}
          targetLabel={targetLabel}
          target={target}
          deviceCount={deviceCount}
          twoStep={needsTwoStep}
          sending={sending}
          error={sendError}
          scriptPreview={commandType === "run_powershell" ? payload["script"] : undefined}
          selfUpdatePackage={commandType === "self_update" ? selfUpdatePackage : undefined}
          onConfirm={handleSend}
          onClose={() => {
            if (!sending) setConfirmOpen(false);
          }}
        />
      )}

      {/* ── Full output modal ─────────────────────────────────────── */}
      {outputModal && (
        <OutputModal
          hostname={outputModal.hostname}
          output={outputModal.output}
          error={outputModal.error}
          onClose={() => setOutputModal(null)}
        />
      )}

      <div className="grid items-stretch gap-4 xl:grid-cols-2">
        {/* ── Send command ──────────────────────────────────────────── */}
        <div className="th-onb-card th-onb-enter" style={{ "--i": 7 } as React.CSSProperties}>
          <CardHead
            icon={Terminal}
            tone="var(--th-accent)"
            title="Send command"
            subtitle={BULK_COMMAND_DESCRIPTIONS[commandType]}
          />
          <div className="th-onb-body flex-1">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="th-onb-field">
                Command
                <SelectField
                  value={commandType}
                  onChange={(e) => setCommandType(e.target.value as BulkCommandType)}
                  className={inputCls}
                  style={inputStyle}
                >
                  {BULK_COMMAND_CATEGORIES.map((cat) => {
                    const opts = cat.commands.filter((t) => visibleCommands.includes(t));
                    if (opts.length === 0) return null;
                    return (
                      <optgroup key={cat.label} label={cat.label}>
                        {opts.map((t) => (
                          <option key={t} value={t}>
                            {BULK_COMMAND_LABELS[t]}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </SelectField>
              </label>
              <label className="th-onb-field">
                Target
                <SelectField
                  value={target}
                  onChange={(e) => setTarget(e.target.value as typeof target)}
                  className={inputCls}
                  style={inputStyle}
                >
                  <option value="all">All devices</option>
                  <option value="online">Online devices</option>
                  <option value="outdated_agents">Devices needing agent update</option>
                  <option value="client">By client</option>
                  <option value="group">By group</option>
                  <option value="devices">Specific device IDs</option>
                </SelectField>
              </label>
            </div>

            {(target === "client" || target === "group") && (
              <div className="grid gap-4 sm:grid-cols-2 th-onb-reveal">
                <label className="th-onb-field">
                  Client
                  <SelectField
                    value={clientId ?? ""}
                    onChange={(e) => setClientId(e.target.value ? parseInt(e.target.value, 10) : null)}
                    className={inputCls}
                    style={inputStyle}
                  >
                    <option value="">Select client…</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </SelectField>
                </label>
                {target === "group" && (
                  <label className="th-onb-field">
                    Group
                    <SelectField
                      value={groupId ?? ""}
                      onChange={(e) => setGroupId(e.target.value ? parseInt(e.target.value, 10) : null)}
                      disabled={!clientId || groups.length === 0}
                      className={inputCls}
                      style={inputStyle}
                    >
                      <option value="">Select group…</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </SelectField>
                  </label>
                )}
              </div>
            )}

            {target === "devices" && (
              <label className="th-onb-field th-onb-reveal">
                Device IDs, comma-separated
                <input
                  type="text"
                  placeholder="1, 2, 3, 42"
                  value={deviceIdsInput}
                  onChange={(e) => setDeviceIdsInput(e.target.value)}
                  className={`${inputCls} font-mono`}
                />
              </label>
            )}

            {target === "outdated_agents" && (
              <InfoNote>
                Only active devices whose agent version or binary hash differs from the active package.
              </InfoNote>
            )}

            <PayloadEditor commandType={commandType} payload={payload} onChange={setPayload} />

            {!["ping", "collect_inventory", "register_protocol"].includes(commandType) && (
              <label className="th-onb-field">
                Timeout
                <span className="th-policy-input">
                  <input
                    type="number"
                    min={10}
                    max={600}
                    value={timeoutSecs}
                    onChange={(e) => setTimeoutSecs(parseInt(e.target.value, 10))}
                    aria-label="Command timeout in seconds"
                  />
                  <span>s</span>
                </span>
              </label>
            )}

            {OWNER_ONLY_BULK_COMMANDS.has(commandType) && !isOwner && (
              <WarnNote>
                This command needs the <strong>owner</strong> role.
              </WarnNote>
            )}
            {!OWNER_ONLY_BULK_COMMANDS.has(commandType) && ADMIN_ONLY_BULK_COMMANDS.has(commandType) && !isAdmin && (
              <WarnNote>
                This command needs the <strong>admin</strong> or owner role.
              </WarnNote>
            )}
            {sendError && !confirmOpen && (
              <Note tone="var(--th-status-critical)" icon={AlertTriangle}>
                {sendError}
              </Note>
            )}
          </div>
          <div className="th-onb-foot flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              {needsConfirm ? "Asks for confirmation before sending" : "Sent immediately"}
              {deviceCount !== null && ` · about ${formatCount(deviceCount)} device${deviceCount === 1 ? "" : "s"}`}
            </span>
            <Button
              onClick={() => {
                setSendError(null);
                if (needsConfirm) setConfirmOpen(true);
                else void handleSend();
              }}
              disabled={sending || !isFormValid()}
            >
              <Play className="h-4 w-4" />
              {sending ? "Sending…" : `Send to ${target === "all" ? "all devices" : targetLabel}`}
            </Button>
          </div>
        </div>

        {/* ── Batch progress ────────────────────────────────────────── */}
        <div className="th-onb-card th-onb-enter" style={{ "--i": 8 } as React.CSSProperties}>
          <CardHead
            icon={RefreshCw}
            tone={activeBatch ? (finalStatus?.tone ?? "var(--th-accent)") : "var(--th-text-faint)"}
            title="Batch progress"
            subtitle={
              activeBatch
                ? `${BULK_COMMAND_LABELS[activeBatch.command_type as BulkCommandType] ?? activeBatch.command_type} · ${formatCount(activeBatch.total)} device${activeBatch.total === 1 ? "" : "s"} · ${activeBatch.batch_id.slice(0, 8)}`
                : "Send a command, or open one from the history"
            }
            aside={
              activeBatch && (
                <div className="flex items-center gap-2">
                  {!activeBatch.finished && (
                    <Button size="sm" variant="secondary" onClick={() => void handleCancel()} disabled={cancelling}>
                      <X className="h-3.5 w-3.5" />
                      Cancel queued
                    </Button>
                  )}
                  <button
                    type="button"
                    className="th-onb-action"
                    onClick={() => setActiveBatch(null)}
                    aria-label="Close batch"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )
            }
          />
          {activeBatch ? (
            <div className="th-onb-body flex-1 th-onb-reveal">
              <div className="flex flex-col gap-2">
                <ProgressBar percent={activeBatch.percent} />
                <div
                  className="flex items-center justify-between text-[12px] tabular-nums"
                  style={{ color: "var(--th-text-muted)" }}
                >
                  <span>
                    {formatCount(activeBatch.completed)} of {formatCount(activeBatch.total)} completed
                  </span>
                  <span className="flex items-center gap-2">
                    {activeBatch.percent}%
                    {finalStatus && <StatusChip tone={finalStatus.tone}>{finalStatus.label}</StatusChip>}
                  </span>
                </div>
              </div>
              <dl className="th-onb-meta !grid-cols-3 sm:!grid-cols-6">
                {(["queued", "delivered", "executing", "completed", "failed", "timeout"] as const).map((st) => (
                  <div key={st}>
                    <dt>{COMMAND_STATUS_LABELS[st as keyof typeof COMMAND_STATUS_LABELS] ?? st}</dt>
                    <dd
                      className="tabular-nums !text-[16px]"
                      style={{ color: activeBatch[st] ? STATUS_TONE[st] : "var(--th-text-faint)" }}
                    >
                      {formatCount(activeBatch[st])}
                    </dd>
                  </div>
                ))}
              </dl>
              <ul className="th-batch-list">
                {activeBatch.devices.map((d) => (
                  <li key={d.device_id}>
                    <span
                      className="th-onb-dot !h-2 !w-2"
                      style={{ "--swatch": STATUS_TONE[d.status] ?? "var(--th-text-faint)" } as React.CSSProperties}
                    />
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[12px]"
                      style={{ color: "var(--th-text-primary)" }}
                    >
                      {d.hostname ?? `#${d.device_id}`}
                    </span>
                    {(d.output || d.error) && (
                      <button
                        type="button"
                        className="th-onb-link max-w-[45%] truncate"
                        onClick={() =>
                          setOutputModal({
                            hostname: d.hostname ?? `#${d.device_id}`,
                            output: d.output,
                            error: d.error,
                          })
                        }
                        title="View full output"
                      >
                        <Eye className="h-3.5 w-3.5 flex-none" />
                        <span className="truncate">{d.output ?? d.error}</span>
                      </button>
                    )}
                    <span
                      className="flex-none text-[12px] font-medium"
                      style={{ color: STATUS_TONE[d.status] ?? "var(--th-text-muted)" }}
                    >
                      {COMMAND_STATUS_LABELS[d.status as keyof typeof COMMAND_STATUS_LABELS] ?? d.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="th-onb-empty">
              <EmptyState
                icon={<RefreshCw className="h-5 w-5" />}
                title="No batch selected"
                description="Per-device delivery, status and output appear here while a command runs."
              />
            </div>
          )}
        </div>
      </div>

      {/* ── History ───────────────────────────────────────────────────── */}
      <div className="th-alerts-card th-onb-tokens th-onb-enter" style={{ "--i": 9 } as React.CSSProperties}>
        <CardHead
          icon={History}
          tone="var(--th-accent)"
          title="Command history"
          subtitle={
            historyLoading && history.length === 0
              ? "Loading…"
              : `The last ${formatCount(history.length)} batches · open one for its per-device results`
          }
          aside={
            <Button size="sm" variant="secondary" onClick={() => void loadHistory()} disabled={historyLoading}>
              <RefreshCw className={`h-3.5 w-3.5 ${historyLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          }
        />
        {historyError && (
          <Note tone="var(--th-status-critical)" icon={AlertTriangle}>
            {historyError}
          </Note>
        )}
        {historyLoading && history.length === 0 ? (
          <div className="th-alerts-scroll" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.15 }} />
            ))}
          </div>
        ) : history.length === 0 ? (
          <EmptyState className="py-10" icon={<History className="h-5 w-5" />} title="No commands sent yet" />
        ) : (
          <div className="th-alerts-scroll th-table-scroll">
            <table className="th-alerts-table">
              <colgroup>
                <col className="w-[150px]" />
                <col />
                <col className="w-[18%]" />
                <col className="w-[150px]" />
                <col className="w-[150px]" />
              </colgroup>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Command</th>
                  <th>Target</th>
                  <th>Status</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {history.map((b, index) => {
                  const st = batchOverallStatus(b);
                  return (
                    <tr
                      key={b.batch_id}
                      className="th-alerts-row"
                      data-clickable="true"
                      data-selected={activeBatch?.batch_id === b.batch_id || undefined}
                      style={
                        {
                          "--row": index,
                          "--row-tone": b.failed > 0 ? "var(--th-status-critical)" : undefined,
                        } as React.CSSProperties
                      }
                      onClick={() => void loadBatchFromHistory(b.batch_id)}
                    >
                      <td>
                        <span className="th-alerts-primary">{timeAgo(b.created_at)}</span>
                        <span className="th-alerts-secondary tabular-nums">{formatLocalDateTime(b.created_at)}</span>
                      </td>
                      <td>
                        <span className="th-alerts-primary">
                          {BULK_COMMAND_LABELS[b.command_type as BulkCommandType] ?? b.command_type}
                        </span>
                      </td>
                      <td>
                        <span className="th-alerts-primary capitalize">{b.target.replace(/_/g, " ")}</span>
                        <span className="th-alerts-secondary">
                          {formatCount(b.total)} device{b.total === 1 ? "" : "s"}
                        </span>
                      </td>
                      <td>
                        <StatusChip tone={st.tone}>{st.label}</StatusChip>
                      </td>
                      <td>
                        <span className="th-alerts-primary">{b.created_by_name ?? "—"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
