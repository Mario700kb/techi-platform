import { useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { BellOff, CheckCircle2 } from "lucide-react";

import { getAlertFindings, getAlertMutes, getAlertQuality, removeAlertMute } from "../../api/alerts";
import { useAuth } from "../../auth/AuthContext";
import { useCachedQuery } from "../../hooks/useCachedQuery";
import type { Finding } from "../../types/alert";
import { ALERT_KIND_LABELS } from "../../types/alert";
import type { AlertKind } from "../../types/alert";
import { formatCount } from "../../utils/number";
import { formatLocalDateTime, timeAgo } from "../../utils/time";
import { Button, EmptyState } from "../ui";

const FINDING_TYPES: { id: Finding["type"] | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "security", label: "Security" },
  { id: "reboot", label: "Restart pending" },
  { id: "disk_forecast", label: "Disk forecast" },
];
const FINDING_TONE: Record<Finding["severity"], string> = {
  high: "var(--th-status-critical)",
  medium: "var(--th-status-warning)",
  low: "var(--th-status-info)",
};

/** States to fix on a plan, not incidents: they do not wait in the alert queue. */
export function FindingsView() {
  const navigate = useNavigate();
  const [type, setType] = useState<Finding["type"] | "all">("all");
  const { data, loading } = useCachedQuery("page.alerts.findings", () => getAlertFindings());
  const items = (data?.items ?? []).filter((i) => type === "all" || i.type === type);
  return (
    <div className="th-ac-view">
      <p className="th-ac-muted">
        Weak security, restarts waiting and disks that will fill. Fixed in batches, by plan: they do not wait in the
        alert queue. A protection that gets switched off still opens an alert.
      </p>
      <div className="th-ac-seg" role="group" aria-label="Finding type">
        {FINDING_TYPES.map((t) => (
          <button key={t.id} type="button" aria-pressed={type === t.id} onClick={() => setType(t.id)}>
            {t.label}
            <b>{formatCount(t.id === "all" ? (data?.items.length ?? 0) : (data?.counts[t.id] ?? 0))}</b>
          </button>
        ))}
      </div>
      {loading && !data ? (
        <div className="th-alerts-skeleton" aria-busy="true" />
      ) : items.length === 0 ? (
        <EmptyState icon={<CheckCircle2 className="h-5 w-5" />} title="Nothing to fix here" />
      ) : (
        <div className="th-ac-table-wrap">
          <table className="th-ac-table">
            <thead>
              <tr>
                <th>Finding</th>
                <th>Device</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr
                  key={`${item.device_id}-${item.type}-${i}`}
                  data-clickable="true"
                  onClick={() => navigate(`/devices?device=${item.device_id}`)}
                >
                  <td>
                    <span
                      className="th-status-chip"
                      style={{ "--chip-tone": FINDING_TONE[item.severity] } as CSSProperties}
                    >
                      <i />
                      {item.title}
                    </span>
                  </td>
                  <td>
                    <b>{item.device_name}</b>
                    <small>
                      {item.client_name ?? "No client"} · {item.device_role === "server" ? "Server" : "Workstation"}
                    </small>
                  </td>
                  <td>
                    {item.detail}
                    {item.since && <small>since {formatLocalDateTime(item.since)}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Which rules make noise, so they can be tuned every week. */
export function QualityView() {
  const [days, setDays] = useState(7);
  const { data, loading } = useCachedQuery(`page.alerts.quality.${days}`, () => getAlertQuality(days));
  return (
    <div className="th-ac-view">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="th-ac-muted">
          Noise = closed by itself within 15 minutes, came back, or closed as false alarm / expected. Tune the noisiest
          rules each week.
        </p>
        <div className="th-ac-seg" role="group" aria-label="Period">
          {[7, 30].map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      {data && (
        <div className="grid grid-cols-3 gap-3">
          <div className="th-kpi">
            <span className="th-kpi-label">Alerts</span>
            <span className="th-kpi-value">{formatCount(data.totals.opened)}</span>
          </div>
          <div className="th-kpi" style={{ "--kpi-tone": "var(--th-status-warning)" } as CSSProperties}>
            <span className="th-kpi-label">Noise</span>
            <span className="th-kpi-value">{data.totals.noise_pct}%</span>
          </div>
          <div className="th-kpi">
            <span className="th-kpi-label">Issue types</span>
            <span className="th-kpi-value">{formatCount(data.totals.issues)}</span>
          </div>
        </div>
      )}
      {loading && !data ? (
        <div className="th-alerts-skeleton" aria-busy="true" />
      ) : (
        <div className="th-ac-table-wrap">
          <table className="th-ac-table">
            <thead>
              <tr>
                <th>Issue</th>
                <th className="text-right">Opened</th>
                <th className="text-right">Came back</th>
                <th className="text-right">Devices</th>
                <th className="text-right">False alarm</th>
                <th className="text-right">Time to owner</th>
                <th className="text-right">Time to fix</th>
                <th className="text-right">Noise</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {(data?.rows ?? []).map((row) => (
                <tr key={row.issue}>
                  <td>
                    <b>{row.title}</b>
                    <small>{row.still_open} still open</small>
                  </td>
                  <td className="text-right">{formatCount(row.opened)}</td>
                  <td className="text-right">{formatCount(row.reopened)}</td>
                  <td className="text-right">{formatCount(row.devices)}</td>
                  <td className="text-right">{formatCount(row.false_positive)}</td>
                  <td className="text-right">
                    {row.mtta_minutes != null ? `${Math.round(row.mtta_minutes)} min` : "—"}
                  </td>
                  <td className="text-right">
                    {row.mttr_minutes != null ? `${Math.round(row.mttr_minutes)} min` : "—"}
                  </td>
                  <td className="text-right">
                    <span
                      style={{
                        color:
                          row.noise_pct >= 50
                            ? "var(--th-status-critical)"
                            : row.noise_pct >= 20
                              ? "var(--th-status-warning)"
                              : undefined,
                      }}
                    >
                      {row.noise_pct}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function MutesView() {
  const { can } = useAuth();
  const { data, loading, reload } = useCachedQuery("page.alerts.mutes", () => getAlertMutes());
  const [busy, setBusy] = useState<number | null>(null);
  const rows = data ?? [];
  return (
    <div className="th-ac-view">
      <p className="th-ac-muted">
        Rules that keep matching alerts from opening. Add one from an alert's panel (“Mute rule…”).
      </p>
      {loading && !data ? (
        <div className="th-alerts-skeleton" aria-busy="true" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<BellOff className="h-5 w-5" />} title="No mute rules" description="Every alert can open." />
      ) : (
        <div className="th-ac-table-wrap">
          <table className="th-ac-table">
            <thead>
              <tr>
                <th>What</th>
                <th>Where</th>
                <th>Until</th>
                <th>Why</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>
                    <b>{m.kind ? (ALERT_KIND_LABELS[m.kind as AlertKind] ?? m.kind) : "Every alert"}</b>
                    {m.fingerprint && <small className="th-ac-mono">{m.fingerprint}</small>}
                  </td>
                  <td>{m.device_name ?? (m.client_name ? `All of ${m.client_name}` : "Every device")}</td>
                  <td>{m.until ? formatLocalDateTime(m.until) : "Until removed"}</td>
                  <td>
                    {m.reason}
                    <small>
                      {m.created_by} · {timeAgo(m.created_at)}
                    </small>
                  </td>
                  <td className="text-right">
                    {can("operator") && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === m.id}
                        onClick={async () => {
                          setBusy(m.id);
                          try {
                            await removeAlertMute(m.id);
                            await reload();
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
