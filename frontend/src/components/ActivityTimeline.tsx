import { Activity, AlertTriangle, Archive, CheckCircle, ClipboardList, FilePenLine, Monitor, RefreshCcw, RotateCcw, ShieldAlert, Wifi, WifiOff, Wrench } from "lucide-react";
import type { ComponentType } from "react";
import { ActivityEvent, ActivityEventType } from "../types/activity";
import { timeAgo } from "../utils/time";

interface ActivityTimelineProps {
  events: ActivityEvent[];
  loading: boolean;
  onReload?: () => void;
}

interface EventConfig {
  icon: ComponentType<{ className?: string }>;
  color: string;
  iconClass: string;
  bg: string;
  border: string;
}

const EVENT_CONFIG: Record<ActivityEventType, EventConfig> = {
  heartbeat_received: { icon: Activity,      color: "text-emerald-400", iconClass: "text-emerald-400", bg: "bg-emerald-400/[0.08]",  border: "border-emerald-400/20" },
  device_online:     { icon: Wifi,           color: "text-emerald-400", iconClass: "text-emerald-400", bg: "bg-emerald-400/[0.08]",  border: "border-emerald-400/20" },
  device_offline:    { icon: WifiOff,        color: "text-slate-400",   iconClass: "text-slate-500",   bg: "bg-slate-700/20",        border: "border-slate-600/25"   },
  rustdesk_updated:  { icon: Monitor,        color: "text-orange-400",  iconClass: "text-orange-400",  bg: "bg-orange-400/[0.07]",   border: "border-orange-400/20"  },
  rustdesk_repaired: { icon: Wrench,         color: "text-emerald-400", iconClass: "text-emerald-400", bg: "bg-emerald-400/[0.08]",  border: "border-emerald-400/20" },
  sync_failed:       { icon: AlertTriangle,  color: "text-red-400",     iconClass: "text-red-400",     bg: "bg-red-400/[0.07]",      border: "border-red-400/20"     },
  device_updated:    { icon: RefreshCcw,     color: "text-blue-400",    iconClass: "text-blue-400",    bg: "bg-blue-400/[0.07]",     border: "border-blue-400/20"    },
  reconnect_detected:{ icon: Wifi,           color: "text-amber-400",   iconClass: "text-amber-400",   bg: "bg-amber-400/[0.07]",    border: "border-amber-400/20"   },
  health_warning:    { icon: AlertTriangle,  color: "text-amber-400",   iconClass: "text-amber-400",   bg: "bg-amber-400/[0.07]",    border: "border-amber-400/20"   },
  health_critical:   { icon: ShieldAlert,    color: "text-red-400",     iconClass: "text-red-400",     bg: "bg-red-400/[0.07]",      border: "border-red-400/20"     },
  health_recovered:  { icon: CheckCircle,    color: "text-emerald-400", iconClass: "text-emerald-400", bg: "bg-emerald-400/[0.08]",  border: "border-emerald-400/20" },
  device_registered: { icon: Monitor,        color: "text-emerald-400", iconClass: "text-emerald-400", bg: "bg-emerald-400/[0.08]",  border: "border-emerald-400/20" },
  device_reenrolled: { icon: RefreshCcw,     color: "text-blue-300",    iconClass: "text-blue-400",    bg: "bg-blue-400/[0.07]",     border: "border-blue-400/20"    },
  assignment_changed:{ icon: ClipboardList,  color: "text-blue-400",    iconClass: "text-blue-400",    bg: "bg-blue-400/[0.07]",     border: "border-blue-400/20"    },
  device_archived:   { icon: Archive,        color: "text-amber-400",   iconClass: "text-amber-400",   bg: "bg-amber-400/[0.07]",    border: "border-amber-400/20"   },
  device_restored:   { icon: RotateCcw,      color: "text-emerald-400", iconClass: "text-emerald-400", bg: "bg-emerald-400/[0.08]",  border: "border-emerald-400/20" },
  maintenance_entered:{ icon: Wrench,        color: "text-amber-400",   iconClass: "text-amber-400",   bg: "bg-amber-400/[0.07]",    border: "border-amber-400/20"   },
  maintenance_cleared:{ icon: Wrench,        color: "text-emerald-400", iconClass: "text-emerald-400", bg: "bg-emerald-400/[0.08]",  border: "border-emerald-400/20" },
  action_queued:     { icon: Activity,       color: "text-blue-400",    iconClass: "text-blue-400",    bg: "bg-blue-400/[0.07]",     border: "border-blue-400/20"    },
  action_completed:  { icon: CheckCircle,    color: "text-emerald-400", iconClass: "text-emerald-400", bg: "bg-emerald-400/[0.08]",  border: "border-emerald-400/20" },
  action_failed:     { icon: AlertTriangle,  color: "text-red-400",     iconClass: "text-red-400",     bg: "bg-red-400/[0.07]",      border: "border-red-400/20"     },
  note_added:        { icon: FilePenLine,    color: "text-slate-300",   iconClass: "text-slate-400",   bg: "bg-slate-700/20",        border: "border-slate-600/25"   },
  note_edited:       { icon: FilePenLine,    color: "text-slate-300",   iconClass: "text-slate-400",   bg: "bg-slate-700/20",        border: "border-slate-600/25"   },
  note_deleted:      { icon: FilePenLine,    color: "text-slate-400",   iconClass: "text-slate-500",   bg: "bg-slate-700/15",        border: "border-slate-700/25"   },
  duplicate_candidate:{ icon: AlertTriangle, color: "text-amber-400",   iconClass: "text-amber-400",   bg: "bg-amber-400/[0.07]",    border: "border-amber-400/20"   },
  archived_checkin:  { icon: AlertTriangle,  color: "text-orange-400",  iconClass: "text-orange-400",  bg: "bg-orange-400/[0.07]",   border: "border-orange-400/20"  },
  user_changed:      { icon: Monitor,        color: "text-blue-300",    iconClass: "text-blue-400",    bg: "bg-blue-400/[0.07]",     border: "border-blue-400/20"    },
};

const FALLBACK_CONFIG: EventConfig = {
  icon: Activity, color: "text-slate-400", iconClass: "text-slate-600", bg: "bg-slate-700/15", border: "border-slate-700/25",
};

function formatActivityTime(occurredAt: string): string {
  return timeAgo(occurredAt);
}

export default function ActivityTimeline({ events, loading, onReload }: ActivityTimelineProps) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="premium-kicker">Activity</p>
        {onReload && (
          <button
            type="button"
            onClick={onReload}
            className="th-btn th-btn-secondary inline-flex min-h-8 items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-semibold"
          >
            <RefreshCcw className="h-2.5 w-2.5" />
            Refresh
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-8 text-center text-xs font-medium text-slate-500">Loading activity...</div>
      ) : events.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <Activity className="h-5 w-5 text-slate-500" />
          <div>
            <p className="text-xs font-semibold text-slate-300">No recent activity</p>
            <p className="mt-0.5 text-[11px] text-slate-500">Events will appear here as devices report in.</p>
          </div>
        </div>
      ) : (
        <ul className="relative space-y-0">
          {events.map((event, idx) => {
            const config = EVENT_CONFIG[event.type] ?? FALLBACK_CONFIG;
            const Icon = config.icon;
            const isLast = idx === events.length - 1;
            return (
              <li key={event.id} className="relative flex gap-3 py-2.5">
                {/* Connector line */}
                {!isLast && (
                  <div
                    className="absolute left-[9px] top-[22px] bottom-0 w-px"
                    style={{ background: "linear-gradient(to bottom, rgba(255,255,255,0.06), rgba(255,255,255,0.01))" }}
                  />
                )}

                {/* Icon circle */}
                <div
                  className={`relative z-10 flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border ${config.bg} ${config.border} flex-shrink-0 mt-0.5`}
                >
                  <Icon className={`h-2.5 w-2.5 ${config.iconClass}`} />
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1 pb-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`text-[13px] font-semibold leading-snug ${config.color}`}>
                      {event.summary}
                    </span>
                    <span className="flex-none text-[11px] font-medium tabular-nums text-slate-500">
                      {formatActivityTime(event.occurred_at)}
                    </span>
                  </div>
                  {event.detail && (
                    event.type === "device_offline" ? (
                      <p className="mt-0.5 text-[11px] font-medium text-slate-400"
                        style={{ fontFamily: '"JetBrains Mono", monospace' }}>
                        {event.detail}
                      </p>
                    ) : (
                      <p className="mt-0.5 truncate text-[12px] text-slate-400">{event.detail}</p>
                    )
                  )}
                  {event.actor && (
                    <p className="mt-0.5 text-[10px] text-slate-600">by {event.actor}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
