import { useSyncExternalStore } from "react";
import {
  AuthSession,
  AuthUser,
  getAuthSession,
  login as loginRequest,
} from "../api/auth";
import {
  clearAuthSession,
  getAuthToken,
  setAuthSession,
  setUnauthorizedHandler,
} from "../api/client";

const SESSION_STORAGE_KEY = "techi.auth.session";

interface PersistedSession {
  token: string;
  user: AuthUser;
  permissions: string[];
}

export interface SessionSnapshot {
  token: string | null;
  user: AuthUser | null;
  permissions: string[] | null;
  loading: boolean;
}

type Listener = () => void;

function readPersistedSession(token: string | null): PersistedSession | null {
  if (!token || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    return parsed.token === token ? parsed : null;
  } catch {
    return null;
  }
}

const initialToken = getAuthToken();
const persisted = readPersistedSession(initialToken);
let snapshot: SessionSnapshot = {
  token: initialToken,
  user: persisted?.user ?? null,
  permissions: persisted?.permissions ?? null,
  loading: Boolean(initialToken && !persisted),
};
let bootstrapPromise: Promise<void> | null = null;
let sessionGeneration = 0;
const listeners = new Set<Listener>();

function emit(next: SessionSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function persistSession(token: string, session: AuthSession): void {
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
    token,
    user: session.user,
    permissions: session.permissions,
  } satisfies PersistedSession));
}

function applyAuthenticatedSession(token: string, session: AuthSession): void {
  setAuthSession(token, session.user);
  persistSession(token, session);
  emit({
    token,
    user: session.user,
    permissions: session.permissions,
    loading: false,
  });
}

export function clearSession(): void {
  sessionGeneration += 1;
  clearAuthSession();
  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }
  bootstrapPromise = null;
  emit({ token: null, user: null, permissions: null, loading: false });
}

// Mobile UI 2.0 (MOBILE-DESIGN-SPEC.md — Login/Error States, audit finding
// B9): a 401 must not silently drop the user on /login with no explanation.
// Only THIS path (the API client's unauthorized callback) sets the flag —
// a manual logout() still calls clearSession() directly, unflagged.
export const SESSION_EXPIRED_FLAG = "techi.auth.expired";

function handleUnauthorized(): void {
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(SESSION_EXPIRED_FLAG, "1");
  }
  clearSession();
}

setUnauthorizedHandler(handleUnauthorized);

export function bootstrapSession(): Promise<void> {
  if (!snapshot.token || (snapshot.user && snapshot.permissions)) {
    if (snapshot.loading) emit({ ...snapshot, loading: false });
    return Promise.resolve();
  }
  if (bootstrapPromise) return bootstrapPromise;

  emit({ ...snapshot, loading: true });
  const token = snapshot.token;
  const generation = sessionGeneration;
  bootstrapPromise = getAuthSession()
    .then((session) => {
      if (sessionGeneration === generation && snapshot.token === token) {
        applyAuthenticatedSession(token, session);
      }
    })
    .catch(() => {
      // 401 is cleared by the API client. Transient failures retain the token
      // and allow a later bootstrap retry without forcing logout.
      if (snapshot.token === token) {
        emit({ ...snapshot, loading: false });
      }
    })
    .finally(() => {
      bootstrapPromise = null;
    });
  return bootstrapPromise;
}

export async function loginSession(username: string, password: string): Promise<void> {
  const generation = ++sessionGeneration;
  const response = await loginRequest(username, password);
  if (sessionGeneration !== generation) return;
  setAuthSession(response.access_token, response.user);
  emit({
    token: response.access_token,
    user: response.user,
    permissions: null,
    loading: true,
  });
  const session = await getAuthSession();
  if (sessionGeneration === generation && snapshot.token === response.access_token) {
    applyAuthenticatedSession(response.access_token, session);
  }
}

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSessionSnapshot(): SessionSnapshot {
  return snapshot;
}

export function useSessionStore(): SessionSnapshot {
  return useSyncExternalStore(subscribeSession, getSessionSnapshot, getSessionSnapshot);
}
