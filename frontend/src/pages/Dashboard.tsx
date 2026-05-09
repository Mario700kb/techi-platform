import { useEffect, useState } from "react";
import { RefreshCcw, Wifi, WifiOff, Server, Clock3, CheckCircle2, AlertTriangle } from "lucide-react";
import { getDevicesCount } from "../api/devices";
import { getRecentDeployments, RecentDeployment } from "../api/deployments";
import { Badge, Button } from "../components/ui";

const formatDate = (iso?: string) => {
  if (!iso) return "Unknown";
  const date = new Date(iso);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const statusColor = (status: RecentDeployment["status"]) => {
  if (status === "success") return "bg-emerald-500 text-emerald-900";
  if (status === "warning") return "bg-amber-500 text-amber-900";
  return "bg-rose-500 text-rose-900";
};

export default function Dashboard() {
  const [total, setTotal] = useState(0);
  const [online, setOnline] = useState(0);
  const [offline, setOffline] = useState(0);
  const [deployments, setDeployments] = useState<RecentDeployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = async () => {
    try {
      setLoading(true);
      setError(null);
      const [totalCount, onlineCount, offlineCount, recentDeployments] = await Promise.all([
        getDevicesCount(),
        getDevicesCount({ status: "online" }),
        getDevicesCount({ status: "offline" }),
        getRecentDeployments(),
      ]);

      setTotal(totalCount);
      setOnline(onlineCount);
      setOffline(offlineCount);
      setDeployments(recentDeployments.slice(0, 4));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load dashboard data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDashboard();
  }, []);

  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-techi-orange">Mission control</p>
            <h1 className="mt-3 text-3xl font-semibold text-white">Techi remote dashboard</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-400">
              A compact operations view for device health, deployments, and recent activity. Everything is powered by your existing device model and backend API.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={loadDashboard}>
              <RefreshCcw className="h-4 w-4" />
              Refresh
            </Button>
            <Badge variant="ghost">Phase 3 UI</Badge>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
          <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Total devices</p>
          <p className="mt-4 text-4xl font-semibold text-white">{loading ? "—" : total}</p>
          <div className="mt-4 flex items-center gap-3 text-sm text-slate-400">
            <Wifi className="h-4 w-4 text-emerald-400" />
            Online endpoints
          </div>
          <div className="mt-3 text-2xl font-semibold text-emerald-300">{loading ? "—" : online}</div>
        </div>

        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
          <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Service health</p>
          <div className="mt-4 flex items-center gap-3">
            <WifiOff className="h-5 w-5 text-slate-300" />
            <span className="text-lg text-white">Offline devices</span>
          </div>
          <p className="mt-4 text-4xl font-semibold text-slate-200">{loading ? "—" : offline}</p>
          <p className="mt-3 text-sm text-slate-400">Monitored with the latest sync pass.</p>
        </div>

        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
          <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Deployment cadence</p>
          <div className="mt-4 flex items-center gap-3">
            <Server className="h-5 w-5 text-slate-300" />
            <span className="text-lg text-white">Recent updates</span>
          </div>
          <p className="mt-4 text-4xl font-semibold text-white">{loading ? "—" : deployments.length}</p>
          <p className="mt-3 text-sm text-slate-400">Latest deployments from the backend.</p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Status chart</p>
              <h2 className="mt-3 text-2xl font-semibold text-white">Device availability</h2>
            </div>
            <Badge variant="ghost">Live insights</Badge>
          </div>

          <div className="mt-8 space-y-4">
            {[
              { label: "Online", value: online, color: "bg-emerald-400" },
              { label: "Offline", value: offline, color: "bg-slate-500" },
            ].map((item) => (
              <div key={item.label} className="space-y-2">
                <div className="flex items-center justify-between text-sm text-slate-300">
                  <span>{item.label}</span>
                  <span>{loading ? "—" : item.value}</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-white/5">
                  <div
                    className={`${item.color} h-full rounded-full transition-all duration-300`}
                    style={{ width: loading ? "0%" : `${total > 0 ? (item.value / total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8 rounded-3xl bg-slate-900/60 p-4 text-sm text-slate-300">
            <div className="flex items-center gap-2 text-slate-200">
              <Clock3 className="h-4 w-4" />
              <span>Latest update</span>
            </div>
            <p className="mt-3 leading-6">
              Device status updates are refreshed each time the dashboard is loaded. Use the refreshed data to triage offline or unresponsive clients.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Recent deployments</p>
                <h2 className="mt-3 text-2xl font-semibold text-white">Latest activity</h2>
              </div>
              <Badge variant="ghost">API driven</Badge>
            </div>

            <div className="mt-6 space-y-4">
              {loading ? (
                <p className="text-sm text-slate-400">Loading deployments...</p>
              ) : error ? (
                <p className="text-sm text-rose-300">{error}</p>
              ) : (
                deployments.map((deployment) => (
                  <div key={deployment.id} className="rounded-3xl border border-white/10 bg-slate-900/80 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-semibold text-white">{deployment.title}</p>
                        <p className="mt-1 text-sm text-slate-400">{formatDate(deployment.timestamp)}</p>
                      </div>
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusColor(deployment.status)}`}>
                        {deployment.status}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-2 text-sm text-slate-400">
                      <Server className="h-4 w-4" />
                      <span>{deployment.environment}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Recent actions</p>
                <h2 className="mt-3 text-2xl font-semibold text-white">Operational log</h2>
              </div>
              <Badge variant="secondary">Realtime</Badge>
            </div>

            <div className="mt-6 space-y-3 text-sm text-slate-400">
              <div className="flex items-start gap-3 rounded-3xl border border-white/10 bg-slate-900/70 p-4">
                <CheckCircle2 className="mt-1 h-5 w-5 text-emerald-300" />
                <div>
                  <p className="font-semibold text-white">Synchronized 12 devices</p>
                  <p className="mt-1">Active device list refreshed from backend.</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-3xl border border-white/10 bg-slate-900/70 p-4">
                <AlertTriangle className="mt-1 h-5 w-5 text-amber-300" />
                <div>
                  <p className="font-semibold text-white">1 offline client detected</p>
                  <p className="mt-1">Review the device tree to isolate the offline endpoint.</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-3xl border border-white/10 bg-slate-900/70 p-4">
                <Wifi className="mt-1 h-5 w-5 text-emerald-300" />
                <div>
                  <p className="font-semibold text-white">Telemetry updated</p>
                  <p className="mt-1">Device health metrics are ready for the next phase.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
