import { API_BASE_URL, fetchJson, getAuthToken } from "./client";

export type AgentPackagePlatform = "windows" | "windows-amd64" | "windows-arm64" | "linux-amd64" | "darwin-arm64";
export type AgentFileType = "msi" | "agent_binary";

export interface AgentPackage {
  id: string;
  version: string;
  platform: AgentPackagePlatform;
  file_type: AgentFileType;
  filename: string;
  uploaded_at: string;
  uploaded_by?: string | null;
  is_active: boolean;
  download_url: string;
  sha256?: string | null;
}

export async function getAgentPackages(): Promise<AgentPackage[]> {
  return fetchJson<AgentPackage[]>("/api/v1/agent-packages");
}

export async function uploadAgentPackage(payload: {
  version: string;
  platform: AgentPackagePlatform;
  file: File;
  file_type?: AgentFileType;
}): Promise<AgentPackage> {
  const formData = new FormData();
  formData.append("version", payload.version);
  formData.append("platform", payload.platform);
  formData.append("file_type", payload.file_type ?? "msi");
  formData.append("file", payload.file);

  const result = await fetchJson<{ package: AgentPackage }>("/api/v1/agent-packages", {
    method: "POST",
    body: formData,
  });
  return result.package;
}

export async function setAgentPackageActive(packageId: string, isActive: boolean): Promise<AgentPackage> {
  return fetchJson<AgentPackage>(`/api/v1/agent-packages/${packageId}/active`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_active: isActive }),
  });
}

export async function deleteAgentPackage(packageId: string, confirmActive = false): Promise<AgentPackage> {
  const suffix = confirmActive ? "?confirm_active=true" : "";
  return fetchJson<AgentPackage>(`/api/v1/agent-packages/${packageId}${suffix}`, {
    method: "DELETE",
  });
}

export async function getLatestPackage(platform: string): Promise<AgentPackage> {
  return fetchJson<AgentPackage>(`/api/v1/packages/latest?platform=${encodeURIComponent(platform)}`);
}

export async function downloadAgentPackage(pkg: AgentPackage): Promise<void> {
  const response = await fetch(`${API_BASE_URL}${pkg.download_url}`, {
    headers: {
      ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = pkg.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
