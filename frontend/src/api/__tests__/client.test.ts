import { apiFetch, ApiError, fetchJson, setUnauthorizedHandler } from "../client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("api client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem("techi.auth.token", "tok");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setUnauthorizedHandler(null);
    window.localStorage.clear();
  });

  it("sends the bearer token and returns JSON", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: 1 }));
    await expect(fetchJson("/api/v1/x")).resolves.toEqual({ ok: 1 });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("surfaces the server's detail message as ApiError", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "Device not found" }, 404));
    await expect(fetchJson("/api/v1/x")).rejects.toMatchObject({ name: "ApiError", status: 404, message: "Device not found" });
  });

  it("calls the unauthorized handler on 401 when a session was sent", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(jsonResponse({ detail: "expired" }, 401));
    await expect(apiFetch("/api/v1/x")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("never sends a write to a second base URL after a network error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(apiFetch("/api/v1/actions", { method: "POST" })).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns a hung request into ApiError 408", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = apiFetch("/api/v1/slow", { timeoutMs: 1000 });
    const assertion = expect(pending).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("passes a caller's own abort through as AbortError", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const controller = new AbortController();
    const pending = apiFetch("/api/v1/x", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
