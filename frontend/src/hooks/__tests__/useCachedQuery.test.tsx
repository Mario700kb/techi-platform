import { act, renderHook, waitFor } from "@testing-library/react";
import { appCache } from "../../store/appCache";
import { useCachedQuery } from "../useCachedQuery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useCachedQuery", () => {
  beforeEach(() => appCache.setScope("7"));
  afterEach(() => {
    appCache.invalidate();
    appCache.setScope("");
    window.sessionStorage.clear();
  });

  it("shows the cached copy on the first render, then the fresh answer", async () => {
    appCache.set("page.teams", ["cached"]);
    const answer = deferred<string[]>();
    const { result } = renderHook(() => useCachedQuery("page.teams", () => answer.promise));

    expect(result.current.data).toEqual(["cached"]);
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);

    await act(async () => answer.resolve(["fresh"]));
    expect(result.current.data).toEqual(["fresh"]);
    expect(appCache.peek("page.teams")).toEqual(["fresh"]);
  });

  it("is loading only while nothing is on screen", async () => {
    const { result } = renderHook(() => useCachedQuery("page.reports", async () => [1, 2]));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual([1, 2]));
    expect(result.current.loading).toBe(false);
  });

  it("persists page.* across a reload but keeps mem.* in memory", async () => {
    const { result } = renderHook(() => useCachedQuery("mem.vault", async () => ["secret-meta"]));
    await waitFor(() => expect(result.current.data).toEqual(["secret-meta"]));
    renderHook(() => useCachedQuery("page.audit-free", async () => ["ok"]));
    await waitFor(() => expect(appCache.peek("page.audit-free")).toEqual(["ok"]));

    const stored = Object.keys(window.sessionStorage);
    expect(stored.some((k) => k.endsWith(":page.audit-free"))).toBe(true);
    expect(stored.some((k) => k.includes("mem.vault"))).toBe(false);
  });

  it("drops an answer for a key the screen has moved away from", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetchers: Record<string, () => Promise<string>> = {
      "page.device.1": () => first.promise,
      "page.device.2": () => second.promise,
    };
    const { result, rerender } = renderHook(({ key }) => useCachedQuery(key, fetchers[key]), {
      initialProps: { key: "page.device.1" },
    });
    rerender({ key: "page.device.2" });
    await act(async () => second.resolve("two"));
    await act(async () => first.resolve("one"));
    expect(result.current.data).toBe("two");
    expect(appCache.peek("page.device.1")).toBeNull();
  });

  it("keeps the cached copy on a failed refresh and reports the error", async () => {
    appCache.set("page.packages", ["v1"]);
    const { result } = renderHook(() =>
      useCachedQuery("page.packages", () => Promise.reject(new Error("Network down"))),
    );
    await waitFor(() => expect(result.current.error).toBe("Network down"));
    expect(result.current.data).toEqual(["v1"]);
  });

  it("setData updates the screen and the cached copy", async () => {
    const { result } = renderHook(() => useCachedQuery("page.notes", async () => ["a"]));
    await waitFor(() => expect(result.current.data).toEqual(["a"]));
    act(() => result.current.setData((prev) => [...(prev ?? []), "b"]));
    expect(result.current.data).toEqual(["a", "b"]);
    expect(appCache.peek("page.notes")).toEqual(["a", "b"]);
  });
});
