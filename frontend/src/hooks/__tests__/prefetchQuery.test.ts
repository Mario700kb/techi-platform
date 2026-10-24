import { afterEach, describe, expect, it, vi } from "vitest";

import { appCache } from "../../store/appCache";
import { prefetchQuery } from "../useCachedQuery";

describe("prefetchQuery", () => {
  afterEach(() => appCache.invalidate());

  it("loads into the cache once, however often the pointer comes back", async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: 1, action_type: "ping" }]);
    prefetchQuery("page.device.7.actions", fetcher);
    prefetchQuery("page.device.7.actions", fetcher); // still loading
    await vi.waitFor(() => expect(appCache.peek("page.device.7.actions")).not.toBeNull());
    prefetchQuery("page.device.7.actions", fetcher); // fresh copy cached
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(appCache.peek("page.device.7.actions")).toEqual([{ id: 1, action_type: "ping" }]);
  });

  it("leaves a failure for the real query to show", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    prefetchQuery("page.device.8.actions", fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0)); // the failed request has settled
    expect(appCache.peek("page.device.8.actions")).toBeNull();
    prefetchQuery("page.device.8.actions", fetcher); // may try again
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});
