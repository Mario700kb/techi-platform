// The store keeps module state, so each test imports a fresh copy.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SESSION = {
  user: { id: 1, username: "alice", role: "operator" },
  permissions: ["view_devices"],
  denied: [],
  session_expires_at: "2026-10-12T20:00:00Z",
  mfa_enrollment_required: false,
};

async function freshStore() {
  vi.resetModules();
  return import("../sessionStore");
}

describe("sessionStore boot", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("moves a pre-upgrade localStorage token to a cookie session without a new sign-in", async () => {
    window.localStorage.setItem("techi.auth.token", "legacy-jwt");
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/v1/auth/token-exchange")) {
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer legacy-jwt");
        return jsonResponse({ mfa_required: false });
      }
      if (url.endsWith("/api/v1/auth/session")) return jsonResponse(SESSION);
      throw new Error(`unexpected ${url}`);
    });
    const store = await freshStore();
    await store.bootstrapSession();

    expect(store.getSessionSnapshot().user?.username).toBe("alice");
    expect(window.localStorage.getItem("techi.auth.token")).toBeNull();
  });

  it("renews an expired access cookie with the refresh cookie at boot", async () => {
    let sessionCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/v1/auth/session")) {
        sessionCalls += 1;
        return sessionCalls === 1 ? jsonResponse({ detail: "expired" }, 401) : jsonResponse(SESSION);
      }
      if (url.endsWith("/api/v1/auth/refresh")) return jsonResponse({ session_expires_at: SESSION.session_expires_at });
      throw new Error(`unexpected ${url}`);
    });
    const store = await freshStore();
    await store.bootstrapSession();

    const snapshot = store.getSessionSnapshot();
    expect(snapshot.user?.username).toBe("alice");
    expect(snapshot.sessionExpiresAt).toBe(SESSION.session_expires_at);
  });

  it("lands on sign-in, without the 'session expired' notice, when nobody is signed in", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/v1/auth/session")) return jsonResponse({ detail: "no" }, 401);
      if (url.endsWith("/api/v1/auth/refresh")) return jsonResponse({ detail: "no" }, 401);
      throw new Error(`unexpected ${url}`);
    });
    const store = await freshStore();
    await store.bootstrapSession();

    expect(store.getSessionSnapshot()).toMatchObject({ user: null, loading: false });
    expect(window.sessionStorage.getItem(store.SESSION_EXPIRED_FLAG)).toBeNull();
  });

  it("asks once and makes no failed request when this browser holds no session (204)", async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/api/v1/auth/session")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${url}`);
    });
    const store = await freshStore();
    await store.bootstrapSession();

    expect(store.getSessionSnapshot()).toMatchObject({ user: null, loading: false });
    expect(calls.filter((u) => u.endsWith("/api/v1/auth/refresh"))).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(window.sessionStorage.getItem(store.SESSION_EXPIRED_FLAG)).toBeNull();
  });

  it("returns the MFA challenge from the password step without signing in", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/v1/auth/login")) return jsonResponse({ mfa_required: true, mfa_token: "challenge" });
      throw new Error(`unexpected ${url}`);
    });
    const store = await freshStore();
    await expect(store.loginSession("alice", "pw")).resolves.toEqual({ mfaToken: "challenge" });
    expect(store.getSessionSnapshot().user).toBeNull();
  });

  it("renews the access cookie a minute before it expires, without waiting for a 401", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const now = Date.now();
      let refreshes = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith("/api/v1/auth/session")) {
          return jsonResponse({ ...SESSION, access_expires_at: new Date(now + 15 * 60_000).toISOString() });
        }
        if (url.endsWith("/api/v1/auth/refresh")) {
          refreshes += 1;
          return jsonResponse({
            session_expires_at: SESSION.session_expires_at,
            access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          });
        }
        throw new Error(`unexpected ${url}`);
      });
      const store = await freshStore();
      await store.bootstrapSession();

      await vi.advanceTimersByTimeAsync(13 * 60_000);
      expect(refreshes).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000 + 1);
      expect(refreshes).toBe(1);
      // The renewed cookie schedules the next renewal the same way.
      await vi.advanceTimersByTimeAsync(14 * 60_000 + 1);
      expect(refreshes).toBe(2);

      store.clearSession();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(refreshes).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
