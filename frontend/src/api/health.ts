import { fetchJson } from "./client";

export interface HealthResponse {
  status: string;
  environment: string;
}

export async function getHealth(): Promise<HealthResponse> {
  return fetchJson<HealthResponse>("/health");
}
