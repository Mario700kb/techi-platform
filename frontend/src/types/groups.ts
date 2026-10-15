// The groups every client can have; the backend makes one for the client the
// first time a device is put in it (PUT /devices/{id}/assign-group with group_name).
export const STANDARD_GROUPS = ["Servers", "Client PC", "Network", "Storage", "Hypervisors", "Other"] as const;
export type StandardGroup = (typeof STANDARD_GROUPS)[number];
