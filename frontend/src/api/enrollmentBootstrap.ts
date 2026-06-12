import { API_BASE_URL, fetchJson } from "./client";

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
  has_recoverable_token: boolean;
  usage_warning?: "warning" | "critical" | null;
}

export interface EnrollmentTokenDeployment {
  token_id: number;
  token_name: string;
  token_prefix?: string | null;
  token_available: boolean;
  bootstrap_url: string;
  manual_command: string;
  gpo_command: string;
  gpo_deploy_command: string;
  token_metadata: EnrollmentToken;
  rustdesk: Record<string, string>;
}

export type EnrollmentAuditResult = "success" | "duplicate" | "updated_existing" | "failed" | "ignored";

export interface EnrollmentAuditEvent {
  id: number;
  created_at: string;
  token_id?: number | null;
  token_name?: string | null;
  token_prefix?: string | null;
  client_id?: number | null;
  group_id?: number | null;
  device_id?: number | null;
  hostname?: string | null;
  username?: string | null;
  domain?: string | null;
  rustdesk_id?: string | null;
  public_ip?: string | null;
  local_ip?: string | null;
  result: EnrollmentAuditResult;
  reason?: string | null;
  raw_error?: string | null;
  fingerprint?: string | null;
  agent_id?: string | null;
}

export interface EnrollmentTokenDiagnostics {
  token: EnrollmentToken;
  uses: number;
  max_uses: number;
  unique_devices?: number | null;
  duplicate_enrollments?: number | null;
  successful_events?: number | null;
  failed_events?: number | null;
  archived_devices?: number | null;
  orphaned_uses?: number | null;
  inferred: boolean;
  inference_note?: string | null;
  last_events: EnrollmentAuditEvent[];
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

export interface UpdateTokenRequest {
  name?: string;
  max_uses?: number;
  expires_at?: string | null;
  client_id?: number | null;
  group_id?: number | null;
  status?: "active" | "revoked";
}

export interface CreateTokenResponse extends EnrollmentToken {
  token: string; // plaintext — only available at creation
}

export interface RustDeskConfig {
  server_host: string;
  relay_host: string;
  public_key: string;
}

export async function getEnrollmentTokens(): Promise<EnrollmentToken[]> {
  return fetchJson<EnrollmentToken[]>("/api/v1/enrollment-tokens");
}

export async function getEnrollmentTokenDeployment(tokenId: number): Promise<EnrollmentTokenDeployment> {
  return fetchJson<EnrollmentTokenDeployment>(`/api/v1/enrollment-tokens/${tokenId}/deployment`);
}

export async function getEnrollmentTokenDiagnostics(tokenId: number): Promise<EnrollmentTokenDiagnostics> {
  return fetchJson<EnrollmentTokenDiagnostics>(`/api/v1/enrollment-tokens/${tokenId}/diagnostics`);
}

export async function getEnrollmentTokenEvents(
  tokenId: number,
  options: { limit?: number; offset?: number } = {}
): Promise<EnrollmentAuditEvent[]> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 50),
    offset: String(options.offset ?? 0),
  });
  return fetchJson<EnrollmentAuditEvent[]>(`/api/v1/enrollment-tokens/${tokenId}/events?${params.toString()}`);
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

export async function updateEnrollmentToken(tokenId: number, payload: UpdateTokenRequest): Promise<EnrollmentToken> {
  return fetchJson<EnrollmentToken>(`/api/v1/enrollment-tokens/${tokenId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function regenerateEnrollmentToken(tokenId: number): Promise<CreateTokenResponse> {
  return fetchJson<CreateTokenResponse>(`/api/v1/enrollment-tokens/${tokenId}/regenerate`, {
    method: "POST",
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

export async function getRustDeskConfig(): Promise<RustDeskConfig> {
  return fetchJson<RustDeskConfig>("/api/v1/remote-support/config");
}

export function buildWindowsBootstrapUrl(token: string): string {
  return `${API_BASE_URL}/api/v1/bootstrap/windows.ps1?token=${encodeURIComponent(token)}`;
}

export function buildWindowsBootstrapCommand(token: string): string {
  const url = buildWindowsBootstrapUrl(token);
  return [
    `$BootstrapUrl = "${url}"`,
    `$BootstrapFile = Join-Path $env:TEMP "techi-bootstrap.ps1"`,
    "Invoke-WebRequest -Uri $BootstrapUrl -OutFile $BootstrapFile",
    "Unblock-File -Path $BootstrapFile -ErrorAction SilentlyContinue",
    "powershell.exe -ExecutionPolicy Bypass -NoProfile -File $BootstrapFile",
  ].join("\n");
}

export function enrollmentTokenBootstrapDownloadUrl(tokenId: number): string {
  return `${API_BASE_URL}/api/v1/enrollment-tokens/${tokenId}/bootstrap.ps1`;
}
