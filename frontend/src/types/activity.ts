export type ActivityEventType =
  | "heartbeat_received"
  | "device_online"
  | "device_offline"
  | "rustdesk_updated"
  | "sync_failed"
  | "device_updated"
  | "reconnect_detected"
  | "health_warning"
  | "health_critical"
  | "health_recovered"
  | "device_registered"
  | "assignment_changed"
  | "device_archived"
  | "device_restored"
  | "maintenance_entered"
  | "maintenance_cleared"
  | "action_queued"
  | "action_completed"
  | "action_failed"
  | "note_added"
  | "note_edited"
  | "note_deleted"
  | "duplicate_candidate"
  | "archived_checkin";

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  occurred_at: string;
  summary: string;
  detail?: string | null;
  device_id: number;
}
