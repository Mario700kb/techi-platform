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
  return `techiremotesupport://${encodeURIComponent(normalized)}`;
}

export function buildRustDeskFallbackUrl(rustdeskId: string): string {
  const normalized = rustdeskId.trim();
  if (!isValidRustDeskId(normalized)) {
    throw new Error("Invalid TECHI Remote Support ID");
  }
  return `rustdesk://${encodeURIComponent(normalized)}`;
}

export function launchRustDesk(rustdeskId: string): void {
  window.open(buildRustDeskLaunchUrl(rustdeskId), "_blank", "noopener,noreferrer");
}

// Module-level state so rapid re-clicks cancel any in-flight fallback attempt.
let pendingFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let pendingBlurListener: (() => void) | null = null;
let pendingVisibilityListener: (() => void) | null = null;

function cancelPendingFallback(): void {
  if (pendingFallbackTimer !== null) {
    clearTimeout(pendingFallbackTimer);
    pendingFallbackTimer = null;
  }
  if (pendingBlurListener !== null) {
    window.removeEventListener("blur", pendingBlurListener);
    pendingBlurListener = null;
  }
  if (pendingVisibilityListener !== null) {
    document.removeEventListener("visibilitychange", pendingVisibilityListener);
    pendingVisibilityListener = null;
  }
}

function clickProtocolUrl(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS
}

/**
 * Attempts techiremotesupport:// first. If the OS doesn't handle it (no window
 * blur within ~1200 ms), falls back to rustdesk://.
 *
 * The detection heuristic: handing off to an external app causes the browser
 * tab to lose focus (window "blur" event). If no blur arrives in 1200 ms the
 * app is assumed absent and rustdeskUrl is launched instead.
 *
 * Caveat: on first use some browsers show an "Open this link in [App]?" dialog
 * before handing off — the dialog itself causes a blur, so the heuristic still
 * works and no fallback fires.
 */
export function launchWithFallback(
  techiUrl: string,
  rustdeskUrl: string,
  onFallback?: () => void
): void {
  // Cancel any previous pending fallback (rapid double-click guard).
  cancelPendingFallback();

  let resolved = false;

  const cleanup = () => {
    cancelPendingFallback();
    resolved = true;
  };

  const handleSuccess = () => {
    if (resolved) return;
    cleanup();
  };

  const handleFallback = () => {
    if (resolved) return;
    cleanup();
    clickProtocolUrl(rustdeskUrl);
    onFallback?.();
  };

  // Blur fires when the OS accepts the protocol and switches app focus.
  const blurHandler = () => {
    handleSuccess();
  };
  pendingBlurListener = blurHandler;
  window.addEventListener("blur", blurHandler, { once: true });

  // Tab becoming hidden (Alt+Tab, Cmd+Tab) also signals a successful handoff.
  const visibilityHandler = () => {
    if (document.hidden) handleSuccess();
  };
  pendingVisibilityListener = visibilityHandler;
  document.addEventListener("visibilitychange", visibilityHandler);

  clickProtocolUrl(techiUrl);

  pendingFallbackTimer = setTimeout(handleFallback, 1200);
}

/**
 * Entry point for the Connect button on all platforms.
 *
 * iOS Safari enforces that custom-protocol navigation must occur synchronously
 * within the user-gesture call stack (the tap event). A navigation triggered
 * from setTimeout is silently blocked. Additionally techiremotesupport:// is
 * not registered on iOS (no iOS app exists), so attempting it first would show
 * a native "Cannot Open Page" alert with no way to suppress it.
 *
 * For iOS we therefore skip techiremotesupport:// entirely and call
 * clickProtocolUrl(rustdeskUrl) directly — same user-gesture stack, no alert,
 * no delay. The onFallback toast fires immediately so the user sees feedback.
 *
 * On all other platforms the blur-detection heuristic in launchWithFallback
 * handles the techiremotesupport → rustdesk fallback as before.
 */
export function launchConnect(
  techiUrl: string,
  rustdeskUrl: string,
  onFallback?: () => void
): void {
  if (isIOS()) {
    clickProtocolUrl(rustdeskUrl);
    onFallback?.();
    return;
  }
  launchWithFallback(techiUrl, rustdeskUrl, onFallback);
}
