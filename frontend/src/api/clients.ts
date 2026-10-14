import { fetchJson } from "./client";

import type { AuditLogPage } from "./audit";
import type { DeviceStats } from "./devices";
import type { AlertCount } from "../types/alert";

export interface Client {
  id: number;
  name: string;
  slug: string;
  description?: string | null;
  is_active: boolean;
  created_at: string;
}

export interface DeviceGroup {
  id: number;
  client_id: number;
  name: string;
  description?: string | null;
  created_at: string;
}

export interface TrustedDomain {
  id: number;
  domain: string;
  client_id?: number | null;
  client_name?: string | null;
  resolved_client_name?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TrustedDomainCreate {
  domain: string;
  client_id?: number | null;
  client_name?: string | null;
  is_active?: boolean;
}

export interface TrustedDomainUpdate {
  domain?: string;
  client_id?: number | null;
  client_name?: string | null;
  is_active?: boolean;
}

export interface ClientCreate {
  name: string;
  slug?: string;
  description?: string;
  is_active?: boolean;
}

export interface ClientUpdate {
  name?: string;
  description?: string | null;
  is_active?: boolean;
}

export interface DeviceGroupCreate {
  name: string;
  client_id: number;
  description?: string;
}

export interface DeviceGroupUpdate {
  name?: string;
  description?: string | null;
}

export async function getClients(): Promise<Client[]> {
  return fetchJson<Client[]>("/api/v1/clients");
}

export async function createClient(payload: ClientCreate): Promise<Client> {
  return fetchJson<Client>("/api/v1/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateClient(clientId: number, payload: ClientUpdate): Promise<Client> {
  return fetchJson<Client>(`/api/v1/clients/${clientId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteClient(clientId: number): Promise<Client> {
  return fetchJson<Client>(`/api/v1/clients/${clientId}`, {
    method: "DELETE",
  });
}

export async function getTrustedDomains(): Promise<TrustedDomain[]> {
  return fetchJson<TrustedDomain[]>("/api/v1/trusted-domains");
}

export async function createTrustedDomain(payload: TrustedDomainCreate): Promise<TrustedDomain> {
  return fetchJson<TrustedDomain>("/api/v1/trusted-domains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateTrustedDomain(domainId: number, payload: TrustedDomainUpdate): Promise<TrustedDomain> {
  return fetchJson<TrustedDomain>(`/api/v1/trusted-domains/${domainId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteTrustedDomain(domainId: number): Promise<TrustedDomain> {
  return fetchJson<TrustedDomain>(`/api/v1/trusted-domains/${domainId}`, {
    method: "DELETE",
  });
}

export async function getGroups(clientId?: number): Promise<DeviceGroup[]> {
  const params = clientId ? `?client_id=${clientId}` : "";
  return fetchJson<DeviceGroup[]>(`/api/v1/groups${params}`);
}

export async function createGroup(payload: DeviceGroupCreate): Promise<DeviceGroup> {
  return fetchJson<DeviceGroup>("/api/v1/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateGroup(groupId: number, payload: DeviceGroupUpdate): Promise<DeviceGroup> {
  return fetchJson<DeviceGroup>(`/api/v1/groups/${groupId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteGroup(groupId: number): Promise<DeviceGroup> {
  return fetchJson<DeviceGroup>(`/api/v1/groups/${groupId}`, {
    method: "DELETE",
  });
}

export interface ClientProfile {
  client: Client;
  stats: DeviceStats;
  by_category: Record<string, DeviceStats>;
  alerts: AlertCount;
  average_health: number | null;
  health_critical: number;
  health_warning: number;
  needs_updates: number;
  agents_outdated: number;
  groups: { id: number; name: string; devices: number }[];
  last_seen: string | null;
}

export async function getClientProfile(clientId: number): Promise<ClientProfile> {
  return fetchJson<ClientProfile>(`/api/v1/clients/${clientId}/profile`);
}

export interface ClientActivityPage extends AuditLogPage {
  /** Current name of every device the page's entries mention. */
  device_names: Record<number, string>;
}

export type ClientActivityKind = "all" | "remote" | "terminal" | "actions" | "credentials";

export async function getClientActivity(
  clientId: number,
  limit = 50,
  offset = 0,
  filters: { kind?: ClientActivityKind; operator?: string | null } = {},
): Promise<ClientActivityPage> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (filters.kind && filters.kind !== "all") params.set("kind", filters.kind);
  if (filters.operator) params.set("operator", filters.operator);
  return fetchJson<ClientActivityPage>(`/api/v1/clients/${clientId}/activity?${params.toString()}`);
}

export interface ClientActivitySummary {
  days: number;
  since: string;
  events: number;
  remote_connects: number;
  remote_devices: number;
  last_remote_at: string | null;
  terminal_sessions: number;
  terminal_seconds: number;
  /** Remote Support sessions ended, from agents that report sessions; 0 until then. */
  remote_sessions: number;
  remote_minutes: number;
  operators: { username: string; events: number; remote_connects: number; last_at: string | null }[];
  devices: { device_id: number; name: string; remote_connects: number; last_at: string | null }[];
}

export async function getClientActivitySummary(clientId: number, days = 30): Promise<ClientActivitySummary> {
  return fetchJson<ClientActivitySummary>(`/api/v1/clients/${clientId}/activity/summary?days=${days}`);
}

export type DocumentCategory = "general" | "network" | "procedures" | "contacts" | "hardware" | "software";

export interface ClientDocumentSummary {
  id: number;
  client_id: number;
  title: string;
  category: DocumentCategory;
  pinned: boolean;
  excerpt: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientDocument extends ClientDocumentSummary {
  body: string;
}

export interface ClientDocumentInput {
  title: string;
  category: DocumentCategory;
  body: string;
  pinned: boolean;
}

export async function getClientDocuments(clientId: number, q = ""): Promise<ClientDocumentSummary[]> {
  const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return fetchJson<ClientDocumentSummary[]>(`/api/v1/clients/${clientId}/documents${qs}`);
}

export async function getClientDocument(clientId: number, documentId: number): Promise<ClientDocument> {
  return fetchJson<ClientDocument>(`/api/v1/clients/${clientId}/documents/${documentId}`);
}

export async function createClientDocument(clientId: number, input: ClientDocumentInput): Promise<ClientDocument> {
  return fetchJson<ClientDocument>(`/api/v1/clients/${clientId}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateClientDocument(
  clientId: number,
  documentId: number,
  input: Partial<ClientDocumentInput>,
): Promise<ClientDocument> {
  return fetchJson<ClientDocument>(`/api/v1/clients/${clientId}/documents/${documentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteClientDocument(clientId: number, documentId: number): Promise<void> {
  await fetchJson<void>(`/api/v1/clients/${clientId}/documents/${documentId}`, { method: "DELETE" });
}
