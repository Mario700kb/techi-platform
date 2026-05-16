import { fetchJson } from "./client";
import { DeviceHealth, DeviceHealthSummary, TelemetrySnapshot } from "../types/telemetry";

export async function getDeviceTelemetryLatest(deviceId: number): Promise<TelemetrySnapshot | null> {
  return fetchJson<TelemetrySnapshot | null>(`/api/v1/devices/${deviceId}/telemetry/latest`);
}

export async function getDeviceTelemetryHistory(deviceId: number, limit = 20): Promise<TelemetrySnapshot[]> {
  return fetchJson<TelemetrySnapshot[]>(`/api/v1/devices/${deviceId}/telemetry?limit=${limit}`);
}

export async function getDeviceHealth(deviceId: number): Promise<DeviceHealth> {
  return fetchJson<DeviceHealth>(`/api/v1/devices/${deviceId}/health`);
}

export async function getDevicesHealthSummary(): Promise<DeviceHealthSummary[]> {
  return fetchJson<DeviceHealthSummary[]>(`/api/v1/devices/health`);
}
