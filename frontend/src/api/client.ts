const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || "";

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function localApiBaseUrls(): string[] {
  if (typeof window === "undefined") {
    return ["http://localhost:8000"];
  }

  const { protocol, hostname } = window.location;
  const urls = [`${protocol}//${hostname}:8000`];

  if (hostname === "localhost") {
    urls.push("http://127.0.0.1:8000");
  } else if (hostname === "127.0.0.1") {
    urls.push("http://localhost:8000");
  }

  return urls;
}

function uniqueUrls(urls: string[]): string[] {
  return Array.from(new Set(urls.filter(Boolean).map(normalizeBaseUrl)));
}

export const API_BASE_URL = normalizeBaseUrl(configuredApiBaseUrl || localApiBaseUrls()[0]);
// A configured API URL is the only one ever used. The localhost candidates
// exist for a dev server with no .env; a production build always configures
// its URL (vite.config.ts refuses to build otherwise), so a request can never
// be retried against another origin there.
const API_BASE_URLS = configuredApiBaseUrl ? [API_BASE_URL] : uniqueUrls([API_BASE_URL, ...localApiBaseUrls()]);
/** Where the pre-cookie frontend kept its bearer token. Read once, then deleted. */
const LEGACY_TOKEN_KEY = "techi.auth.token";
const LEGACY_USER_KEY = "techi.auth.user";
/**
 * Sent on every request. The session lives in HttpOnly cookies the page cannot
 * read; the backend accepts a cookie-authenticated write only with this
 * header, which another site cannot add without a CORS preflight.
 */
export const CSRF_HEADER = "X-TECHI-CSRF";
const REFRESH_PATH = "/api/v1/auth/refresh";
/** Long enough for report generation and package downloads; a hung request still ends. */
export const DEFAULT_TIMEOUT_MS = 30_000;
let unauthorizedHandler: (() => void) | null = null;
let mfaEnrollmentHandler: (() => void) | null = null;
export interface SessionTimes {
  /** The session's absolute end. */
  sessionExpiresAt: string;
  /** When the access cookie just issued expires; renew shortly before it. */
  accessExpiresAt: string | null;
}
let sessionRefreshedHandler: ((times: SessionTimes) => void) | null = null;
let sessionActive = false;
let refreshInFlight: Promise<boolean> | null = null;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Machine-readable code from a structured error body, e.g. "mfa_enrollment_required". */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiRequestInit extends RequestInit {
  /** Abort the request after this many milliseconds (default 30s). 0 disables. */
  timeoutMs?: number;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function setMfaEnrollmentHandler(handler: (() => void) | null): void {
  mfaEnrollmentHandler = handler;
}

export function setSessionRefreshedHandler(handler: ((times: SessionTimes) => void) | null): void {
  sessionRefreshedHandler = handler;
}

/**
 * Whether the app believes it is signed in. A 401 then means "renew the
 * session" (and, failing that, "you were signed out"); before sign-in it is
 * just a wrong password.
 */
export function setSessionActive(active: boolean): void {
  sessionActive = active;
}

/** The bearer token a pre-cookie frontend left in localStorage, removed as it is read. */
export function takeLegacyToken(): string | null {
  try {
    const token = window.localStorage.getItem(LEGACY_TOKEN_KEY);
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
    window.localStorage.removeItem(LEGACY_USER_KEY);
    return token;
  } catch {
    return null;
  }
}

/**
 * Swaps the refresh cookie for a new session cookie pair. Concurrent callers
 * share one request: the refresh token rotates, so a second parallel refresh
 * would present a token that no longer exists.
 */
export function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_BASE_URL}${REFRESH_PATH}`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", [CSRF_HEADER]: "1" },
    })
      .then(async (response) => {
        if (!response.ok) return false;
        const body = (await response.json().catch(() => null)) as {
          session_expires_at?: string;
          access_expires_at?: string;
        } | null;
        if (body?.session_expires_at) {
          sessionRefreshedHandler?.({
            sessionExpiresAt: body.session_expires_at,
            accessExpiresAt: body.access_expires_at ?? null,
          });
        }
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/**
 * Links the caller's AbortSignal (if any) with a timeout. A timeout surfaces
 * as ApiError 408 rather than AbortError, so callers that ignore their own
 * cancellations still report a server that stopped answering.
 */
function withTimeout(signal: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function errorDetails(response: Response): Promise<{ message: string; code?: string }> {
  let message = `${response.status} ${response.statusText}`;
  let code: string | undefined;
  try {
    const body = await response.json();
    if (typeof body.detail === "string") {
      message = body.detail;
    } else if (body?.detail && typeof body.detail.detail === "string") {
      // Structured error bodies (e.g. Component Actions) nest a human
      // message under detail.detail alongside a machine-readable code.
      message = body.detail.detail;
      if (typeof body.detail.code === "string") code = body.detail.code;
    }
  } catch {
    // Keep the HTTP status message when the response is not JSON.
  }
  return { message, code };
}

/** One attempt across the base-URL candidates; returns the response whatever its status. */
async function send(path: string, init: ApiRequestInit): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...requestInit } = init;
  const method = (requestInit.method ?? "GET").toUpperCase();
  // Only a dev server tries more than one base URL, and only for reads: a
  // network error after the server processed a POST must not run it twice.
  const candidates = method === "GET" || method === "HEAD" ? API_BASE_URLS : API_BASE_URLS.slice(0, 1);
  let networkError: unknown;

  for (const baseUrl of candidates) {
    const timeout = withTimeout(requestInit.signal, timeoutMs);
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...requestInit,
        credentials: "include",
        signal: timeout.signal,
        headers: {
          Accept: "application/json",
          [CSRF_HEADER]: "1",
          ...requestInit.headers,
        },
      });
    } catch (error) {
      if (timeout.timedOut()) {
        throw new ApiError("The server did not respond in time. Try again.", 408);
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      networkError = error;
    } finally {
      timeout.dispose();
    }
  }

  throw networkError instanceof Error ? networkError : new Error("Failed to reach backend API");
}

/**
 * The one way the app talks to the API: session cookies, CSRF header, timeout,
 * session renewal and error messages in one place. Resolves only for a 2xx
 * response; anything else throws ApiError. Use for non-JSON bodies (text,
 * blobs, empty responses).
 */
export async function apiFetch(path: string, init: ApiRequestInit = {}): Promise<Response> {
  let response = await send(path, init);

  // An expired access cookie: renew the session once and repeat the request.
  if (response.status === 401 && sessionActive && path !== REFRESH_PATH) {
    if (await refreshSession()) {
      response = await send(path, init);
    }
  }

  if (!response.ok) {
    const { message, code } = await errorDetails(response);
    if (response.status === 401 && sessionActive) {
      unauthorizedHandler?.();
    }
    if (response.status === 403 && code === "mfa_enrollment_required") {
      mfaEnrollmentHandler?.();
    }
    throw new ApiError(message, response.status, code);
  }

  return response;
}

export async function fetchJson<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  // 204 No Content (most deletes) has no body to parse.
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function fetchText(path: string, init?: ApiRequestInit): Promise<string> {
  const response = await apiFetch(path, init);
  return response.text();
}
