export interface Device {
  id: number;
  rustdesk_id: string;
  hostname?: string;
  current_user?: string;
  domain?: string;
  public_ip?: string;
  local_ip?: string;
  os_name?: string;
  os_version?: string;
  device_type: "server" | "client" | "unassigned";
  status: "online" | "offline";
  registered_at: string;
  last_seen?: string;
  cpu?: string;
  ram?: string;
  storage?: string;
}

export interface Client {
  id: number;
  name: string;
  description?: string;
  is_active: boolean;
  created_at: string;
}

export interface DeviceGroup {
  id: number;
  name: string;
  client_id: number;
  created_at: string;
}
