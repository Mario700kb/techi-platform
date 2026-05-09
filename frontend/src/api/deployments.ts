import { fetchJson } from "../lib/api";

export interface RecentDeployment {
  id: number;
  title: string;
  environment: string;
  status: "success" | "warning" | "failed";
  timestamp: string;
}

export async function getRecentDeployments(): Promise<RecentDeployment[]> {
  return fetchJson<RecentDeployment[]>("/api/v1/deployments/recent/");
}
