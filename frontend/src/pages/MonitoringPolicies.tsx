import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Info, Layers, Plus } from "lucide-react";

import { getClients, getGroups } from "../api/clients";
import {
  deleteMonitoringPolicy,
  getPipelineHealth,
  listMonitoringPolicies,
  updateMonitoringPolicy,
} from "../api/monitoring";
import type { MonitoringPolicy } from "../api/monitoring";
import { useAuth } from "../auth/AuthContext";
import ConfirmationModal from "../components/ConfirmationModal";
import NewPolicyModal from "../components/monitoring/NewPolicyModal";
import PipelinePanel from "../components/monitoring/PipelinePanel";
import PolicyEditor from "../components/monitoring/PolicyEditor";
import {
  devicesWord,
  fingerprint,
  monitorCount,
  PolicyDraft,
  ScopeNames,
  scopeWords,
  SPECIFICITY,
  syncWords,
  toBody,
  toDraft,
  validate,
} from "../components/monitoring/policyForm";
import { Button, EmptyState, PageHeader } from "../components/ui";
import { CardHead } from "../components/ui/PanelCard";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { usePollingRefresh } from "../hooks/usePollingRefresh";

const tone = (value: string) => ({ "--onb-tone": value }) as CSSProperties;
const PIPELINE_REFRESH_MS = 60_000;

type Pending = { kind: "select"; id: number } | { kind: "new" } | null;

function PolicyListItem({
  policy,
  names,
  selected,
  onSelect,
}: {
  policy: MonitoringPolicy;
  names: ScopeNames;
  selected: boolean;
  onSelect: () => void;
}) {
  const sync = syncWords(policy);
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className="th-onb-option flex w-full flex-col gap-1"
        data-testid={`policy-${policy.id}`}
      >
        <span className="flex w-full items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
            {policy.name}
          </span>
          <span className="flex-none font-mono text-[11px]" style={{ color: "var(--th-text-faint)" }}>
            v{policy.version}
          </span>
        </span>
        <span className="block w-full truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
          {scopeWords(policy, names)}
        </span>
        <span className="flex w-full items-center justify-between gap-2 text-[11px]">
          <span style={{ color: "var(--th-text-faint)" }}>{policy.enabled ? monitorCount(policy) : "Off"}</span>
          {policy.enabled && (
            <span
              className="th-team-state !text-[11px] tabular-nums"
              style={tone(sync.current ? "var(--th-status-online)" : "var(--th-status-warning)")}
            >
              <i />
              {sync.text}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

export default function MonitoringPolicies() {
  const { can } = useAuth();
  const isAdmin = can("admin");

  const policiesQuery = useCachedQuery("page.monitoring.policies", listMonitoringPolicies);
  const clientsQuery = useCachedQuery("page.monitoring.clients", getClients);
  const groupsQuery = useCachedQuery("page.monitoring.groups", () => getGroups());
  const pipelineQuery = useCachedQuery(isAdmin ? "page.monitoring.pipeline" : null, getPipelineHealth);
  const reloadPipeline = pipelineQuery.reload;
  usePollingRefresh(reloadPipeline, { intervalMs: PIPELINE_REFRESH_MS, enabled: isAdmin, immediate: false });

  const setPolicies = policiesQuery.setData;
  const names: ScopeNames = useMemo(
    () => ({ clients: clientsQuery.data ?? [], groups: groupsQuery.data ?? [] }),
    [clientsQuery.data, groupsQuery.data],
  );
  // Broad to specific, as a device applies them.
  const policies = useMemo(
    () => [...(policiesQuery.data ?? [])].sort((a, b) => SPECIFICITY[a.scope] - SPECIFICITY[b.scope] || a.id - b.id),
    [policiesQuery.data],
  );

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = policies.find((p) => p.id === selectedId) ?? policies[0] ?? null;

  // The form for the selected policy, and what it was seeded from.
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [seed, setSeed] = useState<{ id: number; version: number; print: string } | null>(null);
  const dirty = draft !== null && seed !== null && fingerprint(draft) !== seed.print;

  const reseed = (policy: MonitoringPolicy) => {
    const next = toDraft(policy);
    setDraft(next);
    setSeed({ id: policy.id, version: policy.version, print: fingerprint(next) });
  };
  // Seed on a new selection, and take a newer version from the server unless
  // the operator is editing.
  if (selected && (!seed || seed.id !== selected.id || (seed.version !== selected.version && !dirty))) {
    reseed(selected);
  }

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<{ busy: boolean; error: string | null } | null>(null);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(null), 5000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  // Closing the tab with unpublished edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const problems = useMemo(() => (draft ? validate(draft) : { monitors: {}, list: [] }), [draft]);

  const go = (next: Exclude<Pending, null>) => {
    setSaveError(null);
    setSaved(null);
    if (next.kind === "new") {
      setCreating(true);
      return;
    }
    setSelectedId(next.id);
    // Drop any edits: the seed check above reloads the form from the server copy.
    const policy = policies.find((p) => p.id === next.id);
    if (policy) reseed(policy);
  };
  const request = (next: Exclude<Pending, null>) => {
    if (next.kind === "select" && next.id === selected?.id) return;
    if (dirty) setPending(next);
    else go(next);
  };

  const save = async () => {
    if (!selected || !draft || problems.list.length) return;
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const updated = await updateMonitoringPolicy(selected.id, toBody(draft));
      setPolicies((list) => (list ?? []).map((p) => (p.id === updated.id ? updated : p)));
      reseed(updated);
      setSaved(`Published v${updated.version} to ${devicesWord(updated.devices)}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Couldn't publish the policy");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    setDeleting({ busy: true, error: null });
    try {
      await deleteMonitoringPolicy(selected.id);
      setPolicies((list) => (list ?? []).filter((p) => p.id !== selected.id));
      setSelectedId(null);
      setSeed(null);
      setDeleting(null);
      void reloadPipeline();
    } catch (err) {
      setDeleting({ busy: false, error: err instanceof Error ? err.message : "Couldn't delete the policy" });
    }
  };

  const loading = policiesQuery.loading;
  const loadError = policiesQuery.error && !policiesQuery.data ? policiesQuery.error : null;

  return (
    <section className="premium-page th-onb space-y-4">
      <PageHeader
        title="Monitoring"
        description="What every agent measures, how often, and when it raises an alert."
        actions={
          isAdmin && (
            <Button onClick={() => request({ kind: "new" })}>
              <Plus className="h-4 w-4" />
              New policy
            </Button>
          )
        }
      />

      {loadError ? (
        <div className="th-onb-card">
          <EmptyState
            icon={<Info className="h-5 w-5" />}
            title="Couldn't load the monitoring policies"
            description={loadError}
          />
        </div>
      ) : (
        <div
          className={`grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)] ${
            isAdmin ? "min-[1760px]:grid-cols-[300px_minmax(0,1fr)_300px]" : ""
          }`}
        >
          {/* ── policy list ─────────────────────────────────────────────── */}
          <section className="th-onb-card" aria-label="Policies">
            <CardHead
              icon={Layers}
              tone="var(--th-accent)"
              title="Policies"
              subtitle={loading ? "Loading…" : `${policies.length} ${policies.length === 1 ? "policy" : "policies"}`}
            />
            <div className="th-onb-body !gap-4">
              {loading ? (
                <div aria-hidden>
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.2 }} />
                  ))}
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {policies.map((policy) => (
                    <PolicyListItem
                      key={policy.id}
                      policy={policy}
                      names={names}
                      selected={policy.id === selected?.id}
                      onSelect={() => request({ kind: "select", id: policy.id })}
                    />
                  ))}
                </ul>
              )}
              <div className="th-onb-note" style={tone("var(--th-status-info)")}>
                <Info className="h-4 w-4" />
                <span>
                  A device follows its most specific policy: <strong>group</strong>, then <strong>client</strong>, then{" "}
                  <strong>device type</strong>, then the <strong>default</strong>. Monitors merge by key: a more
                  specific policy replaces a monitor with the same key and keeps the rest.
                </span>
              </div>
            </div>
          </section>

          {/* ── editor ──────────────────────────────────────────────────── */}
          {selected && draft ? (
            <PolicyEditor
              key={selected.id}
              policy={selected}
              policies={policies}
              names={names}
              draft={draft}
              onDraft={(update) => {
                setSaved(null);
                setSaveError(null);
                setDraft((d) => (d ? update(d) : d));
              }}
              problems={problems}
              canManage={isAdmin}
              dirty={dirty}
              saving={saving}
              saved={saved}
              error={saveError}
              onSave={() => void save()}
              onDelete={() => setDeleting({ busy: false, error: null })}
            />
          ) : (
            <div className="th-onb-card">
              {loading ? (
                <div className="p-5" aria-hidden>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.12 }} />
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<Layers className="h-5 w-5" />}
                  title="No policies yet"
                  description="Devices use built-in settings until a policy exists."
                />
              )}
            </div>
          )}

          {/* ── pipeline (admins) ───────────────────────────────────────── */}
          {isAdmin && (
            <div className="grid content-start gap-4 lg:col-span-2 lg:grid-cols-2 min-[1760px]:col-span-1 min-[1760px]:grid-cols-1">
              <PipelinePanel health={pipelineQuery.data} error={pipelineQuery.error} />
            </div>
          )}
        </div>
      )}

      {pending && (
        <ConfirmationModal
          title="Discard unpublished changes?"
          confirmLabel="Discard"
          onClose={() => setPending(null)}
          onConfirm={() => {
            const next = pending;
            setPending(null);
            go(next);
          }}
        >
          Your edits to {selected?.name ?? "this policy"} have not been published.
        </ConfirmationModal>
      )}

      {creating && (
        <NewPolicyModal
          names={names}
          onClose={() => setCreating(false)}
          onCreated={(policy) => {
            setCreating(false);
            setPolicies((list) => [...(list ?? []), policy]);
            setSelectedId(policy.id);
            reseed(policy);
            setSaved(`Published v${policy.version} to ${devicesWord(policy.devices)}`);
          }}
        />
      )}

      {deleting && selected && (
        <ConfirmationModal
          title={`Delete ${selected.name}?`}
          confirmLabel="Delete policy"
          loading={deleting.busy}
          onClose={() => setDeleting(null)}
          onConfirm={() => void remove()}
        >
          <p>Its {devicesWord(selected.devices)} fall back to the broader policies at once. This cannot be undone.</p>
          {deleting.error && (
            <p className="mt-3 text-[13px]" style={{ color: "var(--th-status-critical)" }} role="alert">
              {deleting.error}
            </p>
          )}
        </ConfirmationModal>
      )}
    </section>
  );
}
