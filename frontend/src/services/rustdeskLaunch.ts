const RUSTDESK_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export function isValidRustDeskId(rustdeskId?: string | null): boolean {
  if (!rustdeskId) return false;
  const trimmed = rustdeskId.trim().toLowerCase();
  if (trimmed.startsWith("agent_") || trimmed.startsWith("pending_")) return false;
  return RUSTDESK_ID_PATTERN.test(trimmed);
}

export function buildRustDeskLaunchUrl(rustdeskId: string): string {
  const normalized = rustdeskId.trim();
  if (!isValidRustDeskId(normalized)) {
    throw new Error("Invalid TECHI Remote Support ID");
  }
  return `rustdesk://${encodeURIComponent(normalized)}`;
}

export function launchRustDesk(rustdeskId: string): void {
  window.open(buildRustDeskLaunchUrl(rustdeskId), "_blank", "noopener,noreferrer");
}
