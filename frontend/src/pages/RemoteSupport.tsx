import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ClipboardCopy,
  Download,
  ExternalLink,
  KeyRound,
  Monitor,
  RefreshCcw,
  Search,
  Settings2,
  Wifi,
  WifiOff,
  Wrench,
} from "lucide-react";
import {
  getRemoteSupportDevices,
  getConnectUrl,
  restartRemoteSupportService,
  repairRemoteSupportConfig,
  deployRemoteSupport,
  getRemoteSupportPassword,
  setRemoteSupportPassword,
  regenerateRemoteSupportPassword,
  RemoteSupportDevice,
  RemoteSupportStatus,
} from "../api/remoteSupport";
import { usePollingRefresh } from "../hooks/usePollingRefresh";
import { useAppData } from "../contexts/AppDataContext";
import { useAuth } from "../auth/AuthContext";
import { RemoteSupportMobileList } from "../components/mobile/RemoteSupportMobileList";

// ------------------------------------------------------------------ //
// Status helpers                                                       //
// ------------------------------------------------------------------ //

const STATUS_CONFIG: Record<
  RemoteSupportStatus,
  { label: string; color: string; bg: string; icon: typeof Wifi }
> = {
  online: {
    label: "Online",
    color: "var(--th-status-online)",
    bg: "color-mix(in srgb, var(--th-status-online) 12%, transparent)",
    icon: Wifi,
  },
  warning: {
    label: "Warning",
    color: "var(--th-accent)",
    bg: "color-mix(in srgb, var(--th-accent) 12%, transparent)",
    icon: AlertTriangle,
  },
  offline: {
    label: "Offline",
    color: "var(--th-status-offline)",
    bg: "color-mix(in srgb, var(--th-status-offline) 12%, transparent)",
    icon: WifiOff,
  },
};

function StatusBadge({ status }: { status: RemoteSupportStatus }) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={{ color: cfg.color, background: cfg.bg }}
    >
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}

function ServiceBadge({ status }: { status: string }) {
  const isRunning = status === "running";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{
        color: isRunning ? "var(--th-status-online)" : "var(--th-status-offline)",
        background: isRunning ? "color-mix(in srgb, var(--th-status-online) 10%, transparent)" : "color-mix(in srgb, var(--th-status-offline) 10%, transparent)",
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: isRunning ? "var(--th-status-online)" : "var(--th-status-offline)" }}
      />
      {isRunning ? "Running" : status === "stopped" ? "Stopped" : status}
    </span>
  );
}

function DeviceTypeBadge({ type }: { type?: string }) {
  const isServer = type === "server";
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{
        color: isServer ? "var(--th-status-agent)" : "var(--th-status-info)",
        background: isServer ? "color-mix(in srgb, var(--th-status-agent) 10%, transparent)" : "color-mix(in srgb, var(--th-status-info) 10%, transparent)",
      }}
    >
      {isServer ? "Server" : type === "client" ? "Workstation" : type ?? "—"}
    </span>
  );
}

function formatLastSeen(ts?: string): string {
  if (!ts) return "Never";
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ------------------------------------------------------------------ //
// Main component                                                       //
// ------------------------------------------------------------------ //

type ActionState = "idle" | "loading" | "success" | "error";

interface DeviceActionState {
  connect: ActionState;
  restart: ActionState;
  repair: ActionState;
  deploy: ActionState;
}

const defaultActionState = (): DeviceActionState => ({
  connect: "idle",
  restart: "idle",
  repair: "idle",
  deploy: "idle",
});

export default function RemoteSupport() {
  const { can } = useAuth();
  const { latestEvent } = useAppData();
  const isOperator = can("operator");

  const [devices, setDevices] = useState<RemoteSupportDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<RemoteSupportStatus | "all">("all");
  const [actionStates, setActionStates] = useState<Record<number, DeviceActionState>>({});
  const [toasts, setToasts] = useState<{ id: number; message: string; ok: boolean }[]>([]);
  const toastCounter = useState(0);
  const [passwordModal, setPasswordModal] = useState<{
    device: RemoteSupportDevice;
    password: string;
    source?: string;
    loading: boolean;
    custom: string;
    saving: boolean;
  } | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      const data = await getRemoteSupportDevices({ limit: 500 });
      setDevices(data);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load devices");
    } finally {
      setLoading(false);
    }
  }, []);

  const { runNow } = usePollingRefresh(loadDevices, { intervalMs: 30000, immediate: true });

  useEffect(() => {
    if (
      latestEvent?.type === "rustdesk_updated" ||
      latestEvent?.type === "rustdesk_online" ||
      latestEvent?.type === "rustdesk_offline"
    ) {
      void runNow();
    }
  }, [latestEvent, runNow]);

  const addToast = useCallback((message: string, ok: boolean) => {
    const id = ++toastCounter[0];
    setToasts((prev) => [...prev, { id, message, ok }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, [toastCounter]);

  const setDeviceAction = (deviceId: number, key: keyof DeviceActionState, state: ActionState) => {
    setActionStates((prev) => ({
      ...prev,
      [deviceId]: { ...(prev[deviceId] ?? defaultActionState()), [key]: state },
    }));
  };

  const handleConnect = useCallback(
    async (device: RemoteSupportDevice) => {
      if (!device.techi_remote_id) {
        addToast("Device has no TECHI Remote ID", false);
        return;
      }
      setDeviceAction(device.device_id, "connect", "loading");
      try {
        const res = await getConnectUrl(device.device_id);
        window.location.href = res.connect_url;
        setDeviceAction(device.device_id, "connect", "success");
      } catch (e: unknown) {
        addToast(e instanceof Error ? e.message : "Connect failed", false);
        setDeviceAction(device.device_id, "connect", "error");
        setTimeout(() => setDeviceAction(device.device_id, "connect", "idle"), 2000);
      }
    },
    [addToast]
  );

  const handleCopyId = useCallback(
    async (device: RemoteSupportDevice) => {
      if (!device.techi_remote_id) return;
      try {
        await navigator.clipboard.writeText(device.techi_remote_id);
        addToast(`Copied: ${device.techi_remote_id}`, true);
      } catch {
        addToast("Clipboard copy failed", false);
      }
    },
    [addToast]
  );

  const openPasswordModal = useCallback(
    async (device: RemoteSupportDevice) => {
      setPasswordModal({ device, password: "", loading: true, custom: "", saving: false });
      try {
        const res = await getRemoteSupportPassword(device.device_id);
        setPasswordModal((m) => (m && m.device.device_id === device.device_id
          ? { ...m, password: res.password, source: res.source ?? undefined, loading: false }
          : m));
      } catch (e: unknown) {
        addToast(e instanceof Error ? e.message : "Failed to load password", false);
        setPasswordModal(null);
      }
    },
    [addToast]
  );

  const handleRegeneratePassword = useCallback(async () => {
    setPasswordModal((m) => (m ? { ...m, saving: true } : m));
    const dev = passwordModal?.device;
    if (!dev) return;
    try {
      const res = await regenerateRemoteSupportPassword(dev.device_id);
      setPasswordModal((m) => (m ? { ...m, password: res.password, source: "generated", saving: false } : m));
      addToast("New password generated — applied on next heartbeat", true);
    } catch (e: unknown) {
      addToast(e instanceof Error ? e.message : "Regenerate failed", false);
      setPasswordModal((m) => (m ? { ...m, saving: false } : m));
    }
  }, [addToast, passwordModal?.device]);

  const handleSetCustomPassword = useCallback(async () => {
    const dev = passwordModal?.device;
    const custom = passwordModal?.custom?.trim() ?? "";
    if (!dev || custom.length < 8) {
      addToast("Password must be at least 8 characters", false);
      return;
    }
    setPasswordModal((m) => (m ? { ...m, saving: true } : m));
    try {
      const res = await setRemoteSupportPassword(dev.device_id, custom);
      setPasswordModal((m) => (m ? { ...m, password: res.password, source: "custom", custom: "", saving: false } : m));
      addToast("Custom password set — applied on next heartbeat", true);
    } catch (e: unknown) {
      addToast(e instanceof Error ? e.message : "Set password failed", false);
      setPasswordModal((m) => (m ? { ...m, saving: false } : m));
    }
  }, [addToast, passwordModal?.device, passwordModal?.custom]);

  const handleRestart = useCallback(
    async (device: RemoteSupportDevice) => {
      setDeviceAction(device.device_id, "restart", "loading");
      try {
        await restartRemoteSupportService(device.device_id);
        addToast(`Restart queued for ${device.hostname ?? device.device_id}`, true);
        setDeviceAction(device.device_id, "restart", "success");
        setTimeout(() => setDeviceAction(device.device_id, "restart", "idle"), 3000);
      } catch (e: unknown) {
        addToast(e instanceof Error ? e.message : "Restart failed", false);
        setDeviceAction(device.device_id, "restart", "error");
        setTimeout(() => setDeviceAction(device.device_id, "restart", "idle"), 2000);
      }
    },
    [addToast]
  );

  const handleRepair = useCallback(
    async (device: RemoteSupportDevice) => {
      setDeviceAction(device.device_id, "repair", "loading");
      try {
        await repairRemoteSupportConfig(device.device_id);
        addToast(`Config repair queued for ${device.hostname ?? device.device_id}`, true);
        setDeviceAction(device.device_id, "repair", "success");
        setTimeout(() => setDeviceAction(device.device_id, "repair", "idle"), 3000);
      } catch (e: unknown) {
        addToast(e instanceof Error ? e.message : "Repair failed", false);
        setDeviceAction(device.device_id, "repair", "error");
        setTimeout(() => setDeviceAction(device.device_id, "repair", "idle"), 2000);
      }
    },
    [addToast]
  );

  const handleDeploy = useCallback(
    async (device: RemoteSupportDevice) => {
      setDeviceAction(device.device_id, "deploy", "loading");
      try {
        await deployRemoteSupport(device.device_id);
        addToast(`Deploy queued for ${device.hostname ?? device.device_id}`, true);
        setDeviceAction(device.device_id, "deploy", "success");
        setTimeout(() => setDeviceAction(device.device_id, "deploy", "idle"), 3000);
      } catch (e: unknown) {
        addToast(e instanceof Error ? e.message : "Deploy failed", false);
        setDeviceAction(device.device_id, "deploy", "error");
        setTimeout(() => setDeviceAction(device.device_id, "deploy", "idle"), 2000);
      }
    },
    [addToast]
  );

  // ---------------------------------------------------------------- //
  // Filtering & grouping                                              //
  // ---------------------------------------------------------------- //

  const filtered = useMemo(() => {
    let list = devices;
    if (statusFilter !== "all") list = list.filter((d) => d.remote_support_status === statusFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (d) =>
          d.hostname?.toLowerCase().includes(q) ||
          d.current_user?.toLowerCase().includes(q) ||
          d.domain?.toLowerCase().includes(q) ||
          d.techi_remote_id?.toLowerCase().includes(q) ||
          d.public_ip?.includes(q)
      );
    }
    return list;
  }, [devices, statusFilter, search]);

  const grouped = useMemo(() => {
    const map: Record<string, RemoteSupportDevice[]> = {};
    for (const d of filtered) {
      const domain = d.domain?.trim() || "No Domain";
      if (!map[domain]) map[domain] = [];
      map[domain].push(d);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const counts = useMemo(
    () => ({
      total: devices.length,
      online: devices.filter((d) => d.remote_support_status === "online").length,
      warning: devices.filter((d) => d.remote_support_status === "warning").length,
      offline: devices.filter((d) => d.remote_support_status === "offline").length,
    }),
    [devices]
  );

  // ---------------------------------------------------------------- //
  // Render                                                            //
  // ---------------------------------------------------------------- //

  return (
    <>
      {/* Mobile Remote Support (Mobile UI 2.0 — MOBILE-DESIGN-SPEC.md,
          Remote Support). Reuses the same filtered device list, search
          state and action handlers as the desktop view below. */}
      <div className="md:hidden">
        <RemoteSupportMobileList
          devices={filtered}
          loading={loading}
          error={error}
          search={search}
          onSearchChange={setSearch}
          actionStates={actionStates}
          onConnect={(d) => void handleConnect(d)}
          onRepair={(d) => void handleRepair(d)}
          onRestart={(d) => void handleRestart(d)}
          onRetry={() => void runNow()}
        />
      </div>

      {/* Desktop Remote Support — unchanged below */}
      <div className="hidden md:block">
        {loading ? (
          <div className="flex h-64 items-center justify-center">
            <Activity className="h-6 w-6 animate-spin" style={{ color: "var(--th-text-muted)" }} />
          </div>
        ) : (
    <section className="space-y-5">
      {/* Toasts */}
      <div className="fixed right-4 top-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg"
            style={{
              background: t.ok ? "color-mix(in srgb, var(--th-status-online) 15%, transparent)" : "color-mix(in srgb, var(--th-status-critical) 15%, transparent)",
              border: `1px solid ${t.ok ? "color-mix(in srgb, var(--th-status-online) 30%, transparent)" : "color-mix(in srgb, var(--th-status-critical) 30%, transparent)"}`,
              color: t.ok ? "var(--th-status-online)" : "var(--th-status-critical)",
            }}
          >
            {t.message}
          </div>
        ))}
      </div>

      {/* Per-device Remote Support password modal */}
      {passwordModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => setPasswordModal(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl p-6"
            style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center gap-2">
              <KeyRound className="h-4 w-4" style={{ color: "var(--techi-orange, var(--th-status-warning))" }} />
              <h3 className="text-base font-semibold" style={{ color: "var(--th-text)" }}>
                Remote Support Password
              </h3>
            </div>
            <p className="mb-3 text-xs" style={{ color: "var(--th-text-muted)" }}>
              {passwordModal.device.hostname ?? `Device ${passwordModal.device.device_id}`}
              {passwordModal.source ? ` · ${passwordModal.source}` : ""}
            </p>

            <div className="mb-4 flex items-center gap-2">
              <input
                readOnly
                value={passwordModal.loading ? "Loading…" : passwordModal.password}
                className="flex-1 rounded-lg px-3 py-2 font-mono text-sm"
                style={{ background: "var(--th-bg-input, rgba(0,0,0,0.2))", border: "1px solid var(--th-border-card)", color: "var(--th-text)" }}
              />
              <button
                type="button"
                disabled={passwordModal.loading || !passwordModal.password}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(passwordModal.password);
                    addToast("Password copied", true);
                  } catch {
                    addToast("Copy failed", false);
                  }
                }}
                className="rounded-lg px-3 py-2 text-sm font-medium"
                style={{ background: "var(--th-bg-input, rgba(0,0,0,0.2))", border: "1px solid var(--th-border-card)", color: "var(--th-text)" }}
                title="Copy password"
              >
                <ClipboardCopy className="h-4 w-4" />
              </button>
            </div>

            {isOperator && (
              <>
                <button
                  type="button"
                  disabled={passwordModal.saving}
                  onClick={handleRegeneratePassword}
                  className="mb-3 w-full rounded-lg px-3 py-2 text-sm font-medium"
                  style={{ background: "color-mix(in srgb, var(--th-status-warning) 15%, transparent)", border: "1px solid color-mix(in srgb, var(--th-status-warning) 30%, transparent)", color: "var(--th-status-warning)" }}
                >
                  {passwordModal.saving ? "Working…" : "Generate new random password"}
                </button>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Set custom password (min 8)"
                    value={passwordModal.custom}
                    onChange={(e) => setPasswordModal((m) => (m ? { ...m, custom: e.target.value } : m))}
                    className="flex-1 rounded-lg px-3 py-2 text-sm"
                    style={{ background: "var(--th-bg-input, rgba(0,0,0,0.2))", border: "1px solid var(--th-border-card)", color: "var(--th-text)" }}
                  />
                  <button
                    type="button"
                    disabled={passwordModal.saving || passwordModal.custom.trim().length < 8}
                    onClick={handleSetCustomPassword}
                    className="rounded-lg px-3 py-2 text-sm font-medium"
                    style={{ background: "var(--techi-orange, var(--th-status-warning))", color: "#fff" }}
                  >
                    Set
                  </button>
                </div>
              </>
            )}

            <p className="mt-4 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
              Unique per device. Applied to Remote Support on the next agent heartbeat
              (agents &lt; 2.1.5 still use the legacy password until upgraded).
            </p>

            <button
              type="button"
              onClick={() => setPasswordModal(null)}
              className="mt-4 w-full rounded-lg px-3 py-2 text-sm font-medium"
              style={{ background: "var(--th-bg-input, rgba(0,0,0,0.2))", border: "1px solid var(--th-border-card)", color: "var(--th-text)" }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div
        className="rounded-2xl px-6 py-5"
        style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-xl"
              style={{ background: "color-mix(in srgb, var(--th-accent) 12%, transparent)" }}
            >
              <Monitor className="h-5 w-5" style={{ color: "var(--th-accent)" }} />
            </div>
            <div>
              <h1 className="text-lg font-semibold" style={{ color: "var(--th-text-primary)" }}>
                Remote Support
              </h1>
              <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                TECHI Remote Support — {counts.total} devices
              </p>
            </div>
          </div>
          <button
            onClick={runNow}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            style={{
              background: "var(--th-btn-secondary-bg)",
              border: "1px solid var(--th-border-input)",
              color: "var(--th-text-secondary)",
            }}
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        {/* Stats */}
        <div className="mt-4 flex flex-wrap gap-3">
          {(["all", "online", "warning", "offline"] as const).map((s) => {
            const count = s === "all" ? counts.total : counts[s];
            const cfg = s === "all" ? null : STATUS_CONFIG[s];
            const isActive = statusFilter === s;
            return (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className="flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-all"
                style={{
                  background: isActive
                    ? cfg
                      ? cfg.bg
                      : "color-mix(in srgb, var(--th-accent) 12%, transparent)"
                    : "var(--th-bg-elevated, color-mix(in srgb, var(--th-text-primary) 3%, transparent))",
                  border: `1px solid ${isActive ? (cfg ? cfg.color + "44" : "#f9731644") : "var(--th-border-subtle)"}`,
                  color: isActive ? (cfg ? cfg.color : "var(--th-accent)") : "var(--th-text-muted)",
                }}
              >
                {cfg && <cfg.icon className="h-3 w-3" />}
                {s === "all" ? "All" : STATUS_CONFIG[s].label}
                <span
                  className="rounded-full px-1.5 py-0.5 text-[10px]"
                  style={{
                    background: isActive
                      ? cfg
                        ? cfg.color + "22"
                        : "color-mix(in srgb, var(--th-accent) 15%, transparent)"
                      : "color-mix(in srgb, var(--th-text-primary) 6%, transparent)",
                    color: isActive ? (cfg ? cfg.color : "var(--th-accent)") : "var(--th-text-muted)",
                  }}
                >
                  {count}
                </span>
              </button>
            );
          })}

          {/* Search */}
          <div className="relative ml-auto flex items-center">
            <Search
              className="pointer-events-none absolute left-2.5 h-3.5 w-3.5"
              style={{ color: "var(--th-text-muted)" }}
            />
            <input
              className="th-input rounded-lg py-1.5 pl-8 pr-3 text-xs"
              placeholder="Search hostname, user, domain, ID..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 260 }}
            />
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div
          className="rounded-xl px-4 py-3 text-sm"
          style={{
            background: "color-mix(in srgb, var(--th-status-critical) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--th-status-critical) 20%, transparent)",
            color: "var(--th-status-critical)",
          }}
        >
          {error}
        </div>
      )}

      {/* Table */}
      {filtered.length === 0 ? (
        <div
          className="rounded-2xl p-12 text-center text-sm"
          style={{
            background: "var(--th-bg-card)",
            border: "1px solid var(--th-border-card)",
            color: "var(--th-text-muted)",
          }}
        >
          No devices found
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([domain, domainDevices]) => (
            <div
              key={domain}
              className="overflow-hidden rounded-2xl"
              style={{ border: "1px solid var(--th-border-card)", background: "var(--th-bg-card)" }}
            >
              {/* Domain header */}
              <div
                className="flex items-center gap-2 px-4 py-2.5 text-xs font-semibold uppercase tracking-widest"
                style={{
                  background: "var(--th-bg-table-head, color-mix(in srgb, var(--th-text-primary) 3%, transparent))",
                  borderBottom: "1px solid var(--th-border-subtle)",
                  color: "var(--th-text-muted)",
                }}
              >
                <span style={{ color: "var(--th-accent)" }}>◆</span>
                {domain}
                <span
                  className="ml-1 rounded-full px-2 py-0.5 text-[10px]"
                  style={{ background: "color-mix(in srgb, var(--th-accent) 10%, transparent)", color: "var(--th-accent)" }}
                >
                  {domainDevices.length}
                </span>
              </div>

              {/* Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr
                      style={{
                        background: "var(--th-bg-table-head, color-mix(in srgb, var(--th-text-primary) 2%, transparent))",
                        borderBottom: "1px solid var(--th-border-subtle)",
                      }}
                    >
                      {[
                        "Device",
                        "User",
                        "Remote ID",
                        "Status",
                        "Service",
                        "Type",
                        "Last Seen",
                        "Version",
                        "Public IP",
                        "Local IP",
                        "Actions",
                      ].map((h) => (
                        <th
                          key={h}
                          className="px-3 py-2.5 text-left font-semibold uppercase tracking-wider"
                          style={{ color: "var(--th-text-muted)", fontSize: 10 }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...domainDevices]
                      .sort((a, b) => {
                        const order = { online: 0, warning: 1, offline: 2 };
                        return (
                          (order[a.remote_support_status] ?? 3) -
                          (order[b.remote_support_status] ?? 3)
                        );
                      })
                      .map((device, idx) => {
                        const acts = actionStates[device.device_id] ?? defaultActionState();
                        const canConnect = !!device.techi_remote_id;

                        return (
                          <tr
                            key={device.device_id}
                            style={{
                              background:
                                idx % 2 === 0
                                  ? "var(--th-bg-table-row, transparent)"
                                  : "color-mix(in srgb, var(--th-text-primary) 1%, transparent)",
                              borderBottom: "1px solid var(--th-border-subtle)",
                            }}
                          >
                            {/* Device name */}
                            <td className="px-3 py-2.5">
                              <span
                                className="font-semibold"
                                style={{ color: "var(--th-text-primary)" }}
                              >
                                {device.hostname ?? `Device #${device.device_id}`}
                              </span>
                            </td>

                            {/* User */}
                            <td className="px-3 py-2.5" style={{ color: "var(--th-text-secondary)" }}>
                              {device.current_user ?? "—"}
                            </td>

                            {/* Remote ID */}
                            <td className="px-3 py-2.5">
                              {device.techi_remote_id ? (
                                <span
                                  className="font-mono text-[11px]"
                                  style={{ color: "var(--th-accent)" }}
                                >
                                  {device.techi_remote_id}
                                </span>
                              ) : (
                                <span style={{ color: "var(--th-text-muted)" }}>—</span>
                              )}
                            </td>

                            {/* Status */}
                            <td className="px-3 py-2.5">
                              <StatusBadge status={device.remote_support_status} />
                            </td>

                            {/* Service */}
                            <td className="px-3 py-2.5">
                              <ServiceBadge status={device.service_status} />
                            </td>

                            {/* Type */}
                            <td className="px-3 py-2.5">
                              <DeviceTypeBadge type={device.device_type} />
                            </td>

                            {/* Last seen */}
                            <td
                              className="px-3 py-2.5"
                              style={{ color: "var(--th-text-muted)", fontVariantNumeric: "tabular-nums" }}
                            >
                              {formatLastSeen(device.last_seen)}
                            </td>

                            {/* Version */}
                            <td
                              className="px-3 py-2.5 font-mono text-[10px]"
                              style={{ color: "var(--th-text-muted)" }}
                            >
                              {device.app_version ?? "—"}
                            </td>

                            {/* Public IP */}
                            <td
                              className="px-3 py-2.5 font-mono text-[11px]"
                              style={{ color: "var(--th-text-secondary)" }}
                            >
                              {device.public_ip ?? "—"}
                            </td>

                            {/* Local IP */}
                            <td
                              className="px-3 py-2.5 font-mono text-[11px]"
                              style={{ color: "var(--th-text-muted)" }}
                            >
                              {device.local_ip ?? "—"}
                            </td>

                            {/* Actions */}
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1.5">
                                {/* Connect */}
                                <ActionButton
                                  label="Connect"
                                  icon={<ExternalLink className="h-3 w-3" />}
                                  disabled={!canConnect || acts.connect === "loading"}
                                  loading={acts.connect === "loading"}
                                  variant="primary"
                                  onClick={() => handleConnect(device)}
                                  title={
                                    !device.techi_remote_id
                                      ? "No Remote ID"
                                    : device.remote_support_status === "offline"
                                      ? "Agent heartbeat offline — try remote session"
                                      : "Open remote session"
                                  }
                                />

                                {/* Copy ID */}
                                {device.techi_remote_id && (
                                  <ActionButton
                                    label=""
                                    icon={<ClipboardCopy className="h-3 w-3" />}
                                    onClick={() => handleCopyId(device)}
                                    title="Copy Remote ID"
                                  />
                                )}

                                {/* Per-device password */}
                                <ActionButton
                                  label=""
                                  icon={<KeyRound className="h-3 w-3" />}
                                  onClick={() => openPasswordModal(device)}
                                  title="View / set the per-device Remote Support password"
                                />

                                {/* Restart — operator+ */}
                                {isOperator && (
                                  <ActionButton
                                    label=""
                                    icon={<RefreshCcw className="h-3 w-3" />}
                                    disabled={acts.restart === "loading"}
                                    loading={acts.restart === "loading"}
                                    onClick={() => handleRestart(device)}
                                    title="Restart TECHI Remote Support service"
                                  />
                                )}

                                {/* Repair — operator+ */}
                                {isOperator && (
                                  <ActionButton
                                    label=""
                                    icon={<Wrench className="h-3 w-3" />}
                                    disabled={acts.repair === "loading"}
                                    loading={acts.repair === "loading"}
                                    onClick={() => handleRepair(device)}
                                    title="Repair Remote Support config (rewrites TOML + restart)"
                                  />
                                )}

                                {/* Deploy / Upgrade — operator+ */}
                                {isOperator && (
                                  <ActionButton
                                    label="Deploy"
                                    icon={<Download className="h-3 w-3" />}
                                    disabled={acts.deploy === "loading"}
                                    loading={acts.deploy === "loading"}
                                    onClick={() => handleDeploy(device)}
                                    title="Deploy / upgrade TECHI Remote Support to latest version"
                                  />
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ //
// Reusable small button                                                //
// ------------------------------------------------------------------ //

interface ActionButtonProps {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: "default" | "primary";
  title?: string;
}

function ActionButton({
  label,
  icon,
  onClick,
  disabled = false,
  loading = false,
  variant = "default",
  title,
}: ActionButtonProps) {
  const isPrimary = variant === "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition-all"
      style={{
        background: disabled
          ? "color-mix(in srgb, var(--th-text-primary) 3%, transparent)"
          : isPrimary
          ? "color-mix(in srgb, var(--th-accent) 15%, transparent)"
          : "color-mix(in srgb, var(--th-text-primary) 5%, transparent)",
        border: `1px solid ${disabled ? "var(--th-border-subtle)" : isPrimary ? "color-mix(in srgb, var(--th-accent) 30%, transparent)" : "var(--th-border-subtle)"}`,
        color: disabled
          ? "var(--th-text-muted)"
          : isPrimary
          ? "var(--th-accent)"
          : "var(--th-text-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {loading ? (
        <Settings2 className="h-3 w-3 animate-spin" />
      ) : (
        icon
      )}
      {label && <span>{label}</span>}
    </button>
  );
}
