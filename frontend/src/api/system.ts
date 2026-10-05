import { fetchJson } from "./client";

export type TileState = "ok" | "running" | "done" | "warn" | "down" | "unknown";

export interface ServiceTile {
  key: string;
  state: TileState;
  label: string;
  detail: string;
  sub?: string | null;
  /** When the job ran / the backup was written (UTC ISO). */
  at?: string | null;
  value?: number | null;
  total?: number | null;
  items?: { name: string; state: "ok" | "down" }[] | null;
}

export interface SystemStatus {
  checked_at: string;
  services: ServiceTile[];
}

/** Owner/admin only (403 for other roles). */
export async function getSystemStatus(): Promise<SystemStatus> {
  return fetchJson<SystemStatus>("/api/v1/system/status");
}
