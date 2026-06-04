import { fetchJson } from "./client";

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
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: AuthUser;
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  return fetchJson<LoginResponse>("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export async function getCurrentUser(): Promise<AuthUser> {
  return fetchJson<AuthUser>("/api/v1/auth/me");
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ message: string }> {
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

export async function getEffectivePermissions(): Promise<EffectivePermissions> {
  return fetchJson<EffectivePermissions>("/api/v1/auth/permissions/me");
}

