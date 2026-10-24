import { vi } from "vitest";

import { appCache, CACHE_KEYS } from "../appCache";

describe("appCache persistence", () => {
  afterEach(() => {
    appCache.invalidate();
    appCache.setScope("");
    window.sessionStorage.clear();
  });

  it("brings a persisted entry back after a reload (memory lost) for the same operator", () => {
    appCache.setScope("7");
    appCache.set(CACHE_KEYS.clientsList, [{ id: 1, name: "Northwind" }]);
    appCache.setScope(""); // reload: memory starts empty
    appCache.setScope("7");
    expect(appCache.peek(CACHE_KEYS.clientsList)).toEqual([{ id: 1, name: "Northwind" }]);
  });

  it("restores the dashboard's sections (operators included) after a reload", () => {
    appCache.setScope("7");
    appCache.set(CACHE_KEYS.operatorPresence, [{ id: 1, is_online: true }]);
    appCache.setScope("");
    appCache.setScope("7");
    expect(appCache.peek(CACHE_KEYS.operatorPresence)).toEqual([{ id: 1, is_online: true }]);
  });

  it("never shows one operator's entries to another", () => {
    appCache.setScope("7");
    appCache.set("devices-table|1|20", { devices: [{ id: 1 }], total: 1 });
    appCache.setScope("8");
    expect(appCache.peek("devices-table|1|20")).toBeNull();
  });

  it("keeps other keys in memory only", () => {
    appCache.setScope("7");
    appCache.set(CACHE_KEYS.operatorsList, [{ id: 2 }]);
    expect(Object.keys(window.sessionStorage).some((k) => k.includes(CACHE_KEYS.operatorsList))).toBe(false);
  });

  it("sign-out (invalidate everything) removes the persisted copies", () => {
    appCache.setScope("7");
    appCache.set(CACHE_KEYS.groupsList, [{ id: 3 }]);
    appCache.invalidate();
    appCache.setScope("");
    appCache.setScope("7");
    expect(appCache.peek(CACHE_KEYS.groupsList)).toBeNull();
    expect(Object.keys(window.sessionStorage).filter((k) => k.startsWith("techi.cache.v1:"))).toEqual([]);
  });

  it("patch replaces an entry's data but keeps its age, and never creates one", () => {
    vi.useFakeTimers();
    try {
      appCache.setScope("7");
      appCache.set("devices-table|1|20", { devices: [{ id: 1, client_id: 1 }], total: 1 });
      vi.advanceTimersByTime(20_000);
      appCache.patch("devices-table|1|20", { devices: [{ id: 1, client_id: 2 }], total: 1 });
      expect(appCache.get("devices-table|1|20", 30_000)).toEqual({ devices: [{ id: 1, client_id: 2 }], total: 1 });
      // Still as old as the fetch: stale 30 s after it, not 30 s after the patch.
      vi.advanceTimersByTime(11_000);
      expect(appCache.get("devices-table|1|20", 30_000)).toBeNull();
      // The persisted copy carries the patch too.
      appCache.setScope("");
      appCache.setScope("7");
      expect(appCache.peek("devices-table|1|20")).toEqual({ devices: [{ id: 1, client_id: 2 }], total: 1 });

      appCache.patch("devices-table|2|20", { devices: [], total: 0 });
      expect(appCache.peek("devices-table|2|20")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a prefix invalidation reaches the persisted copies too", () => {
    appCache.setScope("7");
    appCache.set("devices-table|1|20", { devices: [], total: 0 });
    appCache.invalidatePrefix("devices-table");
    appCache.setScope("");
    appCache.setScope("7");
    expect(appCache.peek("devices-table|1|20")).toBeNull();
  });
});
