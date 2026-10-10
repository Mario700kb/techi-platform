import { ReactNode, useCallback, useEffect, useState } from "react";
import { Bell, Mail, Plus, RefreshCcw, Send, Trash2, Webhook as WebhookIcon } from "lucide-react";

import {
  NOTIFICATION_EVENT_TYPES,
  NotificationChannel,
  NotificationChannelType,
  NotificationDelivery,
  NotificationRule,
  NotificationScopeType,
  createNotificationChannel,
  createNotificationRule,
  deleteNotificationChannel,
  deleteNotificationRule,
  listNotificationChannels,
  listNotificationDeliveries,
  listNotificationRules,
  testNotificationChannel,
  updateNotificationRule,
} from "../api/notifications";
import { useAuth } from "../auth/AuthContext";
import { Badge, Button, PageHeader, SelectField } from "../components/ui";
import ConfirmationModal from "../components/ConfirmationModal";
import { APP_TIME_ZONE, parseUTC, DISPLAY_LOCALE } from "../utils/time";

const INPUT_CLS =
  "th-input rounded-lg border px-3 py-2 text-sm font-medium outline-none focus:border-techi-orange/60";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return parseUTC(iso).toLocaleString(DISPLAY_LOCALE, { hourCycle: "h23", timeZone: APP_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STATUS_COLOR: Record<string, string> = {
  sent: "var(--th-status-online)",
  pending: "var(--th-status-offline)",
  retrying: "var(--th-status-warning)",
  failed: "var(--th-status-critical)",
};

export default function NotificationSettings() {
  const { can } = useAuth();
  const canManage = can("admin");

  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  // New channel form
  const [chName, setChName] = useState("");
  const [chType, setChType] = useState<NotificationChannelType>("email");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpTls, setSmtpTls] = useState(true);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpFrom, setSmtpFrom] = useState("");
  const [smtpTo, setSmtpTo] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [chSecret, setChSecret] = useState("");
  const [savingChannel, setSavingChannel] = useState(false);
  const [deleteChannelTarget, setDeleteChannelTarget] = useState<NotificationChannel | null>(null);

  // New rule form
  const [ruleEvent, setRuleEvent] = useState<string>(NOTIFICATION_EVENT_TYPES[0]);
  const [ruleScope, setRuleScope] = useState<NotificationScopeType>("global");
  const [ruleClientId, setRuleClientId] = useState("");
  const [ruleChannelId, setRuleChannelId] = useState<number | "">("");
  const [ruleSeverity, setRuleSeverity] = useState("");
  const [ruleCooldown, setRuleCooldown] = useState("0");
  const [ruleRateLimit, setRuleRateLimit] = useState("");
  const [savingRule, setSavingRule] = useState(false);
  const [deleteRuleTarget, setDeleteRuleTarget] = useState<NotificationRule | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, r, d] = await Promise.all([
        listNotificationChannels(),
        listNotificationRules(),
        listNotificationDeliveries({ limit: 25 }),
      ]);
      setChannels(c);
      setRules(r);
      setDeliveries(d.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load notification settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const recipients = smtpTo.split(/[,;\s]+/).map((v) => v.trim()).filter(Boolean);
  const channelReady = chName.trim() !== "" && (chType === "email" ? smtpHost.trim() !== "" && recipients.length > 0 : webhookUrl.trim() !== "");

  function resetChannelForm() {
    setChName("");
    setSmtpHost("");
    setSmtpPort("587");
    setSmtpTls(true);
    setSmtpUser("");
    setSmtpFrom("");
    setSmtpTo("");
    setWebhookUrl("");
    setChSecret("");
  }

  async function handleCreateChannel() {
    if (!channelReady) return;
    setSavingChannel(true);
    setError(null);
    try {
      const config: Record<string, unknown> = chType === "email"
        ? {
            smtp_host: smtpHost.trim(),
            smtp_port: Number(smtpPort) || 587,
            use_tls: smtpTls,
            username: smtpUser.trim() || null,
            from_address: smtpFrom.trim() || smtpUser.trim() || null,
            to_addresses: recipients,
          }
        : { url: webhookUrl.trim(), headers: {} };
      await createNotificationChannel({
        name: chName.trim(),
        channel_type: chType,
        config,
        secret: chSecret.trim() || null,
      });
      resetChannelForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create channel");
    } finally {
      setSavingChannel(false);
    }
  }

  async function handleTestChannel(channel: NotificationChannel) {
    setTestResult(null);
    try {
      const res = await testNotificationChannel(channel.id);
      setTestResult(res.success ? `Test sent via ${channel.name}.` : `Test failed: ${res.error}`);
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : "Test failed");
    }
  }

  async function handleDeleteChannel() {
    if (!deleteChannelTarget) return;
    try {
      await deleteNotificationChannel(deleteChannelTarget.id);
      setDeleteChannelTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function handleCreateRule() {
    if (!ruleChannelId) return;
    setSavingRule(true);
    setError(null);
    try {
      await createNotificationRule({
        event_type: ruleEvent,
        scope_type: ruleScope,
        client_id: ruleScope === "client" && ruleClientId ? Number(ruleClientId) : null,
        channel_id: Number(ruleChannelId),
        min_severity: ruleSeverity || null,
        cooldown_seconds: Number(ruleCooldown) || 0,
        rate_limit_per_hour: ruleRateLimit ? Number(ruleRateLimit) : null,
      });
      setRuleClientId("");
      setRuleSeverity("");
      setRuleCooldown("0");
      setRuleRateLimit("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create rule");
    } finally {
      setSavingRule(false);
    }
  }

  async function handleToggleRule(rule: NotificationRule) {
    try {
      await updateNotificationRule(rule.id, { enabled: !rule.enabled });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update rule");
    }
  }

  async function handleDeleteRule() {
    if (!deleteRuleTarget) return;
    try {
      await deleteNotificationRule(deleteRuleTarget.id);
      setDeleteRuleTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  function channelName(id: number): string {
    return channels.find((c) => c.id === id)?.name || `#${id}`;
  }

  return (
    <section className="premium-page space-y-5">
      <PageHeader
        title="Notification Settings"
        description="Email and webhook channels, event-type rules (global or per-client), and delivery history. Rules route platform events — alerts, remote actions, terminal sessions, enrollment, maintenance — to the channels below."
        actions={
          <>
            <Button variant="secondary" onClick={() => void load()}>
              <RefreshCcw className="h-4 w-4" />
              Refresh
            </Button>
          </>
        }
      />

      {error && (
        <div className="rounded-lg border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      )}
      {testResult && (
        <div className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-slate-200">
          {testResult}
        </div>
      )}

      {/* Channels */}
      <div className="premium-card p-4">
        <p className="premium-kicker mb-3">Channels</p>

        {canManage && (
          <div className="mb-4 rounded-lg border p-4" style={{ borderColor: "var(--th-border-subtle)", background: "var(--th-bg-drawer-section)" }}>
            <p className="mb-3 text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>Add channel</p>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <Field label="Name">
                <input className={INPUT_CLS} placeholder="e.g. Ops team email" value={chName} onChange={(e) => setChName(e.target.value)} />
              </Field>
              <Field label="Type">
                <SelectField className={INPUT_CLS} value={chType} onChange={(e) => setChType(e.target.value as NotificationChannelType)}>
                  <option value="email">Email (SMTP)</option>
                  <option value="webhook">Webhook</option>
                </SelectField>
              </Field>
              {chType === "email" ? (
                <>
                  <Field label="SMTP server">
                    <input className={INPUT_CLS} placeholder="smtp.example.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
                  </Field>
                  <Field label="Port">
                    <input className={INPUT_CLS} type="number" min={1} value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
                  </Field>
                  <Field label="Username">
                    <input className={INPUT_CLS} placeholder="alerts@example.com" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
                  </Field>
                  <Field label="Password (optional)">
                    <input className={INPUT_CLS} type="password" autoComplete="new-password" value={chSecret} onChange={(e) => setChSecret(e.target.value)} />
                  </Field>
                  <Field label="From address">
                    <input className={INPUT_CLS} placeholder="Defaults to the username" value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} />
                  </Field>
                  <Field label="Recipients">
                    <input className={INPUT_CLS} placeholder="ops@example.com, noc@example.com" value={smtpTo} onChange={(e) => setSmtpTo(e.target.value)} />
                  </Field>
                  <label className="flex items-center gap-2 text-[13px] xl:col-span-4" style={{ color: "var(--th-text-secondary)" }}>
                    <input type="checkbox" checked={smtpTls} onChange={(e) => setSmtpTls(e.target.checked)} className="h-4 w-4 accent-orange-500" />
                    Use STARTTLS
                  </label>
                </>
              ) : (
                <>
                  <Field label="Webhook URL" className="xl:col-span-2">
                    <input className={INPUT_CLS} placeholder="https://hooks.example.com/techi" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
                  </Field>
                  <Field label="Shared secret (optional)" className="xl:col-span-2">
                    <input className={INPUT_CLS} type="password" autoComplete="new-password" placeholder="Sent as X-TECHI-Signature" value={chSecret} onChange={(e) => setChSecret(e.target.value)} />
                  </Field>
                </>
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <Button size="sm" onClick={() => void handleCreateChannel()} disabled={savingChannel || !channelReady}>
                <Plus className="h-4 w-4" />
                {savingChannel ? "Saving…" : "Add channel"}
              </Button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border border-white/5">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/5 text-[11px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Enabled</th>
                <th className="px-4 py-3">Secret</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">Loading…</td></tr>
              ) : channels.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">No channels yet.</td></tr>
              ) : (
                channels.map((c) => (
                  <tr key={c.id} className="border-b border-white/5">
                    <td className="px-4 py-3 font-semibold text-white">
                      <span className="inline-flex items-center gap-2">
                        {c.channel_type === "email" ? <Mail className="h-3.5 w-3.5" /> : <WebhookIcon className="h-3.5 w-3.5" />}
                        {c.name}
                      </span>
                    </td>
                    <td className="px-4 py-3"><Badge variant="ghost">{c.channel_type}</Badge></td>
                    <td className="px-4 py-3 text-slate-300">{c.enabled ? "Yes" : "No"}</td>
                    <td className="px-4 py-3 text-slate-400">{c.has_secret ? "Set" : "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {canManage && (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleTestChannel(c)}
                              className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.06]"
                            >
                              <Send className="h-3.5 w-3.5" />
                              Test
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteChannelTarget(c)}
                              className="inline-flex items-center gap-1 rounded-md border border-red-400/30 px-2.5 py-1 text-xs font-semibold text-red-200 transition hover:bg-red-400/10"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Rules */}
      <div className="premium-card p-4">
        <p className="premium-kicker mb-3">Rules</p>

        {canManage && (
          <div className="mb-4 rounded-lg border p-4" style={{ borderColor: "var(--th-border-subtle)", background: "var(--th-bg-drawer-section)" }}>
            <p className="mb-3 text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>Add rule</p>
            <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Field label="When this happens">
                <SelectField className={INPUT_CLS} value={ruleEvent} onChange={(e) => setRuleEvent(e.target.value)}>
                  {NOTIFICATION_EVENT_TYPES.map((ev) => (
                    <option key={ev} value={ev}>{ev.replace(/_/g, " ")}</option>
                  ))}
                </SelectField>
              </Field>
              <Field label="Scope">
                <SelectField className={INPUT_CLS} value={ruleScope} onChange={(e) => setRuleScope(e.target.value as NotificationScopeType)}>
                  <option value="global">All clients</option>
                  <option value="client">One client</option>
                </SelectField>
              </Field>
              {ruleScope === "client" && (
                <Field label="Client ID">
                  <input className={INPUT_CLS} value={ruleClientId} onChange={(e) => setRuleClientId(e.target.value)} />
                </Field>
              )}
              <Field label="Notify channel">
                <SelectField className={INPUT_CLS} value={ruleChannelId} onChange={(e) => setRuleChannelId(e.target.value ? Number(e.target.value) : "")}>
                  <option value="">{channels.length ? "Choose a channel" : "Add a channel first"}</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </SelectField>
              </Field>
              <Field label="Minimum severity">
                <SelectField className={INPUT_CLS} value={ruleSeverity} onChange={(e) => setRuleSeverity(e.target.value)}>
                  <option value="">Any severity</option>
                  <option value="info">Info and above</option>
                  <option value="warning">Warning and above</option>
                  <option value="critical">Critical only</option>
                </SelectField>
              </Field>
              <Field label="Cooldown (seconds)">
                <input className={INPUT_CLS} type="number" min={0} value={ruleCooldown} onChange={(e) => setRuleCooldown(e.target.value)} />
              </Field>
              <Field label="Max per hour (optional)">
                <input className={INPUT_CLS} type="number" min={1} placeholder="No limit" value={ruleRateLimit} onChange={(e) => setRuleRateLimit(e.target.value)} />
              </Field>
            </div>
            <div className="mt-4 flex justify-end">
              <Button size="sm" onClick={() => void handleCreateRule()} disabled={savingRule || !ruleChannelId}>
                <Plus className="h-4 w-4" />
                {savingRule ? "Saving…" : "Add rule"}
              </Button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border border-white/5">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/5 text-[11px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Scope</th>
                <th className="px-4 py-3">Channel</th>
                <th className="px-4 py-3">Min severity</th>
                <th className="px-4 py-3">Cooldown</th>
                <th className="px-4 py-3">Rate limit</th>
                <th className="px-4 py-3">Enabled</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">No rules yet — events won't notify anyone until a rule exists.</td></tr>
              ) : (
                rules.map((r) => (
                  <tr key={r.id} className="border-b border-white/5">
                    <td className="px-4 py-3 font-mono text-xs text-white">{r.event_type}</td>
                    <td className="px-4 py-3 text-slate-300">{r.scope_type === "client" ? `Client #${r.client_id}` : "Global"}</td>
                    <td className="px-4 py-3 text-slate-300">{channelName(r.channel_id)}</td>
                    <td className="px-4 py-3 text-slate-400">{r.min_severity || "any"}</td>
                    <td className="px-4 py-3 text-slate-400">{r.cooldown_seconds}s</td>
                    <td className="px-4 py-3 text-slate-400">{r.rate_limit_per_hour ?? "—"}</td>
                    <td className="px-4 py-3">
                      {canManage ? (
                        <button
                          type="button"
                          onClick={() => void handleToggleRule(r)}
                          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.06]"
                        >
                          {r.enabled ? "On" : "Off"}
                        </button>
                      ) : (
                        r.enabled ? "On" : "Off"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => setDeleteRuleTarget(r)}
                            className="inline-flex items-center gap-1 rounded-md border border-red-400/30 px-2.5 py-1 text-xs font-semibold text-red-200 transition hover:bg-red-400/10"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Delivery history */}
      <div className="premium-card overflow-hidden">
        <p className="premium-kicker p-4 pb-0">Delivery history</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/5 text-[11px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Channel</th>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Attempts</th>
                <th className="px-4 py-3">Error</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No deliveries yet.</td></tr>
              ) : (
                deliveries.map((d) => (
                  <tr key={d.id} className="border-b border-white/5">
                    <td className="px-4 py-3 text-slate-400">{formatDate(d.created_at)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-white">{d.event_type}</td>
                    <td className="px-4 py-3 text-slate-300">{channelName(d.channel_id)}</td>
                    <td className="px-4 py-3 text-slate-300">{d.title}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: STATUS_COLOR[d.status] || "var(--th-status-offline)" }}>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR[d.status] || "var(--th-status-offline)" }} />
                        {d.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{d.attempt_count}</td>
                    <td className="max-w-[240px] truncate px-4 py-3 text-slate-500" title={d.last_error || undefined}>{d.last_error || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {deleteChannelTarget && (
        <ConfirmationModal
          title="Delete channel"
          confirmLabel="Delete"
          onConfirm={() => void handleDeleteChannel()}
          onClose={() => setDeleteChannelTarget(null)}
        >
          <p className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
            Delete channel <strong>{deleteChannelTarget.name}</strong>? Rules using it will stop notifying (deleted via cascade).
          </p>
        </ConfirmationModal>
      )}

      {deleteRuleTarget && (
        <ConfirmationModal
          title="Delete rule"
          confirmLabel="Delete"
          onConfirm={() => void handleDeleteRule()}
          onClose={() => setDeleteRuleTarget(null)}
        >
          <p className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
            Delete the rule for <strong>{deleteRuleTarget.event_type}</strong>?
          </p>
        </ConfirmationModal>
      )}
    </section>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <span className="text-[12px] font-medium" style={{ color: "var(--th-text-secondary)" }}>{label}</span>
      {children}
    </label>
  );
}
