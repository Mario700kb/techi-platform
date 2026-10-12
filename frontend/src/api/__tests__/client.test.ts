import {
  apiFetch,
  ApiError,
  fetchJson,
  setMfaEnrollmentHandler,
  setSessionActive,
  setUnauthorizedHandler,
  takeLegacyToken,
} from "../client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("api client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    setSessionActive(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setUnauthorizedHandler(null);
    setMfaEnrollmentHandler(null);
    setSessionActive(false);
    window.localStorage.clear();
  });

  it("sends the session cookie and the CSRF header, never a bearer token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: 1 }));
    await expect(fetchJson("/api/v1/x")).resolves.toEqual({ ok: 1 });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.credentials).toBe("include");
    expect(init.headers["X-TECHI-CSRF"]).toBe("1");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("surfaces the server's detail message as ApiError", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "Device not found" }, 404));
    await expect(fetchJson("/api/v1/x")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "Device not found",
    });
  });

  it("renews an expired session once and repeats the request", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ session_expires_at: "2026-10-12T20:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse({ ok: 2 }));
    await expect(fetchJson("/api/v1/x")).resolves.toEqual({ ok: 2 });
    expect(fetchMock.mock.calls[1][0]).toContain("/api/v1/auth/refresh");
  });

  it("shares one refresh between parallel requests (the refresh token rotates)", async () => {
    let refreshes = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/v1/auth/refresh")) {
        refreshes += 1;
        return jsonResponse({ session_expires_at: "2026-10-12T20:00:00Z" });
      }
      return refreshes === 0 ? jsonResponse({ detail: "expired" }, 401) : jsonResponse({ ok: true });
    });
    await Promise.all([fetchJson("/api/v1/a"), fetchJson("/api/v1/b"), fetchJson("/api/v1/c")]);
    expect(refreshes).toBe(1);
  });

  it("signs out when the session cannot be renewed", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(jsonResponse({ detail: "expired" }, 401));
    await expect(apiFetch("/api/v1/x")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not treat a 401 before sign-in as an expired session", async () => {
    setSessionActive(false);
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(jsonResponse({ detail: "Invalid username or password" }, 401));
    await expect(apiFetch("/api/v1/auth/login", { method: "POST" })).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("routes an MFA-enrolment 403 to its handler", async () => {
    const handler = vi.fn();
    setMfaEnrollmentHandler(handler);
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: { code: "mfa_enrollment_required", detail: "Set up two-factor authentication" } }, 403),
    );
    await expect(apiFetch("/api/v1/devices")).rejects.toMatchObject({ status: 403, code: "mfa_enrollment_required" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("hands over a legacy localStorage token once and deletes it", () => {
    window.localStorage.setItem("techi.auth.token", "old");
    window.localStorage.setItem("techi.auth.user", "{}");
    expect(takeLegacyToken()).toBe("old");
    expect(takeLegacyToken()).toBeNull();
    expect(window.localStorage.getItem("techi.auth.user")).toBeNull();
  });

  it("never sends a write to a second base URL after a network error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(apiFetch("/api/v1/actions", { method: "POST" })).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns a hung request into ApiError 408", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = apiFetch("/api/v1/slow", { timeoutMs: 1000 });
    const assertion = expect(pending).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("passes a caller's own abort through as AbortError", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const controller = new AbortController();
    const pending = apiFetch("/api/v1/x", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
