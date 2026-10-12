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
// its URL (vite.config.ts refuses to build otherwise), so a request — and its
// bearer token — can never be retried against another origin there.
const API_BASE_URLS = configuredApiBaseUrl ? [API_BASE_URL] : uniqueUrls([API_BASE_URL, ...localApiBaseUrls()]);
const TOKEN_KEY = "techi.auth.token";
const USER_KEY = "techi.auth.user";
/** Long enough for report generation and package downloads; a hung request still ends. */
export const DEFAULT_TIMEOUT_MS = 30_000;
let unauthorizedHandler: (() => void) | null = null;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
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

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setAuthSession(token: string, user: unknown): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuthSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
}

export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
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

async function errorMessage(response: Response): Promise<string> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    if (typeof body.detail === "string") {
      message = body.detail;
    } else if (body?.detail && typeof body.detail.detail === "string") {
      // Structured error bodies (e.g. Component Actions) nest a human
      // message under detail.detail alongside a machine-readable code.
      message = body.detail.detail;
    }
  } catch {
    // Keep the HTTP status message when the response is not JSON.
  }
  return message;
}

/**
 * The one way the app talks to the API: auth header, timeout, 401 handling and
 * error messages in one place. Resolves only for a 2xx response; anything else
 * throws ApiError. Use for non-JSON bodies (text, blobs, empty responses).
 */
export async function apiFetch(path: string, init: ApiRequestInit = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...requestInit } = init;
  const method = (requestInit.method ?? "GET").toUpperCase();
  // Only a dev server tries more than one base URL, and only for reads: a
  // network error after the server processed a POST must not run it twice.
  const candidates = method === "GET" || method === "HEAD" ? API_BASE_URLS : API_BASE_URLS.slice(0, 1);
  let networkError: unknown;

  // A 401 only means "your session expired" if a session was sent.
  const sentToken = Boolean(getAuthToken());

  for (const baseUrl of candidates) {
    const timeout = withTimeout(requestInit.signal, timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...requestInit,
        signal: timeout.signal,
        headers: {
          Accept: "application/json",
          ...authHeaders(),
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
      continue;
    } finally {
      timeout.dispose();
    }

    if (!response.ok) {
      const message = await errorMessage(response);
      if (response.status === 401 && sentToken) {
        unauthorizedHandler?.();
      }
      throw new ApiError(message, response.status);
    }

    return response;
  }

  throw networkError instanceof Error ? networkError : new Error("Failed to reach backend API");
}

export async function fetchJson<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  return response.json() as Promise<T>;
}

export async function fetchText(path: string, init?: ApiRequestInit): Promise<string> {
  const response = await apiFetch(path, init);
  return response.text();
}
