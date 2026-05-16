import { fetchJson } from "./client";
import { ActivityEvent } from "../types/activity";

export async function getDeviceActivity(deviceId: number, limit = 40): Promise<ActivityEvent[]> {
  return fetchJson<ActivityEvent[]>(`/api/v1/devices/${deviceId}/activity?limit=${limit}`);
}
