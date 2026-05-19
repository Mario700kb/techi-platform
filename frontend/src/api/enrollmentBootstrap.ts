import { fetchJson } from "./client";

export type EnrollmentBootstrapPlatform = "windows" | "macos" | "linux";
export type EnrollmentBootstrapMode = "token" | "gpo";
export type AvailabilityProfile = "server" | "workstation" | "custom";

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
  is_default: boolean;
  token_prefix?: string | null;
}

export interface EnrollmentBootstrapRequest {
  mode: EnrollmentBootstrapMode;
  enrollment_token_id?: number;
  backend_url: string;
  platform: EnrollmentBootstrapPlatform;
  enrollment_token?: string;
  rustdesk_manage_enabled: boolean;
  rustdesk_msi_url: string;
  rustdesk_msi_checksum_sha256?: string;
  rustdesk_package_version?: string;
  rustdesk_rendezvous_server: string;
  rustdesk_relay_server: string;
  rustdesk_api_server: string;
  rustdesk_key: string;
  rustdesk_default_password: string;
  // Availability / power profile
  availability_profile: AvailabilityProfile;
  manage_power_policy: boolean;
  prevent_sleep_on_ac: boolean;
  prevent_hibernate: boolean;
  allow_display_off_on_ac: boolean;
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
  installer_filename: string;
}

export interface CreateTokenRequest {
  name: string;
  max_uses: number;
  expires_at?: string | null;
  client_id?: number | null;
  group_id?: number | null;
}

export interface CreateTokenResponse extends EnrollmentToken {
  token: string; // plaintext — only available at creation
}

export async function getEnrollmentTokens(): Promise<EnrollmentToken[]> {
  return fetchJson<EnrollmentToken[]>("/api/v1/enrollment-tokens");
}

export async function createEnrollmentToken(
  payload: CreateTokenRequest
): Promise<CreateTokenResponse> {
  return fetchJson<CreateTokenResponse>("/api/v1/enrollment-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function revokeEnrollmentToken(tokenId: number): Promise<EnrollmentToken> {
  return fetchJson<EnrollmentToken>(`/api/v1/enrollment-tokens/${tokenId}/revoke`, {
    method: "PUT",
  });
}

export async function deleteEnrollmentToken(
  tokenId: number,
  options: { confirmActive?: boolean; confirmDefault?: boolean } = {}
): Promise<EnrollmentToken> {
  const params = new URLSearchParams();
  if (options.confirmActive) params.set("confirm_active", "true");
  if (options.confirmDefault) params.set("confirm_default", "true");
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return fetchJson<EnrollmentToken>(`/api/v1/enrollment-tokens/${tokenId}${suffix}`, {
    method: "DELETE",
  });
}

export async function regenerateDefaultToken(): Promise<CreateTokenResponse> {
  return fetchJson<CreateTokenResponse>("/api/v1/enrollment-tokens/default/regenerate", {
    method: "POST",
  });
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
