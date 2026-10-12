import { API_BASE_URL, CSRF_HEADER } from "../api/client";
import { getSessionSnapshot } from "../store/sessionStore";

interface ErrorContext {
  componentStack?: string;
  scope?: string;
}

const DEDUPE_WINDOW_MS = 60_000;
const recentlyReported = new Map<string, number>();

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : "Non-error value thrown");
}

/** Errors from browser extensions and injected scripts are not ours to fix. */
function isForeign(error: Error, filename?: string): boolean {
  const source = `${filename ?? ""}\n${error.stack ?? ""}`;
  return /(chrome|moz|safari(-web)?)-extension:\/\//.test(source);
}

/**
 * Logs a frontend error locally and sends it to the backend log
 * (`POST /system/client-errors`). Identical errors are sent once a minute;
 * reporting never throws and never blocks the UI.
 */
export function reportError(value: unknown, context: ErrorContext = {}, filename?: string): void {
  const error = asError(value);
  if (isForeign(error, filename)) return;
  console.error(error);

  const key = `${error.name}:${error.message}`;
  const now = Date.now();
  const last = recentlyReported.get(key);
  if (last && now - last < DEDUPE_WINDOW_MS) return;
  recentlyReported.set(key, now);

  // The endpoint is authenticated; an error before sign-in stays local.
  if (!getSessionSnapshot().user || import.meta.env.MODE === "test") return;

  try {
    void fetch(`${API_BASE_URL}/api/v1/system/client-errors`, {
      method: "POST",
      keepalive: true,
      credentials: "include",
      headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1" },
      body: JSON.stringify({
        message: error.message.slice(0, 1000),
        name: error.name.slice(0, 200),
        stack: error.stack?.slice(0, 8000),
        component_stack: context.componentStack?.slice(0, 8000),
        url: window.location.pathname.slice(0, 1000),
        scope: context.scope,
        release: import.meta.env.VITE_RELEASE || undefined,
        user_agent: navigator.userAgent.slice(0, 500),
      }),
    }).catch(() => undefined);
  } catch {
    // Reporting is best-effort.
  }
}

/** Errors thrown outside React rendering: event handlers, timers, promises. */
export function installGlobalErrorHandlers(): void {
  window.addEventListener("error", (event) => {
    reportError(event.error ?? event.message, { scope: "window" }, event.filename);
  });
  window.addEventListener("unhandledrejection", (event) => {
    // Aborted requests are cancellations, not failures.
    if (event.reason instanceof DOMException && event.reason.name === "AbortError") return;
    reportError(event.reason, { scope: "promise" });
  });
}
