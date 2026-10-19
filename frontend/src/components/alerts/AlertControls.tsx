import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { BellOff, Check, ChevronDown, Clock, Copy, SquareTerminal } from "lucide-react";

import type { ManualResolution } from "../../api/alerts";
import type { Alert, AlertPriority, CommandRisk } from "../../types/alert";
import { PRIORITY_HINT, PRIORITY_TONE, RISK_LABELS, RISK_TONE } from "../../types/alert";
import { openPowerShellWith } from "../../utils/powershellPrefill";
import { Button, Modal } from "../ui";

export function PriorityChip({ priority }: { priority?: AlertPriority | null }) {
  const p = (priority ?? 3) as AlertPriority;
  return (
    <span
      className="th-ac-prio"
      title={`P${p} · ${PRIORITY_HINT[p]}`}
      style={{ "--prio-tone": PRIORITY_TONE[p] } as CSSProperties}
    >
      P{p}
    </span>
  );
}

export function RiskChip({ risk }: { risk: CommandRisk }) {
  return (
    <span className="th-status-chip th-ac-risk" style={{ "--chip-tone": RISK_TONE[risk] } as CSSProperties}>
      <i />
      {RISK_LABELS[risk]}
    </span>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CommandBlock({
  script,
  risk,
  label,
  deviceId,
  deviceName,
  canRun,
}: {
  script: string;
  risk: CommandRisk;
  label?: string;
  deviceId?: number | null;
  deviceName?: string | null;
  canRun: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (!script.trim()) return null;
  return (
    <div className="th-ac-command">
      <div className="th-ac-command-head">
        {label && <span className="th-ac-command-label">{label}</span>}
        <RiskChip risk={risk} />
      </div>
      <pre>{script}</pre>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void copyText(script).then((ok) => {
              setCopied(ok);
              if (ok) window.setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        {canRun && deviceId != null && deviceId > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => openPowerShellWith(deviceId, deviceName || `Device #${deviceId}`, script)}
            title="Opens the administrator PowerShell (2FA, recorded) with this command typed in, not run"
          >
            <SquareTerminal className="h-3.5 w-3.5" />
            Open in PowerShell
          </Button>
        )}
      </div>
    </div>
  );
}

export type SnoozeChoice = { minutes?: number; until?: string; until_worse?: boolean };

function tomorrowAt8(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}

export const SNOOZE_OPTIONS: { label: string; value: () => SnoozeChoice }[] = [
  { label: "1 hour", value: () => ({ minutes: 60 }) },
  { label: "4 hours", value: () => ({ minutes: 240 }) },
  { label: "Until tomorrow 08:00", value: () => ({ until: tomorrowAt8() }) },
  { label: "7 days", value: () => ({ minutes: 7 * 24 * 60 }) },
  { label: "Until it gets worse", value: () => ({ until_worse: true }) },
];

export function SnoozeMenu({
  onSnooze,
  disabled,
  size = "sm",
  label = "Snooze",
}: {
  onSnooze: (choice: SnoozeChoice) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="th-ac-menu" ref={ref}>
      <Button
        size={size}
        variant="secondary"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Clock className="h-3.5 w-3.5" />
        {label}
        <ChevronDown className="h-3 w-3" />
      </Button>
      {open && (
        <div className="th-ac-menu-list" role="menu">
          {SNOOZE_OPTIONS.map((option) => (
            <button
              key={option.label}
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onSnooze(option.value());
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const RESOLUTIONS: { id: ManualResolution; label: string; hint: string }[] = [
  { id: "fixed", label: "Fixed", hint: "The cause was found and fixed. If it comes back, it reopens counted." },
  {
    id: "false_positive",
    label: "False alarm",
    hint: "Nothing was wrong. Stays closed for a day; add a mute rule if the rule is wrong.",
  },
  {
    id: "expected",
    label: "Expected",
    hint: "Known and accepted (planned work, a busy server). Stays closed for a day.",
  },
  { id: "duplicate", label: "Duplicate", hint: "Another alert covers the same problem." },
];

export function ResolveModal({
  count,
  onClose,
  onResolve,
}: {
  count: number;
  onClose: () => void;
  onResolve: (resolution: ManualResolution, note: string) => Promise<void> | void;
}) {
  const [resolution, setResolution] = useState<ManualResolution>("fixed");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={count === 1 ? "Resolve alert" : `Resolve ${count} alerts`}
      icon={Check}
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              setBusy(true);
              try {
                await onResolve(resolution, note);
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            {busy ? "Resolving…" : "Resolve"}
          </Button>
        </>
      }
    >
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-[13px] th-text-muted">Why is it closed?</legend>
        {RESOLUTIONS.map((r) => (
          <label key={r.id} className="th-ac-radio" data-checked={resolution === r.id}>
            <input
              type="radio"
              name="resolution"
              value={r.id}
              checked={resolution === r.id}
              onChange={() => setResolution(r.id)}
            />
            <span>
              <b>{r.label}</b>
              <small>{r.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="mt-3 grid gap-1 text-[13px]">
        <span className="th-text-muted">Note (optional)</span>
        <textarea
          id="alert-resolve-note"
          className="th-input min-h-[64px]"
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What was done"
        />
      </label>
    </Modal>
  );
}

export function MuteModal({
  alert,
  onClose,
  onMute,
}: {
  alert: Alert;
  onClose: () => void;
  onMute: (body: {
    device_id?: number | null;
    client_id?: number | null;
    kind?: string | null;
    fingerprint?: string | null;
    days?: number | null;
    reason: string;
  }) => Promise<void> | void;
}) {
  const [where, setWhere] = useState<"device" | "client" | "all">("device");
  const [what, setWhat] = useState<"issue" | "kind">(alert.fingerprint?.startsWith("evt:") ? "issue" : "kind");
  const [days, setDays] = useState<number | null>(30);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const deviceName = alert.device_name || `Device #${alert.device_id}`;
  return (
    <Modal
      title="Mute rule"
      subtitle="Matching alerts stop opening until the rule ends or is removed."
      icon={BellOff}
      tone="warning"
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || reason.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                await onMute({
                  device_id: where === "device" ? alert.device_id : null,
                  client_id: where === "client" ? (alert.client_id ?? null) : null,
                  kind: alert.kind,
                  fingerprint: what === "issue" && alert.fingerprint ? alert.fingerprint : null,
                  days,
                  reason: reason.trim(),
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Muting…" : "Mute"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-[13px]">
        <label className="grid gap-1">
          <span className="th-text-muted">Where</span>
          <select
            id="mute-where"
            className="th-input"
            value={where}
            onChange={(e) => setWhere(e.target.value as typeof where)}
          >
            <option value="device">Only {deviceName}</option>
            {alert.client_id != null && (
              <option value="client">Every device of {alert.client_name || "this client"}</option>
            )}
            <option value="all">Every device</option>
          </select>
        </label>
        {alert.fingerprint && (
          <label className="grid gap-1">
            <span className="th-text-muted">What</span>
            <select
              id="mute-what"
              className="th-input"
              value={what}
              onChange={(e) => setWhat(e.target.value as typeof what)}
            >
              <option value="issue">Only “{alert.title || alert.kind}”</option>
              <option value="kind">Every alert of this type</option>
            </select>
          </label>
        )}
        <label className="grid gap-1">
          <span className="th-text-muted">For</span>
          <select
            id="mute-days"
            className="th-input"
            value={days ?? 0}
            onChange={(e) => setDays(Number(e.target.value) || null)}
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={0}>Until removed</option>
          </select>
        </label>
        <label className="grid gap-1">
          <span className="th-text-muted">Reason (required, shown to everyone)</span>
          <input
            id="mute-reason"
            className="th-input"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Rendering PC, always busy at night"
          />
        </label>
        <p className="th-text-muted">Open alerts that match close now, marked “Muted”.</p>
      </div>
    </Modal>
  );
}
