import { fetchJson } from "./client";
import type { RemoteAction } from "./actions";

/** The first agent that ends processes, controls services and uninstalls apps. */
export const MANAGE_MIN_AGENT_VERSION = "2.1.41";

export type ServiceOperation = "start" | "stop" | "restart";

function post(path: string, body: unknown): Promise<RemoteAction> {
  return fetchJson<RemoteAction>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function killProcess(deviceId: number, pid: number, name: string): Promise<RemoteAction> {
  return post(`/api/v1/devices/${deviceId}/processes/kill`, { pid, name });
}

export function controlService(deviceId: number, name: string, operation: ServiceOperation): Promise<RemoteAction> {
  return post(`/api/v1/devices/${deviceId}/services/control`, { name, operation });
}

export function uninstallSoftware(
  deviceId: number,
  name: string,
  uninstallKey: string,
  mfaCode: string,
): Promise<RemoteAction> {
  return post(`/api/v1/devices/${deviceId}/software/uninstall`, {
    name,
    uninstall_key: uninstallKey,
    mfa_code: mfaCode,
  });
}

// Mirrors of the agent's lists (agent/actions_manage_windows.go): the console
// does not offer what the agent would refuse.
export const PROTECTED_PROCESSES = new Set([
  "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe",
  "lsass.exe", "lsaiso.exe", "svchost.exe", "dwm.exe", "msmpeng.exe",
  "techi-agent.exe", "techi-agent-watchdog.exe", "techi remote support.exe", "rustdesk.exe",
]);

/** Started freely; never stopped or restarted from the console. */
export const PROTECTED_SERVICES = new Set([
  "techiagent", "techi remote support", "rpcss", "rpceptmapper", "dcomlaunch", "lsm", "samss",
  "plugplay", "power", "brokerinfrastructure", "coremessagingregistrar", "systemeventsbroker",
  "schedule", "eventlog", "profsvc", "gpsvc", "nsi", "dhcp", "bfe", "mpssvc",
]);

export function isProtectedSoftware(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower === "techi agent" || lower.startsWith("techi remote support") || lower.startsWith("techi endpoint");
}
