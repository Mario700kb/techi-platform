import { fetchJson } from "./client";

export type EnrollmentBootstrapPlatform = "windows" | "macos" | "linux";
export type EnrollmentBootstrapMode = "token" | "gpo";

export interface EnrollmentToken {
  id: number;
  name: string;
  status: "active" | "revoked" | "expired" | "used";
  created_at: string;
  expires_at?: string | null;
  used_at?: string | null;
  max_uses: number;
  use_count: number;
  client_id?: number | null;
  group_id?: number | null;
}

export interface EnrollmentBootstrapRequest {
  mode: EnrollmentBootstrapMode;
  enrollment_token_id?: number;
  backend_url: string;
  platform: EnrollmentBootstrapPlatform;
  enrollment_token?: string;
  rustdesk_manage_enabled: boolean;
  rustdesk_msi_url: string;
  rustdesk_rendezvous_server: string;
  rustdesk_relay_server: string;
  rustdesk_api_server: string;
  rustdesk_key: string;
  rustdesk_default_password: string;
}

export interface EnrollmentBootstrapResponse {
  mode: EnrollmentBootstrapMode;
  enrollment_token_id?: number | null;
  platform: EnrollmentBootstrapPlatform;
  backend_url: string;
  bootstrap_command: string;
  bootstrap_script: string;
  config_template: string;
  preproduction_notice: string;
}

export async function getEnrollmentTokens(): Promise<EnrollmentToken[]> {
  return fetchJson<EnrollmentToken[]>("/api/v1/enrollment-tokens");
}

export async function generateEnrollmentBootstrap(
  payload: EnrollmentBootstrapRequest
): Promise<EnrollmentBootstrapResponse> {
  return fetchJson<EnrollmentBootstrapResponse>("/api/v1/enrollment-bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
