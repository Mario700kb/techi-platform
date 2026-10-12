import { useSyncExternalStore } from "react";
import {
  AuthSession,
  AuthUser,
  exchangeLegacyToken,
  getAuthSession,
  login as loginRequest,
  loginWithMfa,
  logout as logoutRequest,
} from "../api/auth";
import {
  ApiError,
  refreshSession,
  setMfaEnrollmentHandler,
  setSessionActive,
  setSessionRefreshedHandler,
  setUnauthorizedHandler,
  takeLegacyToken,
} from "../api/client";

// The session itself lives in HttpOnly cookies the page cannot read. This
// tab-scoped copy of the user and permissions only lets a reload draw the
// shell at once; it is re-verified against the server on every boot.
const SESSION_STORAGE_KEY = "techi.auth.session";

interface PersistedSession {
  user: AuthUser;
  permissions: string[];
}

export interface SessionSnapshot {
  user: AuthUser | null;
  permissions: string[] | null;
  loading: boolean;
  /** When the server ends this session regardless of activity (ISO, UTC). */
  sessionExpiresAt: string | null;
  /** The operator's role requires two-factor authentication they have not set up. */
  mfaEnrollmentRequired: boolean;
}

type Listener = () => void;

function readPersistedSession(): PersistedSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    return parsed.user && Array.isArray(parsed.permissions) ? (parsed as PersistedSession) : null;
  } catch {
    return null;
  }
}

const persisted = readPersistedSession();
let snapshot: SessionSnapshot = {
  user: persisted?.user ?? null,
  permissions: persisted?.permissions ?? null,
  // With a cached user the shell draws at once while the boot check runs.
  loading: !persisted,
  sessionExpiresAt: null,
  mfaEnrollmentRequired: false,
};
setSessionActive(Boolean(persisted));
let bootstrapPromise: Promise<void> | null = null;
let renewalTimer: ReturnType<typeof setTimeout> | null = null;
let renewalDueAt: number | null = null;
let sessionGeneration = 0;
const listeners = new Set<Listener>();

function emit(next: SessionSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function persistSession(session: AuthSession): void {
  try {
    window.sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ user: session.user, permissions: session.permissions } satisfies PersistedSession),
    );
  } catch {
    // Storage blocked: the next reload simply waits for the session check.
  }
}

/** Renew this long before the access cookie expires. */
const RENEW_BEFORE_MS = 60_000;

function cancelRenewal(): void {
  if (renewalTimer) clearTimeout(renewalTimer);
  renewalTimer = null;
  renewalDueAt = null;
}

/**
 * Renews the access cookie a minute before it expires, so requests never hit
 * a 401 first (each such 401 used to show in the console and delay the
 * request by a round trip). The 401 → refresh → retry path in apiFetch stays
 * as the fallback, e.g. after a laptop wakes from sleep.
 */
function scheduleRenewal(accessExpiresAt: string | null | undefined): void {
  cancelRenewal();
  if (!accessExpiresAt) return;
  const expires = Date.parse(accessExpiresAt);
  if (Number.isNaN(expires)) return;
  renewalDueAt = expires - RENEW_BEFORE_MS;
  renewalTimer = setTimeout(
    () => {
      renewalTimer = null;
      void refreshSession();
    },
    Math.max(renewalDueAt - Date.now(), 5_000),
  );
}

// Background tabs throttle timers; catch up as soon as the tab is shown.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && renewalDueAt !== null && Date.now() >= renewalDueAt) {
      cancelRenewal();
      void refreshSession();
    }
  });
}

function applyAuthenticatedSession(session: AuthSession): void {
  persistSession(session);
  setSessionActive(true);
  scheduleRenewal(session.access_expires_at);
  emit({
    user: session.user,
    permissions: session.permissions,
    loading: false,
    sessionExpiresAt: session.session_expires_at,
    mfaEnrollmentRequired: session.mfa_enrollment_required,
  });
}

/** Forgets the session in this tab. Does not tell the server; see logoutSession. */
export function clearSession(): void {
  sessionGeneration += 1;
  cancelRenewal();
  setSessionActive(false);
  try {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage blocked.
  }
  bootstrapPromise = null;
  emit({ user: null, permissions: null, loading: false, sessionExpiresAt: null, mfaEnrollmentRequired: false });
}

/** Signs out: the server revokes the session and clears the cookies. */
export async function logoutSession(): Promise<void> {
  clearSession();
  await logoutRequest();
}

// Mobile UI 2.0 (MOBILE-DESIGN-SPEC.md — Login/Error States, audit finding
// B9): a 401 must not silently drop the user on /login with no explanation.
// Only THIS path (the API client's unauthorized callback) sets the flag —
// a manual logout() still calls clearSession() directly, unflagged.
export const SESSION_EXPIRED_FLAG = "techi.auth.expired";

function handleUnauthorized(): void {
  try {
    window.sessionStorage.setItem(SESSION_EXPIRED_FLAG, "1");
  } catch {
    // Storage blocked.
  }
  clearSession();
}

setUnauthorizedHandler(handleUnauthorized);
setMfaEnrollmentHandler(() => {
  if (!snapshot.mfaEnrollmentRequired) emit({ ...snapshot, mfaEnrollmentRequired: true });
});
setSessionRefreshedHandler(({ sessionExpiresAt, accessExpiresAt }) => {
  if (!snapshot.user) return;
  scheduleRenewal(accessExpiresAt);
  emit({ ...snapshot, sessionExpiresAt });
});

/**
 * Asks the server who is signed in. An expired access cookie is renewed with
 * the refresh cookie first; a bearer token left by the pre-cookie frontend is
 * exchanged for cookies once, so upgrading signs nobody out.
 */
async function loadSession(): Promise<AuthSession | null> {
  const legacy = takeLegacyToken();
  if (legacy) await exchangeLegacyToken(legacy);
  // null: no session cookie at all — signed out, nothing to renew (no 401s).
  // 401: a session whose access cookie expired — renew it once.
  try {
    return await getAuthSession();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
  }
  if (!(await refreshSession())) return null;
  return getAuthSession();
}

/** After signing in or a change to the session the server must have one. */
async function requireSession(): Promise<AuthSession> {
  const session = await getAuthSession();
  if (!session) throw new ApiError("Not signed in", 401);
  return session;
}

export function bootstrapSession(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;

  const generation = sessionGeneration;
  // With a cached user the session counts as active from the start, so the
  // pages' own requests renew an expired access cookie while this runs.
  // Without one, a 401 here just means "not signed in".
  const hadCachedUser = Boolean(snapshot.user);
  bootstrapPromise = loadSession()
    .then((session) => {
      if (sessionGeneration !== generation) return;
      if (session) {
        applyAuthenticatedSession(session);
      } else {
        if (hadCachedUser) handleUnauthorized();
        else clearSession();
      }
    })
    .catch(() => {
      // Network trouble: keep a cached user (requests will retry); without
      // one there is nothing to show but the sign-in page.
      if (sessionGeneration !== generation) return;
      setSessionActive(hadCachedUser);
      emit({ ...snapshot, loading: false });
    })
    .finally(() => {
      bootstrapPromise = null;
    });
  return bootstrapPromise;
}

/** Re-reads the session, e.g. after turning on two-factor authentication. */
export async function reloadSession(): Promise<void> {
  const generation = sessionGeneration;
  const session = await requireSession();
  if (sessionGeneration === generation) applyAuthenticatedSession(session);
}

async function completeSignIn(generation: number): Promise<void> {
  setSessionActive(true);
  const session = await requireSession();
  if (sessionGeneration === generation) applyAuthenticatedSession(session);
}

/** Password step. Resolves with an MFA challenge when the account has 2FA on. */
export async function loginSession(username: string, password: string): Promise<{ mfaToken: string } | null> {
  const generation = ++sessionGeneration;
  const result = await loginRequest(username, password);
  if (result.mfa_required && result.mfa_token) return { mfaToken: result.mfa_token };
  await completeSignIn(generation);
  return null;
}

/** Second step of a two-factor sign-in. */
export async function completeMfaLogin(mfaToken: string, code: string): Promise<void> {
  const generation = ++sessionGeneration;
  await loginWithMfa(mfaToken, code);
  await completeSignIn(generation);
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
