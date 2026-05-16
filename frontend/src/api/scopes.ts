import { fetchJson } from "./client";

export type ScopeType = "client" | "group" | "device";

export interface ScopeEntry {
  id: number;
  operator_id: number;
  scope_type: ScopeType;
  scope_id: number;
  created_at: string;
}

export interface ScopeEntryCreate {
  scope_type: ScopeType;
  scope_id: number;
}

export async function getOperatorScopes(operatorId: number): Promise<ScopeEntry[]> {
  return fetchJson<ScopeEntry[]>(`/api/v1/operators/${operatorId}/scopes`);
}

export async function addOperatorScope(operatorId: number, payload: ScopeEntryCreate): Promise<ScopeEntry> {
  return fetchJson<ScopeEntry>(`/api/v1/operators/${operatorId}/scopes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function removeOperatorScope(operatorId: number, entryId: number): Promise<ScopeEntry> {
  return fetchJson<ScopeEntry>(`/api/v1/operators/${operatorId}/scopes/${entryId}`, {
    method: "DELETE",
  });
}

export async function replaceOperatorScopes(operatorId: number, entries: ScopeEntryCreate[]): Promise<ScopeEntry[]> {
  return fetchJson<ScopeEntry[]>(`/api/v1/operators/${operatorId}/scopes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
}
