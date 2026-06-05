import { fetchJson } from "./client";
import { UserRole } from "./auth";

export interface OperatorRecord {
  id: number;
  username: string;
  email: string;
  display_name: string | null;
  role: UserRole;
  is_active: boolean;
  is_superuser: boolean;
  created_at: string;
  last_login_at: string | null;
  last_active_at: string | null;
}

export interface OperatorCreate {
  username: string;
  email: string;
  display_name?: string;
  password: string;
  role: UserRole;
  is_active: boolean;
}

export interface OperatorUpdate {
  username?: string;
  email?: string;
  display_name?: string | null;
  role?: UserRole;
  is_active?: boolean;
}

export interface OperatorPasswordReset {
  new_password: string;
}

export async function getOperators(): Promise<OperatorRecord[]> {
  return fetchJson<OperatorRecord[]>("/api/v1/operators");
}

export interface OperatorPresenceRecord {
  id: number;
  username: string;
  display_name: string | null;
  role: UserRole;
  is_online: boolean;
  last_active_at: string | null;
}

export async function getOperatorPresence(): Promise<OperatorPresenceRecord[]> {
  return fetchJson<OperatorPresenceRecord[]>("/api/v1/operators/presence");
}

export async function createOperator(payload: OperatorCreate): Promise<OperatorRecord> {
  return fetchJson<OperatorRecord>("/api/v1/operators", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateOperator(operatorId: number, payload: OperatorUpdate): Promise<OperatorRecord> {
  return fetchJson<OperatorRecord>(`/api/v1/operators/${operatorId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteOperator(operatorId: number): Promise<OperatorRecord> {
  return fetchJson<OperatorRecord>(`/api/v1/operators/${operatorId}`, {
    method: "DELETE",
  });
}

export async function resetOperatorPassword(operatorId: number, payload: OperatorPasswordReset): Promise<OperatorRecord> {
  return fetchJson<OperatorRecord>(`/api/v1/operators/${operatorId}/password`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
