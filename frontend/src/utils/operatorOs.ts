// Detects the OPERATOR's own OS (the browser running TECHI), not the
// managed device's. Used by Connect to hide launchers whose desktop app
// doesn't exist on the operator's platform (e.g. Winbox.exe is Windows-only).
// Same navigator-based approach already used for iOS detection in
// rustdeskLaunch.ts — no new detection strategy introduced.
export type OperatorOS = "windows" | "macos" | "linux" | "other";

export function detectOperatorOS(): OperatorOS {
  const platform = (navigator.platform || "").toLowerCase();
  const ua = (navigator.userAgent || "").toLowerCase();
  if (platform.startsWith("win") || ua.includes("windows")) return "windows";
  if (platform.startsWith("mac") || ua.includes("mac os")) return "macos";
  if (platform.startsWith("linux") || ua.includes("linux")) return "linux";
  return "other";
}
