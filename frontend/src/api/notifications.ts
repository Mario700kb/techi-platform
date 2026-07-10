import { fetchJson } from "./client";

export type NotificationChannelType = "email" | "webhook";
export type NotificationScopeType = "global" | "client";

export interface NotificationChannel {
  id: number;
  name: string;
  channel_type: NotificationChannelType;
  enabled: boolean;
  config: Record<string, unknown>;
  has_secret: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationChannelCreate {
  name: string;
  channel_type: NotificationChannelType;
  enabled?: boolean;
  config: Record<string, unknown>;
  secret?: string | null;
}

export interface NotificationChannelUpdate {
  name?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  secret?: string | null;
}

export interface NotificationRule {
  id: number;
  event_type: string;
  scope_type: NotificationScopeType;
  client_id: number | null;
  channel_id: number;
  enabled: boolean;
  min_severity: string | null;
  cooldown_seconds: number;
  rate_limit_per_hour: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationRuleCreate {
  event_type: string;
  scope_type?: NotificationScopeType;
  client_id?: number | null;
  channel_id: number;
  enabled?: boolean;
  min_severity?: string | null;
  cooldown_seconds?: number;
  rate_limit_per_hour?: number | null;
}

export interface NotificationRuleUpdate {
  enabled?: boolean;
  min_severity?: string | null;
  cooldown_seconds?: number;
  rate_limit_per_hour?: number | null;
}

export interface NotificationDelivery {
  id: number;
  rule_id: number | null;
  channel_id: number;
  event_type: string;
  device_id: number | null;
  client_id: number | null;
  title: string;
  status: "pending" | "sent" | "retrying" | "failed";
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface NotificationDeliveryList {
  items: NotificationDelivery[];
  total: number;
}

export const NOTIFICATION_EVENT_TYPES = [
  "device_offline",
  "device_online",
  "agent_update_failed",
  "agent_update_completed",
  "critical_alert",
  "maintenance_finished",
  "remote_action_failed",
  "remote_action_completed",
  "enrollment_failed",
  "terminal_session_started",
  "terminal_session_ended",
] as const;

export async function listNotificationChannels(): Promise<NotificationChannel[]> {
  return fetchJson<NotificationChannel[]>("/api/v1/notifications/channels");
}

export async function createNotificationChannel(
  payload: NotificationChannelCreate,
): Promise<NotificationChannel> {
  return fetchJson<NotificationChannel>("/api/v1/notifications/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateNotificationChannel(
  id: number,
  payload: NotificationChannelUpdate,
): Promise<NotificationChannel> {
  return fetchJson<NotificationChannel>(`/api/v1/notifications/channels/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteNotificationChannel(id: number): Promise<void> {
  await fetchJson<void>(`/api/v1/notifications/channels/${id}`, { method: "DELETE" });
}

export async function testNotificationChannel(
  id: number,
  message?: string,
): Promise<{ success: boolean; error: string | null }> {
  return fetchJson(`/api/v1/notifications/channels/${id}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: message || null }),
  });
}

export async function listNotificationRules(): Promise<NotificationRule[]> {
  return fetchJson<NotificationRule[]>("/api/v1/notifications/rules");
}

export async function createNotificationRule(payload: NotificationRuleCreate): Promise<NotificationRule> {
  return fetchJson<NotificationRule>("/api/v1/notifications/rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateNotificationRule(
  id: number,
  payload: NotificationRuleUpdate,
): Promise<NotificationRule> {
  return fetchJson<NotificationRule>(`/api/v1/notifications/rules/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteNotificationRule(id: number): Promise<void> {
  await fetchJson<void>(`/api/v1/notifications/rules/${id}`, { method: "DELETE" });
}

export async function listNotificationDeliveries(params?: {
  channel_id?: number;
  event_type?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<NotificationDeliveryList> {
  const search = new URLSearchParams();
  if (params?.channel_id) search.set("channel_id", String(params.channel_id));
  if (params?.event_type) search.set("event_type", params.event_type);
  if (params?.status) search.set("status", params.status);
  search.set("limit", String(params?.limit ?? 50));
  search.set("offset", String(params?.offset ?? 0));
  return fetchJson<NotificationDeliveryList>(`/api/v1/notifications/deliveries?${search.toString()}`);
}
