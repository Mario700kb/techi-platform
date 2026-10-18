import { useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  CornerDownRight,
  Info,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import { formatDuration, METRIC_LABEL, METRIC_UNIT } from "../../api/monitoring";
import type { MonitoringPolicy, MonitorMetric, MonitorSeverity } from "../../api/monitoring";
import { Button, Select } from "../ui";
import type { SelectOption } from "../ui";
import { CardHead } from "../ui/PanelCard";
import { formatLocalDateTime } from "../../utils/time";
import ScopePicker from "./ScopePicker";
import {
  changeMetric,
  COVERAGE_TONE,
  coverageWords,
  devicesWord,
  DraftProblems,
  LIMITS,
  METRIC_SHAPE,
  METRICS,
  MonitorDraft,
  NEEDS_AGENT,
  newMonitor,
  overriddenBy,
  PolicyDraft,
  REPORTING_AGENT,
  ScopeNames,
  scopeWords,
  SERVER_METRICS,
  SEVERITIES,
  SEVERITY_LABEL,
  SEVERITY_TONE,
} from "./policyForm";

const tone = (value: string) => ({ "--onb-tone": value }) as CSSProperties;

const METRIC_OPTIONS: SelectOption<MonitorMetric>[] = METRICS.map((m) => ({
  value: m,
  label: METRIC_LABEL[m],
  hint: `${SERVER_METRICS.has(m) ? "Checked by the platform" : "Checked on the device"}${
    NEEDS_AGENT[m] ? ` · agent ${NEEDS_AGENT[m]}+` : ""
  }`,
}));
const OP_OPTIONS: SelectOption<">" | "<">[] = [
  { value: ">", label: ">", hint: "Above" },
  { value: "<", label: "<", hint: "Below" },
];
const SEVERITY_OPTIONS: SelectOption<MonitorSeverity>[] = SEVERITIES.map((s) => ({
  value: s,
  label: SEVERITY_LABEL[s],
  icon: <span className="th-mon-dot" style={{ background: SEVERITY_TONE[s] }} aria-hidden />,
}));

const COMPACT = "!h-[34px] w-full";

/**
 * A policy's coverage in the same words everywhere: the claim about agents
 * that report their version, then the older agents apart and muted.
 */
export function CoverageBadge({
  policy,
  variant = "inline",
}: {
  policy: MonitoringPolicy;
  variant?: "inline" | "pill";
}) {
  const coverage = coverageWords(policy);
  return (
    <span className="th-mon-coverage" data-variant={variant}>
      <span
        className={variant === "pill" ? "th-mon-pill" : "th-team-state"}
        style={tone(COVERAGE_TONE[coverage.tone])}
        title={`Agents ${REPORTING_AGENT} and later report the policy version they run`}
      >
        <i />
        <span className="truncate">{coverage.text}</span>
      </span>
      {coverage.older && <small>{coverage.older}</small>}
    </span>
  );
}

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
}) {
  return (
    <label className="th-policy-input !max-w-none w-full" data-invalid={invalid || undefined}>
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
      <span style={{ color: "var(--th-text-secondary)" }}>{SEVERITY_LABEL[severity]}</span>
    </span>
  );
}

/** Every section of the editor opens the same way: title and hint left, its one control right. */
function SectionHead({ title, hint, aside }: { title: string; hint?: string; aside?: ReactNode }) {
  return (
    <div className="th-mon-section-head">
      <div className="min-w-0">
        <h3>{title}</h3>
        {hint && <p>{hint}</p>}
      </div>
      {aside && <div className="flex flex-none items-center gap-2">{aside}</div>}
    </div>
  );
}

/** The read-only words for a monitor's condition and duration. */
function conditionText(m: MonitorDraft): string {
  const shape = METRIC_SHAPE[m.metric];
  if (shape.condition === "none") return shape.words ?? "—";
  if (shape.condition === "service") return m.target || "—";
  const op = shape.condition === "below" ? "<" : shape.condition === "above" ? ">" : m.op;
  const suffix = m.metric === "critical_events" ? " in 24 h" : "";
  return `${op} ${m.threshold}${METRIC_UNIT[m.metric]}${suffix}`;
}
function durationText(m: MonitorDraft): string {
  if (!METRIC_SHAPE[m.metric].duration) return "—";
  return formatDuration(Math.round(Number(m.durationMin) * 60));
}

/** The fixed comparison of a metric whose direction cannot be chosen. */
function FixedOp({ op, title }: { op: "<" | ">"; title?: string }) {
  return (
    <span
      className="flex h-[34px] w-[58px] flex-none items-center justify-center rounded-lg border font-mono text-[13px]"
      style={{ color: "var(--th-text-muted)", borderColor: "var(--th-border-subtle)" }}
      title={title}
    >
      {op}
    </span>
  );
}

/**
 * The monitor's key as a small mono chip beside its metric. A click turns it
 * into an input; an invalid key stays open until fixed. A key that replaces a
 * broader policy's monitor carries a marker and says which.
 */
function KeyChip({
  value,
  n,
  invalid,
  overrides,
  editable,
  onChange,
}: {
  value: string;
  n: number;
  invalid: boolean;
  overrides: string[];
  editable: boolean;
  onChange?: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const replaces = overrides.length ? `Replaces ${overrides.join(", ")}` : undefined;
  const title = replaces ? `Key ${value} · ${replaces}` : `Key ${value}`;

  if (editable && (editing || invalid)) {
    return (
      <input
        className="th-mon-key"
        value={value}
        maxLength={32}
        autoFocus={editing}
        spellCheck={false}
        aria-label={`Monitor ${n} key`}
        aria-invalid={invalid || undefined}
        data-invalid={invalid || undefined}
        onChange={(e) => onChange?.(e.target.value.toLowerCase())}
        onBlur={() => setEditing(false)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
      />
    );
  }
  const body = (
    <>
      {replaces && <CornerDownRight className="h-3 w-3 flex-none" aria-hidden />}
      <span className="truncate">{value || "—"}</span>
      {replaces && <span className="sr-only">{replaces}</span>}
    </>
  );
  if (!editable)
    return (
      <span className="th-mon-key" data-fit="true" data-override={replaces ? true : undefined} title={title}>
        {body}
      </span>
    );
  return (
    <button
      type="button"
      className="th-mon-key"
      data-override={replaces ? true : undefined}
      title={`${title} · click to edit`}
      aria-label={`Edit monitor ${n} key ${value}${replaces ? ` (${replaces})` : ""}`}
      onClick={() => setEditing(true)}
    >
      {body}
    </button>
  );
}

/** A cell's content, one control high, so every row is the same height. */
function Cell({ children, end = false }: { children: ReactNode; end?: boolean }) {
  return <div className={`flex h-[34px] min-w-0 items-center gap-2 ${end ? "justify-end" : ""}`}>{children}</div>;
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
  const shape = METRIC_SHAPE[row.metric];

  if (!canManage) {
    return (
      <tr className="th-alerts-row" style={{ opacity: row.enabled ? 1 : 0.55 }}>
        <td>
          <Cell>
            <span className="th-alerts-primary min-w-0 flex-1">{name}</span>
            <KeyChip value={row.key} n={n} invalid={false} overrides={overrides} editable={false} />
          </Cell>
        </td>
        <td>
          <Cell>
            <span
              className={`truncate text-[13px] ${METRIC_SHAPE[row.metric].condition === "none" ? "" : "font-mono"}`}
              style={{ color: "var(--th-text-secondary)" }}
              title={conditionText(row)}
            >
              {conditionText(row)}
            </span>
          </Cell>
        </td>
        <td>
          <Cell>
            <span className="text-[13px] tabular-nums" style={{ color: "var(--th-text-secondary)" }}>
              {durationText(row)}
            </span>
          </Cell>
        </td>
        <td>
          <Cell>
            <SeverityTag severity={row.severity} />
          </Cell>
        </td>
        <td>
          <Cell>
            <Switch checked={row.enabled} label={`${name} monitor on`} disabled onChange={() => undefined} />
          </Cell>
        </td>
      </tr>
    );
  }

  return (
    <tr className="th-alerts-row">
      <td>
        <Cell>
          <div className="min-w-0 flex-1">
            <Select
              value={row.metric}
              options={METRIC_OPTIONS}
              aria-label={`Monitor ${n} metric`}
              className={COMPACT}
              onChange={(metric) => onChange({ ...row, metric })}
            />
          </div>
          <KeyChip
            value={row.key}
            n={n}
            invalid={!!problems?.key}
            overrides={overrides}
            editable
            onChange={(key) => onChange({ ...row, key })}
          />
        </Cell>
      </td>
      <td>
        <Cell>
          {shape.condition === "none" ? (
            <span className="text-[13px]" style={{ color: "var(--th-text-muted)" }}>
              {shape.words}
            </span>
          ) : shape.condition === "service" ? (
            <label className="th-policy-input !max-w-none w-full" data-invalid={problems?.target ? true : undefined}>
              <input
                type="text"
                value={row.target}
                spellCheck={false}
                placeholder="MSSQL*, vmms, Spooler"
                aria-label={`Monitor ${n} services`}
                aria-invalid={problems?.target ? true : undefined}
                title="Service names, comma-separated; a trailing * matches a prefix. Only services set to start automatically count."
                onChange={(e) => onChange({ ...row, target: e.target.value })}
              />
            </label>
          ) : (
            <>
              {shape.condition === "op" ? (
                <div className="w-[58px] flex-none">
                  <Select
                    value={row.op}
                    options={OP_OPTIONS}
                    aria-label={`Monitor ${n} condition`}
                    className={COMPACT}
                    onChange={(op) => onChange({ ...row, op })}
                  />
                </div>
              ) : (
                <FixedOp op={shape.condition === "below" ? "<" : ">"} title={shape.words} />
              )}
              <UnitInput
                value={row.threshold}
                unit={row.metric === "critical_events" ? "/ 24 h" : METRIC_UNIT[row.metric]}
                label={`Monitor ${n} threshold`}
                invalid={!!problems?.threshold}
                min={row.metric === "critical_events" ? 0 : 1}
                onChange={(threshold) => onChange({ ...row, threshold })}
              />
            </>
          )}
        </Cell>
      </td>
      <td>
        <Cell>
          {!shape.duration ? (
            <span className="text-[13px]" style={{ color: "var(--th-text-faint)" }}>
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
            />
          )}
        </Cell>
      </td>
      <td>
        <Cell>
          <div className="min-w-0 flex-1">
            <Select
              value={row.severity}
              options={SEVERITY_OPTIONS}
              aria-label={`Monitor ${n} severity`}
              className={COMPACT}
              onChange={(severity) => onChange({ ...row, severity })}
            />
          </div>
        </Cell>
      </td>
      <td>
        <Cell>
          <Switch
            checked={row.enabled}
            label={`Monitor ${n} on`}
            onChange={(enabled) => onChange({ ...row, enabled })}
          />
        </Cell>
      </td>
      <td>
        <Cell end>
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
        </Cell>
      </td>
    </tr>
  );
}

/** The card's last line, pinned to the bottom of the screen while the card is in view. */
function ActionBar({
  policy,
  canManage,
  dirty,
  changes,
  problem,
  saving,
  saved,
  error,
  onSave,
  onDiscard,
}: {
  policy: MonitoringPolicy;
  canManage: boolean;
  dirty: boolean;
  changes: number;
  problem: string | null;
  saving: boolean;
  saved: string | null;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const updated = policy.updated_at
    ? `updated ${formatLocalDateTime(policy.updated_at)}${policy.updated_by ? ` by ${policy.updated_by}` : ""}`
    : null;
  const published = `v${policy.version}${updated ? ` · ${updated}` : ""}`;

  let status: ReactNode;
  if (!canManage) {
    status = <span className="th-onb-hint">You can view this policy; changing it needs an admin.</span>;
  } else if (error || (dirty && problem)) {
    status = (
      <span className="th-team-state" style={tone("var(--th-status-critical)")} role="alert">
        <AlertTriangle className="h-3.5 w-3.5 flex-none" />
        <span>{error ?? problem}</span>
      </span>
    );
  } else if (saved) {
    status = (
      <span className="th-team-state th-fade-in" style={tone("var(--th-status-online)")} role="status">
        <CheckCircle2 className="h-3.5 w-3.5 flex-none" />
        {saved}
      </span>
    );
  } else if (dirty) {
    status = (
      <span className="th-team-state" style={tone("var(--th-status-warning)")} data-testid="unpublished">
        <i />
        <span style={{ color: "var(--th-text-primary)" }}>
          {changes} unpublished change{changes === 1 ? "" : "s"}
        </span>
      </span>
    );
  } else {
    status = (
      <span className="th-team-state" style={tone("var(--th-status-online)")}>
        <Check className="h-3.5 w-3.5 flex-none" />
        <span style={{ color: "var(--th-text-secondary)" }}>Up to date · {published}</span>
      </span>
    );
  }

  return (
    <div className="th-mon-actionbar" data-dirty={dirty || undefined}>
      <div className="min-w-0 flex-1 text-[12px]">{status}</div>
      {canManage ? (
        <div className="flex flex-none flex-wrap items-center justify-end gap-2">
          {dirty && (
            <Button variant="secondary" onClick={onDiscard} disabled={saving}>
              Discard changes
            </Button>
          )}
          {dirty ? (
            <Button onClick={onSave} disabled={saving || !!problem}>
              <Upload className="h-4 w-4" />
              {saving ? "Publishing…" : `Publish v${policy.version + 1} to ${devicesWord(policy.devices)}`}
            </Button>
          ) : (
            <Button variant="secondary" disabled>
              <Check className="h-4 w-4" />
              Published · v{policy.version}
            </Button>
          )}
        </div>
      ) : (
        <span className="flex-none text-[12px] tabular-nums" style={{ color: "var(--th-text-faint)" }}>
          {published}
        </span>
      )}
    </div>
  );
}

const COLLECTION = [
  ["sample", "Sample every", "s", LIMITS.sample, `${LIMITS.sample.min}–${LIMITS.sample.max} s`],
  ["uploadMin", "Upload every", "min", LIMITS.uploadMin, `${LIMITS.uploadMin.min}–${LIMITS.uploadMin.max} min`],
  ["buffer", "Buffer on device", "MB", LIMITS.buffer, `${LIMITS.buffer.min}–${LIMITS.buffer.max} MB`],
  ["keepDays", "Keep unsent for", "days", LIMITS.keepDays, `${LIMITS.keepDays.min}–${LIMITS.keepDays.max} days`],
] as const;

export default function PolicyEditor({
  policy,
  policies,
  names,
  draft,
  onDraft,
  problems,
  canManage,
  dirty,
  changes,
  saving,
  saved,
  error,
  onSave,
  onDiscard,
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
  changes: number;
  saving: boolean;
  saved: string | null;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
  onDelete: () => void;
}) {
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

  return (
    <div className="th-onb-card th-mon-editor" aria-label={`Policy ${policy.name}`} role="region">
      <CardHead
        icon={Activity}
        tone="var(--th-accent)"
        title={policy.name}
        subtitle={`${scopeWords(policy, names)} · ${devicesWord(policy.devices)}`}
        aside={
          <div className="flex min-w-0 items-center gap-3">
            <CoverageBadge policy={policy} variant="pill" />
            {canManage && policy.scope !== "default" && (
              <button
                type="button"
                className="th-onb-action flex-none"
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

      <div className="th-onb-body th-mon-body">
        {/* ── details ─────────────────────────────────────────────────── */}
        <section className="th-onb-section" aria-label="Details">
          <SectionHead
            title="Details"
            hint="What the policy is called and which devices follow it."
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
          <div className="grid gap-4 sm:grid-cols-2">
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
          <div className="th-mon-table" data-testid="monitor-table">
            <table className={`th-alerts-table ${canManage ? "min-w-[700px]" : "min-w-[640px]"}`}>
              <colgroup>
                <col />
                <col className={canManage ? "w-[176px]" : "w-[130px]"} />
                <col className={canManage ? "w-[112px]" : "w-[96px]"} />
                <col className={canManage ? "w-[132px]" : "w-[112px]"} />
                <col className="w-[64px]" />
                {canManage && <col className="w-[56px]" />}
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
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {COLLECTION.map(([field, label, unit, range, hint]) => (
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
                />
                <small className="text-[11px] font-normal tabular-nums" style={{ color: "var(--th-text-faint)" }}>
                  {hint}
                </small>
              </div>
            ))}
          </div>
          <p className="flex items-start gap-2 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
            <Info className="mt-0.5 h-3.5 w-3.5 flex-none" style={{ color: "var(--th-status-info)" }} />
            <span>
              Agents with a live channel get a new version at once; the rest with their next heartbeat. Agents{" "}
              {REPORTING_AGENT} and later report the version they run.
            </span>
          </p>
        </section>
      </div>

      <ActionBar
        policy={policy}
        canManage={canManage}
        dirty={dirty}
        changes={changes}
        problem={problems.list[0] ?? null}
        saving={saving}
        saved={saved}
        error={error}
        onSave={onSave}
        onDiscard={onDiscard}
      />
    </div>
  );
}
