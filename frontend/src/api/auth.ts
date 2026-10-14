import { API_BASE_URL, apiFetch, CSRF_HEADER, fetchJson } from "./client";

export type UserRole = "owner" | "admin" | "operator" | "readonly";

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  display_name: string | null;
  role: UserRole;
  is_active: boolean;
  is_superuser: boolean;
  created_at: string;
  last_login_at: string | null;
  mfa_enabled?: boolean;
}

/** A password sign-in either completes or asks for the second factor. */
export interface LoginResult {
  mfa_required: boolean;
  mfa_token: string | null;
  user: AuthUser | null;
  session_expires_at: string | null;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function login(username: string, password: string): Promise<LoginResult> {
  return fetchJson<LoginResult>("/api/v1/auth/login", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ username, password }),
  });
}

export async function loginWithMfa(mfaToken: string, code: string): Promise<LoginResult> {
  return fetchJson<LoginResult>("/api/v1/auth/login/mfa", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ mfa_token: mfaToken, code }),
  });
}

/** Ends this browser's session on the server and clears the cookies. */
export async function logout(): Promise<void> {
  await apiFetch("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined);
}

/**
 * Moves a bearer token left by the pre-cookie frontend to a cookie session.
 * Raw fetch: the token goes in this one Authorization header and nowhere else.
 */
export async function exchangeLegacyToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/auth/token-exchange`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, [CSRF_HEADER]: "1" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getCurrentUser(): Promise<AuthUser> {
  return fetchJson<AuthUser>("/api/v1/auth/me");
}

/** Your own display name and email; a new email needs the current password. */
export async function updateProfile(changes: {
  display_name?: string | null;
  email?: string;
  current_password?: string;
}): Promise<AuthUser> {
  return fetchJson<AuthUser>("/api/v1/auth/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<{ message: string }> {
  return fetchJson<{ message: string }>("/api/v1/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
}

export interface EffectivePermissions {
  role: string;
  permissions: string[];
  denied: string[];
}

export interface AuthSession {
  user: AuthUser;
  permissions: string[];
  denied: string[];
  session_expires_at: string | null;
  /** When the access cookie this request carried expires. */
  access_expires_at?: string | null;
  mfa_enrollment_required: boolean;
}

/** The signed-in session, or null when this browser holds none (204). */
export async function getAuthSession(): Promise<AuthSession | null> {
  return (await fetchJson<AuthSession | undefined>("/api/v1/auth/session")) ?? null;
}

export async function getEffectivePermissions(): Promise<EffectivePermissions> {
  return fetchJson<EffectivePermissions>("/api/v1/auth/permissions/me");
}

// -- signed-in browsers ----------------------------------------------------

export interface OperatorSession {
  id: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  ip_address: string | null;
  user_agent: string | null;
  current: boolean;
}

export async function listSessions(): Promise<OperatorSession[]> {
  return fetchJson<OperatorSession[]>("/api/v1/auth/sessions");
}

export async function revokeSession(id: string): Promise<void> {
  await apiFetch(`/api/v1/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function revokeOtherSessions(): Promise<{ revoked: number }> {
  return fetchJson<{ revoked: number }>("/api/v1/auth/sessions/revoke-others", { method: "POST" });
}

// -- two-factor authentication ------------------------------------------------

export interface MfaStatus {
  enabled: boolean;
  enabled_at: string | null;
  required: boolean;
  recovery_codes_remaining: number;
}

export interface MfaSetup {
  secret: string;
  otpauth_uri: string;
}

export async function getMfaStatus(): Promise<MfaStatus> {
  return fetchJson<MfaStatus>("/api/v1/auth/mfa");
}

export async function startMfaSetup(): Promise<MfaSetup> {
  return fetchJson<MfaSetup>("/api/v1/auth/mfa/setup", { method: "POST" });
}

export async function enableMfa(code: string): Promise<string[]> {
  const body = await fetchJson<{ recovery_codes: string[] }>("/api/v1/auth/mfa/enable", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ code }),
  });
  return body.recovery_codes;
}

export async function disableMfa(password: string, code: string): Promise<void> {
  await apiFetch("/api/v1/auth/mfa/disable", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ password, code }),
  });
}

export async function regenerateRecoveryCodes(code: string): Promise<string[]> {
  const body = await fetchJson<{ recovery_codes: string[] }>("/api/v1/auth/mfa/recovery-codes", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ code }),
  });
  return body.recovery_codes;
}
