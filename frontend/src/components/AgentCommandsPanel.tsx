import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Eye,
  EyeOff,
  History,
  Info,
  Play,
  RefreshCw,
  Shield,
  Terminal,
  X,
} from "lucide-react";
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
  commandStatusColor,
  commandStatusDot,
  getBatchProgress,
  getCommandHistory,
  sendBulkCommand,
} from "../api/agentCommands";
import { AgentPackage, getAgentPackages } from "../api/agentPackages";
import { Client, DeviceGroup, getClients, getGroups } from "../api/clients";
import { useAuth } from "../auth/AuthContext";
import { useAppData } from "../contexts/AppDataContext";

const POLL_INTERVAL = 3000;

// ── small helpers ──────────────────────────────────────────────────────── //

function RelativeTime({ ts }: { ts: string }) {
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return <span>{diff}s ago</span>;
  if (diff < 3600) return <span>{Math.floor(diff / 60)}m ago</span>;
  return <span>{Math.floor(diff / 3600)}h ago</span>;
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--th-bg-shell)" }}>
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${percent}%`, background: "var(--th-accent-orange, #ff553f)" }}
      />
    </div>
  );
}

function StatusPill({ status, count }: { status: string; count: number }) {
  const colors: Record<string, string> = {
    queued: "text-amber-300", delivered: "text-amber-400",
    executing: "text-sky-400", completed: "text-emerald-400",
    failed: "text-red-400", timeout: "text-slate-500",
  };
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={`text-lg font-bold tabular-nums ${colors[status] ?? "text-slate-400"}`}>{count}</span>
      <span className="text-xs capitalize" style={{ color: "var(--th-text-muted)" }}>
        {COMMAND_STATUS_LABELS[status as keyof typeof COMMAND_STATUS_LABELS] ?? status}
      </span>
    </div>
  );
}

/** Pure UI derivation from existing batch count fields — no new business logic. */
function batchOverallStatus(b: { finished: boolean; failed: number; timeout: number }): { label: string; className: string } {
  if (!b.finished) return { label: "Running", className: "text-sky-400" };
  if (b.failed > 0) return { label: `Failed (${b.failed})`, className: "text-red-400" };
  if (b.timeout > 0) return { label: `Timeout (${b.timeout})`, className: "text-slate-500" };
  return { label: "Completed", className: "text-emerald-400" };
}

const inputCls =
  "w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50";
const inputStyle = {
  background: "var(--th-bg-input, var(--th-bg-shell))",
  borderColor: "var(--th-border-subtle)",
  color: "var(--th-text-primary)",
} as React.CSSProperties;

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>
      {children}
    </label>
  );
}

function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md px-3 py-2 text-xs" style={{ background: "var(--th-bg-shell)", color: "var(--th-text-muted)" }}>
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function WarnNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md px-3 py-2 text-xs text-amber-400" style={{ background: "rgba(245,158,11,0.08)" }}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

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
  commandType, targetLabel, target, deviceCount, twoStep, sending, error, scriptPreview, selfUpdatePackage, onConfirm, onClose,
}: ConfirmModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [confirmInput, setConfirmInput] = useState("");

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.65)" }}
      onClick={onClose}
    >
      <form
        className="w-full max-w-sm rounded-xl p-5 space-y-4 shadow-2xl"
        style={{
          background: "var(--th-bg-drawer, var(--th-bg-shell))",
          border: isAllDevices ? "2px solid rgba(239,68,68,0.6)" : "1px solid var(--th-border-drawer-section)",
        }}
        onSubmit={submitConfirm}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10">
            <AlertTriangle className="h-4 w-4 text-red-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold" style={{ color: "var(--th-text-primary)" }}>
              {isSelfUpdate ? "Përditëso Agjentin" : twoStep && step === 2 ? "Confirm once more" : "Confirm bulk action"}
            </p>
            <p className="mt-0.5 text-xs" style={{ color: "var(--th-text-muted)" }}>
              <strong className="text-amber-400">{BULK_COMMAND_LABELS[commandType]}</strong>{" "}
              → <strong style={{ color: "var(--th-text-primary)" }}>{targetLabel}</strong>
              {deviceCount !== null && !isAllDevices && (
                <span> ({deviceCount} device{deviceCount !== 1 ? "s" : ""})</span>
              )}
            </p>
          </div>
          <button type="button" onClick={onClose} className="mt-0.5 rounded p-1 hover:opacity-70" style={{ color: "var(--th-text-muted)" }}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* self_update — agent restart warning + active package info */}
        {isSelfUpdate && (
          <>
            <div
              className="rounded-lg px-3 py-2 text-xs text-red-400"
              style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)" }}
            >
              Agjenti do të riniset gjatë update-it. PC mund të dalë offline ~30 sekonda.
              TECHI Remote Support <strong>nuk preket</strong>.
            </div>
            {selfUpdatePackage && (
              <div className="space-y-1 rounded-md px-3 py-2 text-xs" style={{ background: "var(--th-bg-shell)" }}>
                <p style={{ color: "var(--th-text-muted)" }}>
                  Version aktual → <strong style={{ color: "var(--th-text-primary)" }}>{selfUpdatePackage.version}</strong>
                </p>
                {selfUpdatePackage.sha256 && (
                  <p style={{ color: "var(--th-text-muted)" }}>
                    SHA256 → <span className="font-mono" style={{ color: "var(--th-text-primary)" }}>{selfUpdatePackage.sha256.slice(0, 8)}…</span>
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {/* All-devices emphasis */}
        {isAllDevices && (
          <div
            className="rounded-lg px-3 py-2.5 text-center"
            style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.4)" }}
          >
            <p className="text-2xl font-bold text-red-400">{deviceCount ?? "?"}</p>
            <p className="text-xs font-medium text-red-300">Kjo do dërgohet te të gjitha pajisjet</p>
          </div>
        )}

        {/* run_powershell script preview */}
        {scriptPreview && (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>
              Script Preview
            </p>
            <pre
              className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md p-2.5 text-xs font-mono"
              style={{ background: "var(--th-bg-shell)", color: "var(--th-text-primary)" }}
            >
              {scriptPreview}
            </pre>
          </div>
        )}

        {/* Step 1 warning */}
        {step === 1 && (
          <div
            className="rounded-lg px-3 py-2 text-xs"
            style={{ background: "rgba(239,68,68,0.08)", color: "var(--th-text-muted)" }}
          >
            This action will be sent to all targeted devices and <strong className="text-red-400">cannot be undone</strong>.
          </div>
        )}

        {/* Step 2 – type device count to confirm */}
        {twoStep && step === 2 && (
          <div className="space-y-2">
            <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              Type <strong style={{ color: "var(--th-text-primary)" }}>{expectedText}</strong> (device count) to confirm:
            </p>
            <input
              autoFocus
              type="text"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={expectedText}
              className={inputCls}
              style={inputStyle}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConfirm) submitConfirm(e);
              }}
            />
          </div>
        )}

        {error && (
          <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400">
            {error}
          </p>
        )}

        {/* Buttons */}
        <div className="flex gap-2">
          {twoStep && step === 1 ? (
            <button
              type="button"
              onClick={() => setStep(2)}
              className="flex-1 rounded-md py-1.5 text-sm font-semibold text-white"
              style={{ background: "#ef4444" }}
            >
              Continue →
            </button>
          ) : (
            <button
              type="submit"
              disabled={sending || !canConfirm}
              className="flex-1 rounded-md py-1.5 text-sm font-semibold text-white disabled:opacity-40"
              style={{ background: "#ef4444" }}
            >
              {sending ? "Sending…" : isSelfUpdate ? "Konfirmo përditësimin" : "Konfirmo dërgimin"}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-1.5 text-sm font-semibold"
            style={{ background: "var(--th-bg-shell)", border: "1px solid var(--th-border-subtle)", color: "var(--th-text-primary)" }}
          >
            Anulo
          </button>
        </div>
      </form>
    </div>
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
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.65)" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col space-y-3 rounded-xl p-5 shadow-2xl"
        style={{
          background: "var(--th-bg-drawer, var(--th-bg-shell))",
          border: "1px solid var(--th-border-drawer-section)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono font-semibold" style={{ color: "var(--th-text-primary)" }}>{hostname}</p>
          <button type="button" onClick={onClose} className="rounded p-1 hover:opacity-70" style={{ color: "var(--th-text-muted)" }}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto">
          {output && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>
                Output
              </p>
              <pre
                className="whitespace-pre-wrap rounded-md p-3 text-xs font-mono"
                style={{ background: "var(--th-bg-shell)", color: "var(--th-text-primary)" }}
              >
                {output}
              </pre>
            </div>
          )}
          {error && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-red-400">Error</p>
              <pre
                className="whitespace-pre-wrap rounded-md p-3 text-xs font-mono text-red-400"
                style={{ background: "rgba(239,68,68,0.08)" }}
              >
                {error}
              </pre>
            </div>
          )}
          {!output && !error && (
            <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>No output captured.</p>
          )}
        </div>
      </div>
    </div>
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
              className="absolute right-2.5 top-1/2 -translate-y-1/2 opacity-60 hover:opacity-100"
              style={{ color: "var(--th-text-muted)" }}
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
                  ? "rgba(239,68,68,0.6)"
                  : (inputStyle as Record<string, string>)["borderColor"],
            }}
          />
          {payload["confirm"] && payload["password"] !== payload["confirm"] && (
            <p className="mt-1 text-xs text-red-400">Passwords do not match</p>
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
          Applies live on the next heartbeat — no agent restart required. Value is not persisted in
          config.json; backend re-sends it on every heartbeat.
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
          This will reboot the physical device. The device will be offline during restart. Ensure
          no critical work is running before sending.
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
        <div
          className="flex items-start gap-2 rounded-md px-3 py-2 text-xs text-red-400"
          style={{ background: "rgba(239,68,68,0.08)" }}
        >
          <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Script runs as <strong>SYSTEM</strong> on every targeted device. Owner role required.
            Output is captured and returned in batch progress.
          </span>
        </div>
      </div>
    );
  }

  if (commandType === "register_protocol") {
    return (
      <InfoNote>
        Registers the <code className="rounded bg-white/10 px-1">techiremotesupport://</code> URL
        scheme in the Windows Registry on each device. No payload required — the path is derived
        from the installed TECHI Remote Support location.
      </InfoNote>
    );
  }

  if (commandType === "self_update") {
    return (
      <InfoNote>
        Download URL, version dhe SHA256 merren automatikisht nga paketa aktive te Agent Packages —
        nuk ka fusha për t'u plotësuar me dorë.
      </InfoNote>
    );
  }

  return null;
}

// ── main component ─────────────────────────────────────────────────────── //

export default function AgentCommandsPanel() {
  const { user } = useAuth();
  const { fleetOverview } = useAppData();
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

  const [cancelling, setCancelling] = useState(false);
  const [outputModal, setOutputModal] = useState<{ hostname: string; output: string | null; error: string | null } | null>(null);

  // Active windows-amd64 package — shown in the self_update confirm modal
  // (Version aktual / SHA256). Lazy-loaded only when that command is selected.
  const [selfUpdatePackage, setSelfUpdatePackage] = useState<AgentPackage | null>(null);

  useEffect(() => {
    getClients().then(setClients).catch(() => {});
  }, []);

  useEffect(() => {
    if (clientId) {
      getGroups(clientId).then(setGroups).catch(() => setGroups([]));
    } else {
      setGroups([]);
      setGroupId(null);
    }
  }, [clientId]);

  useEffect(() => {
    if (commandType !== "self_update") return;
    getAgentPackages()
      .then((packages) => {
        const active = packages.find((p) => p.is_active && p.platform === "windows-amd64" && p.file_type === "agent_binary");
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

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

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
      setSendError(String(err));
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
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    } catch {
    } finally {
      setCancelling(false);
    }
  }

  async function loadHistory() {
    setHistoryLoading(true);
    try {
      setHistory(await getCommandHistory(20));
    } catch {
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
    } catch {}
  }

  const needsConfirm = DESTRUCTIVE_BULK_COMMANDS.has(commandType);
  const needsTwoStep = TWO_STEP_CONFIRM_COMMANDS.has(commandType);

  const targetLabel =
    target === "all" ? "All devices"
    : target === "online" ? "Online devices"
    : target === "outdated_agents" ? "Devices needing agent update"
    : target === "client" ? (clients.find((c) => c.id === clientId)?.name ?? `Client #${clientId}`)
    : target === "group" ? (groups.find((g) => g.id === groupId)?.name ?? `Group #${groupId}`)
    : `${deviceIdsInput || "…"} (device IDs)`;

  // Best-effort device count shown in the confirm modal, before anything is
  // sent — uses fleetOverview already fetched by AppDataContext, no new
  // network calls. "group" has no precomputed count available client-side
  // without a new endpoint (out of scope for this UI-only change).
  const deviceCount =
    target === "all" ? (fleetOverview?.stats.total ?? null)
    : target === "online" ? (fleetOverview?.stats.online ?? null)
    : target === "outdated_agents" ? (fleetOverview?.agents_outdated ?? null)
    : target === "client" ? (clientId != null ? fleetOverview?.tree_counts.by_client[String(clientId)] ?? null : null)
    : target === "devices" ? (deviceIdsInput.split(",").map((s) => s.trim()).filter(Boolean).length || null)
    : null;
  const finalStatus = activeBatch ? batchOverallStatus(activeBatch) : null;

  // Which commands this user can see
  const visibleCommands = BULK_COMMAND_TYPES.filter((t) => {
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
          onClose={() => { if (!sending) setConfirmOpen(false); }}
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

      <div className="grid gap-5 items-start xl:grid-cols-2">
        <div className="space-y-5">
        {/* ── Send Command panel ────────────────────────────────────── */}
        <div
          className="rounded-xl p-5 space-y-4"
          style={{
            background: "var(--th-bg-drawer-section)",
            border: "1px solid var(--th-border-drawer-section)",
          }}
        >
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4" style={{ color: "var(--th-accent-orange, #ff553f)" }} />
            <p className="text-xs font-bold uppercase tracking-widest" style={{ color: "var(--th-text-muted)" }}>
              Send Command
            </p>
          </div>

          {/* Command + Target row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel>Command</FieldLabel>
              <select
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
                        <option key={t} value={t}>{BULK_COMMAND_LABELS[t]}</option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
              <p className="mt-1.5 text-xs" style={{ color: "var(--th-text-muted)" }}>
                {BULK_COMMAND_DESCRIPTIONS[commandType]}
              </p>
            </div>
            <div>
              <FieldLabel>Target</FieldLabel>
              <select
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
              </select>
            </div>
          </div>

          {/* Target detail inputs */}
          {target === "client" && (
            <div>
              <FieldLabel>Client</FieldLabel>
              <select
                value={clientId ?? ""}
                onChange={(e) => setClientId(e.target.value ? parseInt(e.target.value, 10) : null)}
                className={inputCls}
                style={inputStyle}
              >
                <option value="">Select client…</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}

          {target === "group" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>Client</FieldLabel>
                <select
                  value={clientId ?? ""}
                  onChange={(e) => setClientId(e.target.value ? parseInt(e.target.value, 10) : null)}
                  className={inputCls}
                  style={inputStyle}
                >
                  <option value="">Select client…</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <FieldLabel>Group</FieldLabel>
                <select
                  value={groupId ?? ""}
                  onChange={(e) => setGroupId(e.target.value ? parseInt(e.target.value, 10) : null)}
                  disabled={!clientId || groups.length === 0}
                  className={inputCls + " disabled:opacity-40"}
                  style={inputStyle}
                >
                  <option value="">Select group…</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
            </div>
          )}

          {target === "devices" && (
            <div>
              <FieldLabel>Device IDs (comma-separated)</FieldLabel>
              <input
                type="text"
                placeholder="1, 2, 3, 42"
                value={deviceIdsInput}
                onChange={(e) => setDeviceIdsInput(e.target.value)}
                className={inputCls}
                style={{ ...inputStyle, fontFamily: "monospace" }}
              />
            </div>
          )}

          {/* Outdated agents target note */}
          {target === "outdated_agents" && (
            <InfoNote>
              Targets only active devices whose agent version or binary hash differs from the active package.
            </InfoNote>
          )}

          {/* Per-command payload fields */}
          <PayloadEditor commandType={commandType} payload={payload} onChange={setPayload} />

          {/* Command timeout (hidden for simple commands) */}
          {!["ping", "collect_inventory", "register_protocol"].includes(commandType) && (
            <div>
              <FieldLabel>Command Timeout (seconds)</FieldLabel>
              <input
                type="number"
                min={10}
                max={600}
                value={timeoutSecs}
                onChange={(e) => setTimeoutSecs(parseInt(e.target.value, 10))}
                className={inputCls}
                style={{ ...inputStyle, maxWidth: "8rem" }}
              />
            </div>
          )}

          {/* Permission warning */}
          {OWNER_ONLY_BULK_COMMANDS.has(commandType) && !isOwner && (
            <WarnNote>This command requires <strong>owner</strong> role.</WarnNote>
          )}
          {!OWNER_ONLY_BULK_COMMANDS.has(commandType) && ADMIN_ONLY_BULK_COMMANDS.has(commandType) && !isAdmin && (
            <WarnNote>This command requires <strong>admin</strong> or owner role.</WarnNote>
          )}

          {sendError && (
            <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400">
              {sendError}
            </p>
          )}

          <button
            type="button"
            onClick={() => { setSendError(null); needsConfirm ? setConfirmOpen(true) : handleSend(); }}
            disabled={sending || !isFormValid()}
            className="flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-semibold text-white transition disabled:opacity-40"
            style={{ background: "var(--th-accent-orange, #ff553f)" }}
          >
            <Play className="h-3.5 w-3.5" />
            {sending ? "Sending…" : `Send to ${target === "all" ? "all devices" : targetLabel}`}
          </button>
        </div>

        {/* ── Active Batch ──────────────────────────────────────────── */}
        {activeBatch && (
          <div
            className="rounded-xl p-5 space-y-4"
            style={{
              background: "var(--th-bg-drawer-section)",
              border: "1px solid var(--th-border-drawer-section)",
            }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RefreshCw
                  className={`h-4 w-4 ${!activeBatch.finished ? "animate-spin" : ""}`}
                  style={{ color: "var(--th-accent-orange, #ff553f)" }}
                />
                <p className="text-xs font-bold uppercase tracking-widest" style={{ color: "var(--th-text-muted)" }}>
                  Batch Progress
                </p>
              </div>
              <div className="flex items-center gap-2">
                {!activeBatch.finished && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    disabled={cancelling}
                    className="flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition disabled:opacity-40"
                    style={{ background: "var(--th-bg-shell)", border: "1px solid var(--th-border-subtle)", color: "var(--th-text-muted)" }}
                  >
                    <X className="h-3 w-3" />
                    Cancel queued
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setActiveBatch(null)}
                  className="rounded p-1 hover:opacity-70"
                  style={{ color: "var(--th-text-muted)" }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Meta */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
              <span className="font-semibold" style={{ color: "var(--th-text-primary)" }}>
                {BULK_COMMAND_LABELS[activeBatch.command_type as BulkCommandType] ?? activeBatch.command_type}
              </span>
              <span>{activeBatch.total} device{activeBatch.total !== 1 ? "s" : ""}</span>
              <span className="font-mono opacity-60">{activeBatch.batch_id.slice(0, 8)}…</span>
            </div>

            {/* Progress bar */}
            <div className="space-y-1.5">
              <ProgressBar percent={activeBatch.percent} />
              <div className="flex items-center justify-between text-xs font-mono" style={{ color: "var(--th-text-muted)" }}>
                <span>
                  {activeBatch.completed}/{activeBatch.total} completed
                  {activeBatch.failed > 0 && <span className="text-red-400"> · {activeBatch.failed} failed</span>}
                  {activeBatch.timeout > 0 && <span className="text-slate-500"> · {activeBatch.timeout} timeout</span>}
                </span>
                <span>{activeBatch.percent}%</span>
              </div>
            </div>

            {/* Counters */}
            <div className="grid grid-cols-6 gap-2 rounded-lg p-3" style={{ background: "var(--th-bg-shell)" }}>
              {(["queued", "delivered", "executing", "completed", "failed", "timeout"] as const).map((s) => (
                <StatusPill key={s} status={s} count={activeBatch[s]} />
              ))}
            </div>

            {/* Per-device list */}
            <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
              {activeBatch.devices.map((d) => (
                <div
                  key={d.device_id}
                  className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-xs"
                  style={{ background: "var(--th-bg-shell)" }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${commandStatusDot(d.status as Parameters<typeof commandStatusDot>[0])}`} />
                    <span className="truncate font-mono" style={{ color: "var(--th-text-primary)" }}>
                      {d.hostname ?? `#${d.device_id}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {(d.output || d.error) && (
                      <button
                        type="button"
                        onClick={() => setOutputModal({ hostname: d.hostname ?? `#${d.device_id}`, output: d.output, error: d.error })}
                        className="flex max-w-[160px] items-center gap-1 border-0 bg-transparent p-0 text-right hover:opacity-80"
                        style={{ color: "var(--th-text-muted)" }}
                        title="View full output"
                      >
                        <span className="truncate">{d.output ?? d.error}</span>
                        <Eye className="h-3 w-3 shrink-0" />
                      </button>
                    )}
                    <span className={`shrink-0 font-medium ${commandStatusColor(d.status as Parameters<typeof commandStatusColor>[0])}`}>
                      {COMMAND_STATUS_LABELS[d.status as keyof typeof COMMAND_STATUS_LABELS] ?? d.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {activeBatch.finished && finalStatus && (
              <p className={`text-center text-xs font-semibold ${finalStatus.className}`}>
                Batch {finalStatus.label === "Completed" ? "complete" : finalStatus.label.toLowerCase()}
              </p>
            )}
          </div>
        )}
        </div>

        {/* ── History ───────────────────────────────────────────────── */}
        <div
          className="rounded-xl overflow-hidden"
          style={{ background: "var(--th-bg-drawer-section)", border: "1px solid var(--th-border-drawer-section)" }}
        >
          <div className="flex items-center gap-2 px-5 py-3.5">
            <History className="h-4 w-4" style={{ color: "var(--th-accent-orange, #ff553f)" }} />
            <p className="text-xs font-bold uppercase tracking-widest" style={{ color: "var(--th-text-muted)" }}>
              Command History
            </p>
          </div>

          <div className="px-5 pb-4">
            {historyLoading ? (
              <p className="py-4 text-center text-xs" style={{ color: "var(--th-text-muted)" }}>Loading…</p>
            ) : history.length === 0 ? (
              <p className="py-4 text-center text-xs" style={{ color: "var(--th-text-muted)" }}>No command history yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ color: "var(--th-text-muted)" }}>
                      <th className="pb-2 pr-3 text-left font-semibold uppercase tracking-wide">Time</th>
                      <th className="pb-2 pr-3 text-left font-semibold uppercase tracking-wide">Command</th>
                      <th className="pb-2 pr-3 text-left font-semibold uppercase tracking-wide">Target</th>
                      <th className="pb-2 pr-3 text-left font-semibold uppercase tracking-wide">Status</th>
                      <th className="pb-2 text-left font-semibold uppercase tracking-wide">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((b) => {
                      const st = batchOverallStatus(b);
                      return (
                        <tr
                          key={b.batch_id}
                          onClick={() => loadBatchFromHistory(b.batch_id)}
                          className="cursor-pointer transition hover:opacity-80"
                          style={{ borderTop: "1px solid var(--th-border-subtle)" }}
                        >
                          <td className="whitespace-nowrap py-2 pr-3" style={{ color: "var(--th-text-muted)" }}>
                            <RelativeTime ts={b.created_at} />
                          </td>
                          <td className="py-2 pr-3 font-semibold" style={{ color: "var(--th-text-primary)" }}>
                            {BULK_COMMAND_LABELS[b.command_type as BulkCommandType] ?? b.command_type}
                          </td>
                          <td className="py-2 pr-3 capitalize" style={{ color: "var(--th-text-muted)" }}>
                            {b.target} · {b.total}
                          </td>
                          <td className={`py-2 pr-3 font-medium ${st.className}`}>{st.label}</td>
                          <td className="py-2" style={{ color: "var(--th-text-muted)" }}>{b.created_by_name ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
