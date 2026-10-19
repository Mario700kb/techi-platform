import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { BadgeCheck, Link2 } from "lucide-react";

import { getDeviceDirectory, type DeviceDirectoryEntry } from "../../api/devices";
import {
  bindRemoteSupportClient,
  getRemoteSupportClients,
  getRemoteSupportIdentitySummary,
  type RemoteSupportClient,
} from "../../api/remoteSupport";
import { useAuth } from "../../auth/AuthContext";
import { useCachedQuery } from "../../hooks/useCachedQuery";
import { formatCount } from "../../utils/number";
import { timeAgo } from "../../utils/time";
import { Button, EmptyState, Modal } from "../ui";

const spaced = (id: string | null) => (id ? id.replace(/(\d{3})(?=\d)/g, "$1 ") : "—");

/**
 * Remote Support IDs as the ID server holds them. Every TECHI Remote Support
 * client registers its ID with the platform's ID server together with its
 * machine (MachineGuid); the platform matches each device to its machine,
 * verifies or corrects its ID, and lists cloned machines that keep taking
 * each other's IDs.
 */
export default function RemoteSupportIdsView() {
  const { can } = useAuth();
  const [state, setState] = useState<"attention" | "all">("attention");
  const summary = useCachedQuery("page.alerts.rsid.summary", () => getRemoteSupportIdentitySummary());
  const clients = useCachedQuery(`page.alerts.rsid.${state}`, () => getRemoteSupportClients(state));
  const [binding, setBinding] = useState<RemoteSupportClient | null>(null);
  const s = summary.data;
  const rows = clients.data ?? [];
  return (
    <div className="th-ac-view">
      <p className="th-ac-muted">
        Every TECHI Remote Support client registers its ID with the platform's ID server, together with its machine
        (MachineGuid). The platform checks every device against it every 5 minutes: it verifies the ID, corrects one
        that changed, and lists cloned machines (copied without sysprep), which take each other's IDs.
      </p>
      {s && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="th-kpi" style={{ "--kpi-tone": "var(--th-status-online)" } as CSSProperties}>
            <span className="th-kpi-label">Verified by the ID server</span>
            <span className="th-kpi-value">
              {formatCount(s.confirmed_24h)}
              <small className="th-ac-muted"> / {formatCount(s.devices_with_id)}</small>
            </span>
            <span className="th-kpi-hint">Devices whose ID belongs to their machine</span>
          </div>
          <div className="th-kpi" style={{ "--kpi-tone": "var(--th-status-warning)" } as CSSProperties}>
            <span className="th-kpi-label">Not matched</span>
            <span className="th-kpi-value">{formatCount(s.unbound_clients_24h)}</span>
            <span className="th-kpi-hint">IDs registered in 7 days, no device found</span>
          </div>
          <div className="th-kpi" style={{ "--kpi-tone": "var(--th-status-critical)" } as CSSProperties}>
            <span className="th-kpi-label">Cloned or in conflict</span>
            <span className="th-kpi-value">{formatCount(s.attention_24h)}</span>
            <span className="th-kpi-hint">Devices on cloned machines or sharing an ID</span>
          </div>
          <div className="th-kpi" style={{ "--kpi-tone": "var(--th-status-info)" } as CSSProperties}>
            <span className="th-kpi-label">Agent reads an old ID</span>
            <span className="th-kpi-value">{formatCount(s.agent_disagrees)}</span>
            <span className="th-kpi-hint">Corrected; fixed for good by agent 2.1.34</span>
          </div>
        </div>
      )}
      <div className="th-ac-seg" role="group" aria-label="Clients">
        <button type="button" aria-pressed={state === "attention"} onClick={() => setState("attention")}>
          Need a look
        </button>
        <button type="button" aria-pressed={state === "all"} onClick={() => setState("all")}>
          All registered (7 days)
        </button>
      </div>
      {clients.loading && !clients.data ? (
        <div className="th-alerts-skeleton" aria-busy="true" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<BadgeCheck className="h-5 w-5" />} title="Every registered ID matches its device" />
      ) : (
        <div className="th-ac-table-wrap">
          <table className="th-ac-table">
            <thead>
              <tr>
                <th>Remote Support ID</th>
                <th>Reported by</th>
                <th>Device</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <b className="th-ac-mono">{spaced(c.rustdesk_id)}</b>
                    <small>last report {timeAgo(c.last_seen_at)}</small>
                  </td>
                  <td>
                    {c.hostname ?? "—"}
                    <small>{[c.username, c.source_ip, c.version].filter(Boolean).join(" · ")}</small>
                  </td>
                  <td>
                    {c.device_id != null ? (
                      <>
                        {c.device_name}
                        <small className="th-ac-mono">platform ID {spaced(c.device_rustdesk_id)}</small>
                      </>
                    ) : (
                      <span style={{ color: "var(--th-status-warning)" }}>Not matched</span>
                    )}
                  </td>
                  <td>{c.note ?? (c.device_id != null ? `Matched by ${c.bound_by?.replace("_", " ")}` : "—")}</td>
                  <td className="text-right">
                    {can("operator") && (
                      <Button size="sm" variant="secondary" onClick={() => setBinding(c)}>
                        <Link2 className="h-3.5 w-3.5" />
                        {c.device_id != null ? "Change device" : "Match to device"}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {binding && (
        <BindModal
          client={binding}
          onClose={() => setBinding(null)}
          onDone={() => {
            setBinding(null);
            void clients.reload();
            void summary.reload();
          }}
        />
      )}
    </div>
  );
}

function BindModal({
  client,
  onClose,
  onDone,
}: {
  client: RemoteSupportClient;
  onClose: () => void;
  onDone: () => void;
}) {
  const directory = useCachedQuery<DeviceDirectoryEntry[]>("mem.device.directory", () => getDeviceDirectory());
  const [query, setQuery] = useState(client.hostname ?? "");
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = directory.data ?? [];
    return (
      q ? list.filter((d) => `${d.hostname ?? ""} ${d.rustdesk_id ?? ""} ${d.id}`.toLowerCase().includes(q)) : list
    ).slice(0, 12);
  }, [directory.data, query]);
  return (
    <Modal
      title={`Match ${spaced(client.rustdesk_id)} to a device`}
      subtitle={`Reported by ${client.hostname ?? "an unknown machine"}${client.source_ip ? ` from ${client.source_ip}` : ""}. Its ID becomes the device's.`}
      icon={Link2}
      size="md"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || deviceId == null}
            onClick={async () => {
              if (deviceId == null) return;
              setBusy(true);
              setError(null);
              try {
                await bindRemoteSupportClient(client.id, deviceId);
                onDone();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Couldn't match the client.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Matching…" : "Match"}
          </Button>
        </>
      }
    >
      <div className="grid gap-2 text-[13px]">
        <input
          id="rs-bind-search"
          className="th-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search hostname, ID or device number"
          aria-label="Search devices"
        />
        <div className="grid gap-1" role="listbox" aria-label="Devices">
          {matches.map((d) => (
            <label key={d.id} className="th-ac-radio" data-checked={deviceId === d.id}>
              <input
                type="radio"
                name="rs-bind-device"
                checked={deviceId === d.id}
                onChange={() => setDeviceId(d.id)}
              />
              <span>
                <b>{d.hostname ?? `Device #${d.id}`}</b>
                <small>
                  #{d.id} · ID {spaced(d.rustdesk_id)} · {d.freshness_state}
                </small>
              </span>
            </label>
          ))}
        </div>
        {error && <p className="th-ac-error">{error}</p>}
      </div>
    </Modal>
  );
}
