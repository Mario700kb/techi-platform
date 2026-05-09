import { fetchJson } from "../lib/api";

export interface HealthResponse {
  status: string;
  environment: string;
}

export async function getHealth(): Promise<HealthResponse> {
  return fetchJson<HealthResponse>("/health");
}
