import { fetchJson } from "./client";

/** A fleet command batch (bulk command pushed to many devices) and its real outcome. */
export interface RecentDeployment {
  id: string;
  command_type: string;
  target: string;
  total: number;
  completed: number;
  failed: number;
  /** Devices that never answered (expired) or were cancelled before delivery. */
  timeout: number;
  status: "success" | "warning" | "failed" | "running";
  timestamp: string;
  created_by_name: string | null;
}

export async function getRecentDeployments(): Promise<RecentDeployment[]> {
  return fetchJson<RecentDeployment[]>("/api/v1/deployments/recent");
}
