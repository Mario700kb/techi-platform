import {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle,
  ClipboardList,
  FilePenLine,
  Monitor,
  RefreshCcw,
  RotateCcw,
  ShieldAlert,
  Wifi,
  WifiOff,
  Wrench,
} from "lucide-react";
import type { ComponentType } from "react";
import { ActivityEvent, ActivityEventType } from "../types/activity";
import { formatDateTime, timeAgo } from "../utils/time";
import { useNow } from "../hooks/useNow";
import { TONE } from "../utils/deviceStatus";
import { Button, EmptyState } from "./ui";

interface ActivityTimelineProps {
  events: ActivityEvent[];
  loading: boolean;
  onReload?: () => void;
}

interface EventConfig {
  icon: ComponentType<{ className?: string }>;
  /** A theme token; the icon, its tint and its ring are all derived from it. */
  tone: string;
}

// Agent/Remote Support lifecycle events that are neither good nor bad news.
const ACCENT = "var(--th-accent)";

const EVENT_CONFIG: Record<ActivityEventType, EventConfig> = {
  heartbeat_received: { icon: Activity, tone: TONE.online },
  device_online: { icon: Wifi, tone: TONE.online },
  device_offline: { icon: WifiOff, tone: TONE.neutral },
  rustdesk_updated: { icon: Monitor, tone: ACCENT },
  rustdesk_repaired: { icon: Wrench, tone: TONE.online },
  sync_failed: { icon: AlertTriangle, tone: TONE.critical },
  device_updated: { icon: RefreshCcw, tone: TONE.info },
  reconnect_detected: { icon: Wifi, tone: TONE.warning },
  health_warning: { icon: AlertTriangle, tone: TONE.warning },
  health_critical: { icon: ShieldAlert, tone: TONE.critical },
  health_recovered: { icon: CheckCircle, tone: TONE.online },
  device_registered: { icon: Monitor, tone: TONE.online },
  device_reenrolled: { icon: RefreshCcw, tone: TONE.info },
  assignment_changed: { icon: ClipboardList, tone: TONE.info },
  device_archived: { icon: Archive, tone: TONE.warning },
  device_restored: { icon: RotateCcw, tone: TONE.online },
  maintenance_entered: { icon: Wrench, tone: TONE.maintenance },
  maintenance_cleared: { icon: Wrench, tone: TONE.online },
  action_queued: { icon: Activity, tone: TONE.info },
  action_completed: { icon: CheckCircle, tone: TONE.online },
  action_failed: { icon: AlertTriangle, tone: TONE.critical },
  note_added: { icon: FilePenLine, tone: TONE.neutral },
  note_edited: { icon: FilePenLine, tone: TONE.neutral },
  note_deleted: { icon: FilePenLine, tone: TONE.neutral },
  duplicate_candidate: { icon: AlertTriangle, tone: TONE.warning },
  archived_checkin: { icon: AlertTriangle, tone: ACCENT },
  user_changed: { icon: Monitor, tone: TONE.info },
};

const FALLBACK_CONFIG: EventConfig = { icon: Activity, tone: TONE.neutral };

export default function ActivityTimeline({ events, loading, onReload }: ActivityTimelineProps) {
  useNow();
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="premium-kicker">Activity</p>
        {onReload && (
          <Button type="button" variant="secondary" size="sm" onClick={onReload}>
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        )}
      </div>

      {loading ? (
        <div className="py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
          Loading activity…
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon={<Activity className="h-5 w-5" />}
          title="No activity yet"
          description="Check-ins, status changes, actions and notes for this device will be listed here."
        />
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
                    className="absolute left-[11px] top-[30px] bottom-0 w-px"
                    style={{
                      background:
                        "linear-gradient(to bottom, color-mix(in srgb, var(--th-text-primary) 6%, transparent), color-mix(in srgb, var(--th-text-primary) 1%, transparent))",
                    }}
                  />
                )}

                {/* Icon circle */}
                <div
                  className="relative z-10 mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full border"
                  style={{
                    color: config.tone,
                    background: `color-mix(in srgb, ${config.tone} 8%, transparent)`,
                    borderColor: `color-mix(in srgb, ${config.tone} 22%, transparent)`,
                  }}
                >
                  <Icon className="h-3 w-3" />
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1 pb-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-medium leading-snug" style={{ color: "var(--th-text-primary)" }}>
                      {event.summary}
                    </span>
                    <time
                      dateTime={event.occurred_at}
                      title={formatDateTime(event.occurred_at)}
                      className="flex-none text-[12px] tabular-nums"
                      style={{ color: "var(--th-text-faint)" }}
                    >
                      {timeAgo(event.occurred_at)}
                    </time>
                  </div>
                  {event.detail &&
                    (event.type === "device_offline" ? (
                      <p className="mt-0.5 font-mono text-[11px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                        {event.detail}
                      </p>
                    ) : (
                      <p className="mt-0.5 truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                        {event.detail}
                      </p>
                    ))}
                  {event.actor && (
                    <p className="mt-0.5 text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                      by {event.actor}
                    </p>
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
