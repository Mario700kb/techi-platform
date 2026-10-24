import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { CalendarClock, ChevronDown, ChevronRight, Info, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";

import {
  AutomationRun,
  AutomationRunStatus,
  AutomationSchedule,
  AutomationScope,
  AutomationTask,
  AutomationTaskBody,
  cancelAutomationRun,
  createAutomationTask,
  deleteAutomationTask,
  getAutomationRuns,
  getAutomationTasks,
  previewAutomationTask,
  runAutomationTask,
  updateAutomationTask,
} from "../api/automation";
import { Client, DeviceGroup, getClients, getGroups } from "../api/clients";
import ConfirmationModal from "../components/ConfirmationModal";
import { DEVICE_CATEGORIES } from "../components/monitoring/policyForm";
import { Button, DatePicker, EmptyState, Modal, PageHeader, Select, SkeletonRows } from "../components/ui";
import type { SelectOption } from "../components/ui";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { TONE } from "../utils/deviceStatus";
import { formatDateTime, tiranaInputToUtcIso, timeAgo, utcToTiranaInput } from "../utils/time";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const RUN_POLL_MS = 15_000;

const RUN_STATUS: Record<AutomationRunStatus, { label: string; tone: string }> = {
  running: { label: "Running", tone: TONE.info },
  completed: { label: "Completed", tone: TONE.online },
  halted: { label: "Halted", tone: TONE.critical },
  cancelled: { label: "Stopped", tone: TONE.neutral },
  window_closed: { label: "Window closed", tone: TONE.warning },
};

const message = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

export function describeSchedule(
  task: Pick<AutomationTask, "schedule" | "run_at" | "time_of_day" | "weekday" | "day_of_month">,
): string {
  const at = task.time_of_day ?? "—";
  switch (task.schedule) {
    case "once":
      return task.run_at ? `Once · ${formatDateTime(task.run_at)}` : "Once";
    case "daily":
      return `Every day at ${at}`;
    case "weekly":
      return `Every ${WEEKDAYS[task.weekday ?? 0]} at ${at}`;
    case "monthly":
      return `Monthly on day ${task.day_of_month ?? 1} at ${at}`;
  }
}

export function describeWaves(sizes: number[]): string {
  return sizes.map((s) => (s === 0 ? "the rest" : String(s))).join(" → ");
}

function describeScope(task: AutomationTask, clients: Client[], groups: DeviceGroup[]): string {
  const clientName = (id: number) => clients.find((c) => c.id === id)?.name ?? `client #${id}`;
  let target = "Every device";
  if (task.scope === "client") target = clientName(Number(task.scope_value));
  if (task.scope === "group") {
    const group = groups.find((g) => String(g.id) === task.scope_value);
    target = group ? `${clientName(group.client_id)} › ${group.name}` : `group #${task.scope_value}`;
  }
  if (task.scope === "device_type")
    target = DEVICE_CATEGORIES.find((c) => c.value === task.scope_value)?.label ?? String(task.scope_value);
  if (task.scope === "devices") target = `${task.device_ids?.length ?? 0} chosen devices`;
  const except = task.excluded_client_ids?.length
    ? ` · except ${task.excluded_client_ids.map(clientName).join(", ")}`
    : "";
  return target + except;
}

function StatusChip({ status }: { status: AutomationRunStatus }) {
  const s = RUN_STATUS[status];
  return (
    <span className="th-status-chip" style={{ "--chip-tone": s.tone } as CSSProperties}>
      <i />
      {s.label}
    </span>
  );
}

// ── runs ────────────────────────────────────────────────────────────────────

function RunWaves({ run }: { run: AutomationRun }) {
  if (!run.waves.length) return <p className="th-onb-hint">No wave yet.</p>;
  return (
    <ol className="mt-2 space-y-1.5">
      {run.waves.map((w) => {
        const total = w.device_ids.length;
        return (
          <li key={w.wave} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
            <span className="font-medium" style={{ color: "var(--th-text-primary)" }}>
              Wave {w.wave}
            </span>
            <span style={{ color: "var(--th-text-muted)" }}>
              {total} device{total === 1 ? "" : "s"} · {formatDateTime(w.started_at)}
            </span>
            {w.settled_at ? (
              <span style={{ color: "var(--th-text-secondary)" }}>
                {w.completed} updated
                {w.failed > 0 && <span style={{ color: "var(--th-status-critical)" }}> · {w.failed} failed</span>}
                {w.unfinished > 0 && (
                  <span style={{ color: "var(--th-status-warning)" }}> · {w.unfinished} did not finish</span>
                )}
              </span>
            ) : (
              <span style={{ color: "var(--th-status-info)" }}>in progress</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function RunHistory({ task, onChanged }: { task: AutomationTask; onChanged: () => void }) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setRuns(await getAutomationRuns(task.id));
      setError(null);
    } catch (err) {
      setError(message(err, "Couldn't load the runs"));
    }
  }, [task.id]);

  useEffect(() => {
    void load();
  }, [load, task.last_run?.id, task.last_run?.status]);

  const running = runs?.some((r) => r.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), RUN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const stop = async (run: AutomationRun) => {
    setStopping(run.id);
    try {
      await cancelAutomationRun(run.id);
      await load();
      onChanged();
    } catch (err) {
      setError(message(err, "Couldn't stop the run"));
    } finally {
      setStopping(null);
    }
  };

  if (error)
    return (
      <p className="th-onb-hint" style={{ color: "var(--th-status-critical)" }}>
        {error}
      </p>
    );
  if (!runs) return <p className="th-onb-hint">Loading runs…</p>;
  if (!runs.length) return <p className="th-onb-hint">No run yet.</p>;
  return (
    <ul className="space-y-3">
      {runs.map((run) => (
        <li key={run.id} className="rounded-lg border p-3" style={{ borderColor: "var(--th-border-subtle)" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <StatusChip status={run.status} />
              <span style={{ color: "var(--th-text-primary)" }}>{formatDateTime(run.started_at)}</span>
              <span style={{ color: "var(--th-text-muted)" }}>
                {run.trigger === "manual" ? `started by ${run.started_by ?? "an operator"}` : "on schedule"}
              </span>
            </div>
            {run.status === "running" && (
              <Button size="sm" variant="secondary" onClick={() => void stop(run)} disabled={stopping === run.id}>
                <Square className="h-3.5 w-3.5" />
                {stopping === run.id ? "Stopping…" : "Stop"}
              </Button>
            )}
          </div>
          {run.reason && (
            <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--th-text-secondary)" }}>
              {run.reason}
            </p>
          )}
          {run.status === "running" && run.next_wave_at && (
            <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--th-text-muted)" }}>
              Next wave {formatDateTime(run.next_wave_at)}
            </p>
          )}
          <RunWaves run={run} />
        </li>
      ))}
    </ul>
  );
}

// ── editor ──────────────────────────────────────────────────────────────────

interface Draft {
  name: string;
  enabled: boolean;
  scope: AutomationScope;
  scopeValue: string;
  excluded: number[];
  skipMaintenance: boolean;
  schedule: AutomationSchedule;
  runAt: string; // Tirana wall clock "YYYY-MM-DDTHH:MM"
  time: string;
  weekday: number;
  dayOfMonth: number;
  windowHours: string;
  waves: string;
  waitMinutes: string;
  maxFailure: string;
}

function draftFrom(task?: AutomationTask): Draft {
  return {
    name: task?.name ?? "Agent update",
    enabled: task?.enabled ?? true,
    scope: task?.scope ?? "default",
    scopeValue: task?.scope_value ?? "",
    excluded: task?.excluded_client_ids ?? [],
    skipMaintenance: task?.skip_maintenance ?? true,
    schedule: task?.schedule ?? "weekly",
    runAt: task?.run_at ? utcToTiranaInput(task.run_at) : "",
    time: task?.time_of_day ?? "02:00",
    weekday: task?.weekday ?? 6,
    dayOfMonth: task?.day_of_month ?? 1,
    windowHours: String((task?.window_minutes ?? 240) / 60),
    waves: describeWaves(task?.wave_sizes ?? [10, 50, 200, 0]).replace(/ → /g, ", "),
    waitMinutes: String(task?.wave_wait_minutes ?? 30),
    maxFailure: String(task?.max_failure_percent ?? 5),
  };
}

/** "10, 50, 200, the rest" → [10, 50, 200, 0]; null when it cannot be read. */
export function parseWaves(text: string): number[] | null {
  const parts = text
    .split(/[,→>]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;
  const sizes = parts.map((p) => (p === "the rest" || p === "rest" || p === "all" ? 0 : Number(p)));
  if (sizes.some((s) => !Number.isInteger(s) || s < 0 || s > 5000)) return null;
  if (sizes.slice(0, -1).includes(0)) return null;
  return sizes;
}

function bodyFrom(d: Draft): AutomationTaskBody | string {
  const waves = parseWaves(d.waves);
  if (!d.name.trim()) return "Give the task a name.";
  if (!waves) return "Waves: whole numbers separated by commas; only the last can be “the rest”.";
  if (d.scope !== "default" && !d.scopeValue) return "Choose what the task applies to.";
  if (d.schedule === "once" && !d.runAt) return "Choose when the task runs.";
  if (d.schedule !== "once" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)) return "Time of day: HH:MM.";
  const hours = Number(d.windowHours);
  const wait = Number(d.waitMinutes);
  const fail = Number(d.maxFailure);
  if (!(hours >= 0.25 && hours <= 24)) return "Time window: 0.25 to 24 hours.";
  if (!Number.isInteger(wait) || wait < 0 || wait > 1440) return "Wait between waves: 0 to 1440 minutes.";
  if (!Number.isInteger(fail) || fail < 0 || fail > 100) return "Failure limit: 0 to 100%.";
  return {
    name: d.name.trim(),
    enabled: d.enabled,
    scope: d.scope,
    scope_value: d.scope === "default" ? null : d.scopeValue,
    excluded_client_ids: d.excluded,
    skip_maintenance: d.skipMaintenance,
    schedule: d.schedule,
    run_at: d.schedule === "once" ? tiranaInputToUtcIso(d.runAt) : null,
    time_of_day: d.schedule === "once" ? null : d.time,
    weekday: d.schedule === "weekly" ? d.weekday : null,
    day_of_month: d.schedule === "monthly" ? d.dayOfMonth : null,
    window_minutes: Math.round(hours * 60),
    wave_sizes: waves,
    wave_wait_minutes: wait,
    max_failure_percent: fail,
  };
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="th-onb-field">
      <span>{label}</span>
      {children}
      {hint && <small className="th-onb-hint">{hint}</small>}
    </label>
  );
}

function TaskEditor({
  task,
  clients,
  groups,
  onClose,
  onSaved,
}: {
  task?: AutomationTask;
  clients: Client[];
  groups: DeviceGroup[];
  onClose: () => void;
  onSaved: (task: AutomationTask) => void;
}) {
  const [d, setD] = useState<Draft>(() => draftFrom(task));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((prev) => ({ ...prev, [key]: value }));

  const scopeOptions: SelectOption<AutomationScope>[] = [
    { value: "default", label: "Every device" },
    { value: "client", label: "One client" },
    { value: "group", label: "One group" },
    { value: "device_type", label: "A device category" },
  ];
  const clientName = (id: number) => clients.find((c) => c.id === id)?.name ?? `Client #${id}`;
  const sortedClients = [...clients].sort((a, b) => a.name.localeCompare(b.name));
  let valueOptions: SelectOption[] = [];
  if (d.scope === "client") valueOptions = sortedClients.map((c) => ({ value: String(c.id), label: c.name }));
  if (d.scope === "group")
    valueOptions = groups
      .map((g) => ({ value: String(g.id), label: `${clientName(g.client_id)} › ${g.name}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  if (d.scope === "device_type") valueOptions = DEVICE_CATEGORIES.map((c) => ({ value: c.value, label: c.label }));
  const excludable = sortedClients.filter((c) => !d.excluded.includes(c.id));

  const save = async () => {
    const body = bodyFrom(d);
    if (typeof body === "string") {
      setError(body);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(task ? await updateAutomationTask(task.id, body) : await createAutomationTask(body));
    } catch (err) {
      setError(message(err, "Couldn't save the task"));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={task ? "Edit task" : "New agent update task"}
      subtitle="The agent update, on a schedule, in waves"
      icon={CalendarClock}
      size="lg"
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : task ? "Save" : "Create task"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Name">
          <input
            className="th-input h-9 rounded-lg border px-3 text-[13px]"
            value={d.name}
            maxLength={160}
            aria-label="Name"
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Applies to">
            <Select
              value={d.scope}
              options={scopeOptions}
              aria-label="Applies to"
              className="w-full"
              onChange={(v) => setD((p) => ({ ...p, scope: v, scopeValue: "" }))}
            />
          </Field>
          {d.scope !== "default" && (
            <Field label="Which">
              <Select
                value={d.scopeValue}
                options={valueOptions}
                placeholder="Choose"
                aria-label="Which"
                className="w-full"
                onChange={(v) => set("scopeValue", v)}
              />
            </Field>
          )}
        </div>

        <Field label="Except these clients" hint="Their devices are never updated by this task.">
          <div className="flex flex-wrap items-center gap-1.5">
            {d.excluded.map((id) => (
              <button
                key={id}
                type="button"
                className="th-kv-chip"
                aria-label={`Remove ${clientName(id)}`}
                onClick={() =>
                  set(
                    "excluded",
                    d.excluded.filter((x) => x !== id),
                  )
                }
              >
                {clientName(id)} ×
              </button>
            ))}
            {excludable.length > 0 && (
              <Select
                value=""
                options={excludable.map((c) => ({ value: String(c.id), label: c.name }))}
                placeholder="Add a client"
                aria-label="Add an excluded client"
                className="min-w-[180px]"
                onChange={(v) => v && set("excluded", [...d.excluded, Number(v)])}
              />
            )}
          </div>
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Schedule">
            <Select
              value={d.schedule}
              aria-label="Schedule"
              className="w-full"
              options={[
                { value: "once", label: "Once" },
                { value: "daily", label: "Every day" },
                { value: "weekly", label: "Every week" },
                { value: "monthly", label: "Every month" },
              ]}
              onChange={(v) => set("schedule", v as AutomationSchedule)}
            />
          </Field>
          {d.schedule === "once" ? (
            <Field label="When (Tirana time)">
              <DatePicker value={d.runAt} withTime onChange={(v) => set("runAt", v)} />
            </Field>
          ) : (
            <>
              {d.schedule === "weekly" && (
                <Field label="Day">
                  <Select
                    value={String(d.weekday)}
                    aria-label="Day of the week"
                    className="w-full"
                    options={WEEKDAYS.map((w, i) => ({ value: String(i), label: w }))}
                    onChange={(v) => set("weekday", Number(v))}
                  />
                </Field>
              )}
              {d.schedule === "monthly" && (
                <Field label="Day of the month">
                  <Select
                    value={String(d.dayOfMonth)}
                    aria-label="Day of the month"
                    className="w-full"
                    options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
                    onChange={(v) => set("dayOfMonth", Number(v))}
                  />
                </Field>
              )}
              <Field label="Time (Tirana)">
                <input
                  className="th-input h-9 rounded-lg border px-3 font-mono text-[13px]"
                  value={d.time}
                  placeholder="02:00"
                  aria-label="Time of day"
                  onChange={(e) => set("time", e.target.value)}
                />
              </Field>
            </>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Waves" hint="Devices per wave, in order; the last can be “the rest”.">
            <input
              className="th-input h-9 rounded-lg border px-3 font-mono text-[13px]"
              value={d.waves}
              aria-label="Waves"
              onChange={(e) => set("waves", e.target.value)}
            />
          </Field>
          <Field label="Wait between waves (minutes)" hint="After a wave has finished.">
            <input
              className="th-input h-9 rounded-lg border px-3 text-[13px]"
              inputMode="numeric"
              value={d.waitMinutes}
              aria-label="Wait between waves"
              onChange={(e) => set("waitMinutes", e.target.value)}
            />
          </Field>
          <Field label="Stop when more than (% of a wave) fail">
            <input
              className="th-input h-9 rounded-lg border px-3 text-[13px]"
              inputMode="numeric"
              value={d.maxFailure}
              aria-label="Failure limit"
              onChange={(e) => set("maxFailure", e.target.value)}
            />
          </Field>
          <Field label="Time window (hours)" hint="No new wave starts after this; the rest wait for the next run.">
            <input
              className="th-input h-9 rounded-lg border px-3 text-[13px]"
              inputMode="decimal"
              value={d.windowHours}
              aria-label="Time window"
              onChange={(e) => set("windowHours", e.target.value)}
            />
          </Field>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={d.skipMaintenance}
              onChange={(e) => set("skipMaintenance", e.target.checked)}
            />
            Skip devices in maintenance
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={d.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            Enabled
          </label>
        </div>
        <p className="th-onb-hint">
          Only online devices that are not on the active agent are taken. A wave counts as finished when every update in
          it has ended, or after 30 minutes; one that did not finish counts as failed.
        </p>
        {error && (
          <p role="alert" className="th-drawer-callout text-[13px]" data-tone="critical">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

function TaskCard({
  task,
  clients,
  groups,
  onEdit,
  onDelete,
  onChanged,
}: {
  task: AutomationTask;
  clients: Client[];
  groups: DeviceGroup[];
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = task.last_run?.status === "running";

  const runNow = async () => {
    setBusy(true);
    setError(null);
    try {
      await runAutomationTask(task.id);
      setOpen(true);
      onChanged();
    } catch (err) {
      setError(message(err, "Couldn't start the run"));
    } finally {
      setBusy(false);
    }
  };

  const loadPreview = async () => {
    try {
      const p = await previewAutomationTask(task.id);
      setPreview(
        `${p.needs_update} online device${p.needs_update === 1 ? "" : "s"} need ${p.version ?? "the active agent"} now; first wave ${p.first_wave}. ${p.up_to_date_or_busy} already on it or busy.`,
      );
    } catch (err) {
      setPreview(message(err, "Couldn't count the devices"));
    }
  };

  return (
    <div className="th-onb-card">
      <div className="th-onb-body">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <button
            type="button"
            className="flex min-w-0 items-start gap-2 text-left"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? (
              <ChevronDown className="mt-0.5 h-4 w-4 flex-none" />
            ) : (
              <ChevronRight className="mt-0.5 h-4 w-4 flex-none" />
            )}
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                {task.name}
                {!task.enabled && (
                  <span className="ml-2 text-[12px] font-normal" style={{ color: "var(--th-text-muted)" }}>
                    · disabled
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-[12.5px]" style={{ color: "var(--th-text-secondary)" }}>
                {describeSchedule(task)} · {describeScope(task, clients, groups)}
              </span>
              <span className="mt-0.5 block text-[12.5px]" style={{ color: "var(--th-text-muted)" }}>
                Waves {describeWaves(task.wave_sizes)} · wait {task.wave_wait_minutes} min · stop above{" "}
                {task.max_failure_percent}% · window {task.window_minutes / 60} h
              </span>
            </span>
          </button>
          <div className="flex flex-wrap items-center gap-2">
            {task.last_run && <StatusChip status={task.last_run.status} />}
            <Button size="sm" variant="secondary" onClick={() => void runNow()} disabled={busy || running}>
              <Play className="h-3.5 w-3.5" />
              {running ? "Running" : busy ? "Starting…" : "Run now"}
            </Button>
            <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${task.name}`}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="ghost" onClick={onDelete} disabled={running} aria-label={`Delete ${task.name}`}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <p className="mt-2 text-[12.5px]" style={{ color: "var(--th-text-muted)" }}>
          {task.next_run_at
            ? `Next run ${formatDateTime(task.next_run_at)} (${timeAgo(task.next_run_at)})`
            : task.enabled
              ? "No run scheduled"
              : "Disabled: runs only with Run now"}
          {" · "}
          <button type="button" className="th-link-btn" onClick={() => void loadPreview()}>
            How many devices now?
          </button>
        </p>
        {preview && (
          <p className="mt-1 text-[12.5px]" role="status" style={{ color: "var(--th-text-secondary)" }}>
            {preview}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-[12.5px]" style={{ color: "var(--th-status-critical)" }}>
            {error}
          </p>
        )}
        {open && (
          <div className="mt-3">
            <RunHistory task={task} onChanged={onChanged} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function AutomationPage() {
  const tasksQuery = useCachedQuery("page.automation.tasks", getAutomationTasks);
  const clientsQuery = useCachedQuery("page.automation.clients", getClients);
  const groupsQuery = useCachedQuery("page.automation.groups", () => getGroups());
  const [editing, setEditing] = useState<AutomationTask | "new" | null>(null);
  const [deleting, setDeleting] = useState<AutomationTask | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const tasks = tasksQuery.data ?? [];
  const clients = clientsQuery.data ?? [];
  const groups = groupsQuery.data ?? [];
  const reload = tasksQuery.reload;

  const remove = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteAutomationTask(deleting.id);
      setDeleting(null);
      void reload();
    } catch (err) {
      setDeleteError(message(err, "Couldn't delete the task"));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <section className="premium-page th-onb space-y-4">
      <PageHeader
        title="Automation"
        description="The agent update on a schedule, rolled out in waves that stop when too many fail."
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" />
            New task
          </Button>
        }
      />

      {tasksQuery.error && (
        <div className="th-onb-card">
          <EmptyState
            icon={<Info className="h-5 w-5" />}
            title="Couldn't load the tasks"
            description={tasksQuery.error}
          />
        </div>
      )}
      {tasksQuery.loading && (
        <div className="th-onb-card">
          <SkeletonRows rows={3} />
        </div>
      )}
      {!tasksQuery.error && tasksQuery.data && tasks.length === 0 && (
        <div className="th-onb-card">
          <EmptyState
            icon={<CalendarClock className="h-5 w-5" />}
            title="No task yet"
            description="Schedule the agent update for the whole fleet or one client: in waves, outside working hours, stopping by itself when a wave goes wrong."
            action={
              <Button size="sm" onClick={() => setEditing("new")}>
                <Plus className="h-3.5 w-3.5" />
                New task
              </Button>
            }
          />
        </div>
      )}

      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          clients={clients}
          groups={groups}
          onEdit={() => setEditing(task)}
          onDelete={() => setDeleting(task)}
          onChanged={() => void reload()}
        />
      ))}

      {editing && (
        <TaskEditor
          task={editing === "new" ? undefined : editing}
          clients={clients}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmationModal
          title="Delete task"
          confirmLabel="Delete"
          loading={deleteBusy}
          onClose={() => setDeleting(null)}
          onConfirm={() => void remove()}
        >
          <p className="font-medium" style={{ color: "var(--th-text-primary)" }}>
            {deleting.name}
          </p>
          <p className="mt-3">The task and its run history are removed. Updates already done stay done.</p>
          {deleteError && (
            <p role="alert" className="th-drawer-callout mt-3 text-[13px]" data-tone="critical">
              {deleteError}
            </p>
          )}
        </ConfirmationModal>
      )}
    </section>
  );
}
