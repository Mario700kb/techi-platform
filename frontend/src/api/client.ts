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
const API_BASE_URLS = uniqueUrls([API_BASE_URL, ...localApiBaseUrls()]);
const TOKEN_KEY = "techi.auth.token";
const USER_KEY = "techi.auth.user";
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

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  let networkError: unknown;

  // A 401 only means "your session expired" if a session was sent.
  const sentToken = Boolean(getAuthToken());

  for (const baseUrl of API_BASE_URLS) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
          ...init?.headers,
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      networkError = error;
      continue;
    }

    if (!response.ok) {
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

      if (response.status === 401 && sentToken) {
        unauthorizedHandler?.();
      }
      throw new ApiError(message, response.status);
    }

    return response.json() as Promise<T>;
  }

  throw networkError instanceof Error ? networkError : new Error("Failed to reach backend API");
}
