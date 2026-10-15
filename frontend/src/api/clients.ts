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

// ─── Locations (a client's sites) ───────────────────────────────────────────

export type LocationKind = "office" | "branch" | "shop" | "warehouse" | "datacenter" | "other";

export const LOCATION_KINDS: { value: LocationKind; label: string }[] = [
  { value: "office", label: "Head office" },
  { value: "branch", label: "Branch" },
  { value: "shop", label: "Shop" },
  { value: "warehouse", label: "Warehouse" },
  { value: "datacenter", label: "Data centre" },
  { value: "other", label: "Other" },
];

export interface LocationRule {
  id?: number;
  public_ip?: string | null;
  lan_cidr?: string | null;
}

export interface LocationStats extends DeviceStats {
  servers: number;
  clientpc: number;
}

export interface ClientLocation {
  id: number;
  client_id: number;
  name: string;
  kind: LocationKind;
  country: string;
  city: string;
  address?: string | null;
  contact?: string | null;
  notes?: string | null;
  rules: LocationRule[];
  stats: LocationStats;
  manual_devices: number;
  created_by?: string | null;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientLocationList {
  locations: ClientLocation[];
  unlocated: LocationStats;
}

export interface LocationInput {
  name: string;
  kind: LocationKind;
  country: string;
  city: string;
  address?: string | null;
  contact?: string | null;
  notes?: string | null;
  rules: LocationRule[];
}

export interface LocationSuggestion {
  public_ip: string;
  devices: number;
  online: number;
  networks: { lan_cidr: string; devices: number }[];
  other_network_devices: number;
  sample_hostnames: string[];
}

export interface LocationApplyResult {
  assigned: number;
  cleared: number;
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function getClientLocations(clientId: number): Promise<ClientLocationList> {
  return fetchJson<ClientLocationList>(`/api/v1/clients/${clientId}/locations`);
}

export async function getLocationSuggestions(clientId: number): Promise<LocationSuggestion[]> {
  return fetchJson<LocationSuggestion[]>(`/api/v1/clients/${clientId}/locations/suggestions`);
}

export async function createClientLocation(clientId: number, input: LocationInput): Promise<ClientLocation> {
  return fetchJson<ClientLocation>(`/api/v1/clients/${clientId}/locations`, json("POST", input));
}

export async function updateClientLocation(
  clientId: number,
  locationId: number,
  input: Partial<LocationInput>,
): Promise<ClientLocation> {
  return fetchJson<ClientLocation>(`/api/v1/clients/${clientId}/locations/${locationId}`, json("PUT", input));
}

export async function deleteClientLocation(clientId: number, locationId: number): Promise<void> {
  await fetchJson<void>(`/api/v1/clients/${clientId}/locations/${locationId}`, { method: "DELETE" });
}

export async function applyLocationRules(clientId: number): Promise<LocationApplyResult> {
  return fetchJson<LocationApplyResult>(`/api/v1/clients/${clientId}/locations/apply`, { method: "POST" });
}

/** Put devices at a location by hand ("manual", pinned) or give them back to the rules ("auto"). */
export async function assignDeviceLocation(
  clientId: number,
  deviceIds: number[],
  locationId: number | null,
  mode: "manual" | "auto" = "manual",
): Promise<LocationApplyResult> {
  return fetchJson<LocationApplyResult>(
    `/api/v1/clients/${clientId}/locations/assign`,
    json("POST", { device_ids: deviceIds, location_id: locationId, mode }),
  );
}

/** "AL" → "Albania" in the operator's language, falling back to the code. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
