import type { CSSProperties, ReactNode } from "react";
import { Activity, Gauge, Info, Plus, Trash2 } from "lucide-react";

import { formatDuration, METRIC_LABEL, METRIC_UNIT } from "../../api/monitoring";
import type { MonitoringPolicy, MonitorMetric, MonitorSeverity } from "../../api/monitoring";
import { Button, Select } from "../ui";
import type { SelectOption } from "../ui";
import { CardHead } from "../ui/PanelCard";
import SaveFooter from "../ui/SaveFooter";
import { formatLocalDateTime } from "../../utils/time";
import ScopePicker from "./ScopePicker";
import {
  changeMetric,
  devicesWord,
  DraftProblems,
  LIMITS,
  METRICS,
  MonitorDraft,
  newMonitor,
  overriddenBy,
  PolicyDraft,
  ScopeNames,
  scopeWords,
  SERVER_METRICS,
  SEVERITIES,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  syncWords,
} from "./policyForm";

const tone = (value: string) => ({ "--onb-tone": value }) as CSSProperties;

const METRIC_OPTIONS: SelectOption<MonitorMetric>[] = METRICS.map((m) => ({
  value: m,
  label: METRIC_LABEL[m],
  hint: SERVER_METRICS.has(m) ? "Checked by the platform" : "Checked on the device",
}));
const OP_OPTIONS: SelectOption<">" | "<">[] = [
  { value: ">", label: ">", hint: "Above" },
  { value: "<", label: "<", hint: "Below" },
];
const SEVERITY_OPTIONS: SelectOption<MonitorSeverity>[] = SEVERITIES.map((s) => ({
  value: s,
  label: SEVERITY_LABEL[s],
}));

const COMPACT = "!h-[34px] w-full";
// Controls line up with the metric select when a row carries a second line.
const TOP: CSSProperties = { verticalAlign: "top" };

function Switch({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="th-onb-switch flex-none disabled:cursor-not-allowed disabled:opacity-60"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <i />
    </button>
  );
}

function UnitInput({
  value,
  unit,
  label,
  invalid,
  disabled,
  min,
  max,
  step,
  onChange,
  wide = false,
}: {
  value: string;
  unit: string;
  label: string;
  invalid?: boolean;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: string) => void;
  wide?: boolean;
}) {
  return (
    <label className={`th-policy-input ${wide ? "!max-w-none" : ""}`} data-invalid={invalid || undefined}>
      <input
        type="number"
        inputMode="decimal"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid || undefined}
        className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        onChange={(e) => onChange(e.target.value)}
      />
      {unit && <span>{unit.trim()}</span>}
    </label>
  );
}

function SeverityTag({ severity }: { severity: MonitorSeverity }) {
  return (
    <span className="th-team-state" style={tone(SEVERITY_TONE[severity])}>
      <i />
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

function SectionHead({ title, hint, aside }: { title: string; hint?: string; aside?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h3 className="th-onb-label">{title}</h3>
        {hint && <p className="th-onb-hint mt-1">{hint}</p>}
      </div>
      {aside}
    </div>
  );
}

/** The read-only words for a monitor's condition and duration. */
function conditionText(m: MonitorDraft): string {
  if (m.metric === "no_data") return "No uploads";
  return `${m.metric === "disk_forecast_days" ? "<" : m.op} ${m.threshold}${METRIC_UNIT[m.metric]}`;
}
function durationText(m: MonitorDraft): string {
  if (m.metric === "disk_forecast_days") return "—";
  return formatDuration(Math.round(Number(m.durationMin) * 60));
}

function MonitorRow({
  row,
  index,
  canManage,
  problems,
  overrides,
  onChange,
  onRemove,
}: {
  row: MonitorDraft;
  index: number;
  canManage: boolean;
  problems: DraftProblems["monitors"][number] | undefined;
  overrides: string[];
  onChange: (next: MonitorDraft) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const name = METRIC_LABEL[row.metric];
  const keyLine = (
    <span className="th-alerts-secondary font-mono text-[11px]">
      {row.key || "—"}
      {overrides.length > 0 && <span className="font-sans"> · replaces {overrides.join(", ")}</span>}
    </span>
  );

  if (!canManage) {
    return (
      <tr className="th-alerts-row" style={{ opacity: row.enabled ? 1 : 0.55 }}>
        <td>
          <span className="th-alerts-primary">{name}</span>
          {keyLine}
        </td>
        <td
          className={`text-[13px] ${row.metric === "no_data" ? "" : "font-mono"}`}
          style={{ color: "var(--th-text-secondary)" }}
        >
          {conditionText(row)}
        </td>
        <td className="text-[13px] tabular-nums" style={{ color: "var(--th-text-secondary)" }}>
          {durationText(row)}
        </td>
        <td>
          <SeverityTag severity={row.severity} />
        </td>
        <td>
          <Switch checked={row.enabled} label={`${name} monitor on`} disabled onChange={() => undefined} />
        </td>
      </tr>
    );
  }

  return (
    <tr className="th-alerts-row">
      <td style={TOP}>
        <Select
          value={row.metric}
          options={METRIC_OPTIONS}
          aria-label={`Monitor ${n} metric`}
          className={COMPACT}
          onChange={(metric) => onChange({ ...row, metric })}
        />
        <label className="mt-1.5 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--th-text-faint)" }}>
          Key
          <input
            value={row.key}
            maxLength={32}
            aria-label={`Monitor ${n} key`}
            aria-invalid={problems?.key ? true : undefined}
            onChange={(e) => onChange({ ...row, key: e.target.value.toLowerCase() })}
            className="!h-6 !min-h-0 w-[130px] rounded-md border !px-1.5 font-mono !text-[11px]"
            style={{
              borderColor: problems?.key
                ? "color-mix(in srgb, var(--th-status-critical) 60%, transparent)"
                : "var(--th-border-subtle)",
              background: "var(--th-bg-surface)",
            }}
          />
        </label>
        {overrides.length > 0 && (
          <span className="mt-1 block truncate text-[11px]" style={{ color: "var(--th-text-faint)" }}>
            Replaces {overrides.join(", ")}
          </span>
        )}
      </td>
      <td style={TOP}>
        {row.metric === "no_data" ? (
          <span className="flex h-[34px] items-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
            No uploads
          </span>
        ) : (
          <div className="flex items-center gap-1.5">
            {row.metric === "disk_forecast_days" ? (
              <span
                className="flex h-[34px] w-[64px] flex-none items-center justify-center font-mono text-[13px]"
                style={{ color: "var(--th-text-muted)" }}
                title="Full within"
              >
                &lt;
              </span>
            ) : (
              <div className="w-[64px] flex-none">
                <Select
                  value={row.op}
                  options={OP_OPTIONS}
                  aria-label={`Monitor ${n} condition`}
                  className={COMPACT}
                  onChange={(op) => onChange({ ...row, op })}
                />
              </div>
            )}
            <UnitInput
              value={row.threshold}
              unit={METRIC_UNIT[row.metric]}
              label={`Monitor ${n} threshold`}
              invalid={!!problems?.threshold}
              min={1}
              onChange={(threshold) => onChange({ ...row, threshold })}
              wide
            />
          </div>
        )}
      </td>
      <td style={TOP}>
        {row.metric === "disk_forecast_days" ? (
          <span className="flex h-[34px] items-center text-[13px]" style={{ color: "var(--th-text-faint)" }}>
            —
          </span>
        ) : (
          <UnitInput
            value={row.durationMin}
            unit="min"
            label={`Monitor ${n} duration`}
            invalid={!!problems?.duration}
            min={LIMITS.durationMin.min}
            max={LIMITS.durationMin.max}
            onChange={(durationMin) => onChange({ ...row, durationMin })}
            wide
          />
        )}
      </td>
      <td style={TOP}>
        <Select
          value={row.severity}
          options={SEVERITY_OPTIONS}
          aria-label={`Monitor ${n} severity`}
          className={COMPACT}
          style={{ color: SEVERITY_TONE[row.severity] }}
          onChange={(severity) => onChange({ ...row, severity })}
        />
      </td>
      <td style={TOP}>
        <div className="flex h-[34px] items-center">
          <Switch
            checked={row.enabled}
            label={`Monitor ${n} on`}
            onChange={(enabled) => onChange({ ...row, enabled })}
          />
        </div>
      </td>
      <td style={TOP}>
        <div className="flex h-[34px] items-center justify-end">
          <button
            type="button"
            className="th-onb-action"
            data-tone="danger"
            aria-label={`Remove monitor ${n}`}
            title="Remove monitor"
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

export default function PolicyEditor({
  policy,
  policies,
  names,
  draft,
  onDraft,
  problems,
  canManage,
  dirty,
  saving,
  saved,
  error,
  onSave,
  onDelete,
}: {
  policy: MonitoringPolicy;
  policies: MonitoringPolicy[];
  names: ScopeNames;
  draft: PolicyDraft;
  onDraft: (update: (draft: PolicyDraft) => PolicyDraft) => void;
  problems: DraftProblems;
  canManage: boolean;
  dirty: boolean;
  saving: boolean;
  saved: string | null;
  error: string | null;
  onSave: () => void;
  onDelete: () => void;
}) {
  const sync = syncWords(policy);
  const set = (patch: Partial<PolicyDraft>) => onDraft((d) => ({ ...d, ...patch }));
  const setRow = (rowId: number, next: MonitorDraft) =>
    onDraft((d) => {
      const taken = d.monitors.filter((m) => m.rowId !== rowId).map((m) => m.key);
      // A metric change picks a key that is free among the other rows.
      const prev = d.monitors.find((m) => m.rowId === rowId);
      const fixed = prev && prev.metric !== next.metric ? changeMetric(prev, next.metric, taken) : next;
      return { ...d, monitors: d.monitors.map((m) => (m.rowId === rowId ? fixed : m)) };
    });
  const addRow = () =>
    onDraft((d) => {
      const taken = d.monitors.map((m) => m.key);
      const metric = METRICS.find((m) => !d.monitors.some((row) => row.metric === m)) ?? "cpu";
      return { ...d, monitors: [...d.monitors, newMonitor(metric, taken)] };
    });
  const removeRow = (rowId: number) =>
    onDraft((d) => ({ ...d, monitors: d.monitors.filter((m) => m.rowId !== rowId) }));

  const nextVersion = policy.version + 1;
  const firstProblem = problems.list[0] ?? null;
  const updated = policy.updated_at
    ? `Updated ${formatLocalDateTime(policy.updated_at)}${policy.updated_by ? ` by ${policy.updated_by}` : ""}`
    : null;

  return (
    <div className="th-onb-card" aria-label={`Policy ${policy.name}`} role="region">
      <CardHead
        icon={Activity}
        tone="var(--th-accent)"
        title={policy.name}
        subtitle={`${scopeWords(policy, names)} · ${devicesWord(policy.devices)}`}
        aside={
          <div className="flex flex-none items-center gap-2">
            <span
              className="th-team-state rounded-full border px-2 py-0.5 tabular-nums"
              style={{
                ...tone(sync.current ? "var(--th-status-online)" : "var(--th-status-warning)"),
                borderColor: "color-mix(in srgb, var(--onb-tone) 30%, transparent)",
              }}
              title="Devices that report running this version (agent 2.1.29 or later)"
            >
              <i />
              {sync.text}
            </span>
            {canManage && policy.scope !== "default" && (
              <button
                type="button"
                className="th-onb-action"
                data-tone="danger"
                aria-label={`Delete policy ${policy.name}`}
                title="Delete policy"
                onClick={onDelete}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        }
      />

      <div className="th-onb-body">
        {/* ── details ─────────────────────────────────────────────────── */}
        <section className="th-onb-section" aria-label="Details">
          <SectionHead
            title="Details"
            aside={
              <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--th-text-secondary)" }}>
                <span aria-hidden>Policy on</span>
                <Switch
                  checked={draft.enabled}
                  label="Policy on"
                  disabled={!canManage}
                  onChange={(enabled) => set({ enabled })}
                />
              </div>
            }
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="th-onb-field">
              Name
              <input
                value={draft.name}
                maxLength={120}
                disabled={!canManage}
                aria-invalid={problems.name ? true : undefined}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <label className="th-onb-field">
              Description
              <input
                value={draft.description}
                maxLength={2000}
                disabled={!canManage}
                placeholder="What this policy is for"
                onChange={(e) => set({ description: e.target.value })}
              />
            </label>
          </div>
          <ScopePicker
            scope={draft.scope}
            value={draft.scopeValue}
            names={names}
            disabled={!canManage}
            invalid={!!problems.scopeValue}
            onChange={(scope, scopeValue) => set({ scope, scopeValue })}
          />
        </section>

        {/* ── monitors ────────────────────────────────────────────────── */}
        <section className="th-onb-section" aria-label="Monitors">
          <SectionHead
            title="Monitors"
            hint="Device monitors are checked every sample and alert live; the platform checks disk forecast and missing data."
            aside={
              canManage && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={addRow}
                  disabled={draft.monitors.length >= LIMITS.monitors}
                >
                  <Plus className="h-4 w-4" />
                  Add monitor
                </Button>
              )
            }
          />
          <div
            className="-mx-5 overflow-x-auto border-t"
            style={{ borderColor: "var(--th-border-subtle)" }}
            data-testid="monitor-table"
          >
            <table className={`th-alerts-table ${canManage ? "min-w-[790px]" : "min-w-[560px]"}`}>
              <colgroup>
                <col />
                <col className={canManage ? "w-[200px]" : "w-[130px]"} />
                <col className={canManage ? "w-[136px]" : "w-[90px]"} />
                <col className={canManage ? "w-[130px]" : "w-[110px]"} />
                <col className="w-[76px]" />
                {canManage && <col className="w-[52px]" />}
              </colgroup>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Condition</th>
                  <th>For</th>
                  <th>Severity</th>
                  <th>On</th>
                  {canManage && (
                    <th>
                      <span className="sr-only">Remove</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {draft.monitors.map((row, index) => (
                  <MonitorRow
                    key={row.rowId}
                    row={row}
                    index={index}
                    canManage={canManage}
                    problems={problems.monitors[row.rowId]}
                    overrides={overriddenBy(policy, policies, row.key)}
                    onChange={(next) => setRow(row.rowId, next)}
                    onRemove={() => removeRow(row.rowId)}
                  />
                ))}
                {draft.monitors.length === 0 && (
                  <tr>
                    <td colSpan={canManage ? 6 : 5} className="text-center text-[13px]">
                      <span style={{ color: "var(--th-text-muted)" }}>
                        {policy.scope === "default"
                          ? "No monitors: devices measure but never alert."
                          : "No monitors of its own: devices keep the broader policies' monitors."}
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── collection ─────────────────────────────────────────────── */}
        <section className="th-onb-section" aria-label="Collection">
          <SectionHead
            title="Collection"
            hint={
              policy.scope === "default"
                ? "How often devices measure and send. A more specific policy replaces these settings."
                : "These settings replace the broader policies' for the devices this policy covers."
            }
          />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(
              [
                ["sample", "Sample every", "s", LIMITS.sample, `${LIMITS.sample.min}–${LIMITS.sample.max} s`],
                [
                  "uploadMin",
                  "Upload every",
                  "min",
                  LIMITS.uploadMin,
                  `${LIMITS.uploadMin.min}–${LIMITS.uploadMin.max} min`,
                ],
                ["buffer", "Buffer on device", "MB", LIMITS.buffer, `${LIMITS.buffer.min}–${LIMITS.buffer.max} MB`],
                [
                  "keepDays",
                  "Keep unsent for",
                  "days",
                  LIMITS.keepDays,
                  `${LIMITS.keepDays.min}–${LIMITS.keepDays.max} days`,
                ],
              ] as const
            ).map(([field, label, unit, range, hint]) => (
              <div key={field} className="th-onb-field">
                <span>{label}</span>
                <UnitInput
                  value={draft[field]}
                  unit={unit}
                  label={label}
                  min={range.min}
                  max={range.max}
                  disabled={!canManage}
                  invalid={!!problems[field]}
                  onChange={(value) => set({ [field]: value } as Partial<PolicyDraft>)}
                  wide
                />
                <small className="text-[11px] font-normal" style={{ color: "var(--th-text-faint)" }}>
                  {hint}
                </small>
              </div>
            ))}
          </div>
          <div className="th-onb-note" style={tone("var(--th-status-info)")}>
            <Info className="h-4 w-4" />
            <span>
              Agents with a live channel get a new version at once; the rest with their next heartbeat. Agents 2.1.29
              and later report the version they run.
            </span>
          </div>
        </section>
      </div>

      {updated && (
        <div className="flex items-center gap-2 px-5 pb-3 text-[11px]" style={{ color: "var(--th-text-faint)" }}>
          <Gauge className="h-3.5 w-3.5" />v{policy.version} · {updated}
        </div>
      )}
      <SaveFooter
        dirty={dirty && problems.list.length === 0}
        saving={saving}
        saved={saved}
        error={error ?? (dirty ? firstProblem : null)}
        label={`Publish v${nextVersion} to ${devicesWord(policy.devices)}`}
        onSave={onSave}
        canManage={canManage}
        readOnlyNote="You can view this policy; changing it needs an admin."
      />
    </div>
  );
}
