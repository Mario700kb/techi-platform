import { beforeEach, describe, expect, it, vi } from "vitest";
import swSource from "../../public/sw.js?raw";

const ORIGIN = "https://rdp.techi.com.al";

type Req = { method: string; url: string; mode?: string };
const keyOf = (req: Req | string) => (typeof req === "string" ? new URL(req, ORIGIN).href : req.url);

class FakeCache {
  store = new Map<string, Response>();
  async match(req: Req | string) {
    return this.store.get(keyOf(req));
  }
  async put(req: Req | string, res: Response) {
    this.store.set(keyOf(req), res);
  }
  async addAll(urls: string[]) {
    for (const u of urls) this.store.set(keyOf(u), new Response(`cached ${u}`));
  }
  async keys() {
    return [...this.store.keys()].map((url) => ({ method: "GET", url }));
  }
  async delete(req: Req) {
    return this.store.delete(keyOf(req));
  }
}

function loadWorker(fetchImpl: (req: Req) => Promise<Response>) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const named = new Map<string, FakeCache>();
  const caches = {
    async open(name: string) {
      if (!named.has(name)) named.set(name, new FakeCache());
      return named.get(name)!;
    },
    async match(req: Req | string) {
      for (const cache of named.values()) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      return undefined;
    },
    async keys() {
      return [...named.keys()];
    },
    async delete(name: string) {
      return named.delete(name);
    },
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] = fn),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  new Function("self", "caches", "fetch", swSource)(self, caches, fetchImpl);

  async function request(req: Req) {
    let responded: Promise<Response> | undefined;
    const background: Promise<unknown>[] = [];
    listeners.fetch({
      request: req,
      respondWith: (p: Promise<Response>) => (responded = p),
      waitUntil: (p: Promise<unknown>) => background.push(p),
    });
    const res = responded ? await responded : undefined;
    await Promise.all(background);
    await new Promise((r) => setTimeout(r, 0)); // let fire-and-forget cache writes land
    return res;
  }
  return { request, caches, named };
}

const nav = (path: string): Req => ({ method: "GET", url: ORIGIN + path, mode: "navigate" });
const asset = (path: string): Req => ({ method: "GET", url: ORIGIN + path, mode: "cors" });

describe("service worker", () => {
  let fetchMock: ReturnType<typeof vi.fn<(req: Req) => Promise<Response>>>;
  beforeEach(() => {
    fetchMock = vi.fn<(req: Req) => Promise<Response>>();
  });

  it("answers a failed navigation with a real offline page when nothing is cached", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const sw = loadWorker(fetchMock);

    const res = await sw.request(nav("/login"));

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(503);
    expect(await res!.text()).toContain("TECHI Connect is unreachable");
  });

  it("falls back to the cached app shell, refreshed by the last successful navigation", async () => {
    const sw = loadWorker(fetchMock);
    fetchMock.mockResolvedValueOnce(new Response("<html>build 2</html>", { status: 200 }));
    await sw.request(nav("/devices"));

    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const res = await sw.request(nav("/alerts"));

    expect(await res!.text()).toBe("<html>build 2</html>");
  });

  it("never caches a failed or redirected navigation as the shell", async () => {
    const sw = loadWorker(fetchMock);
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await sw.request(nav("/"));
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 502 }));
    await sw.request(nav("/"));

    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await (await sw.request(nav("/x")))!.text()).toBe("ok");
  });

  it("answers an uncached asset that cannot be fetched with a network error, not undefined", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const sw = loadWorker(fetchMock);

    const res = await sw.request(asset("/assets/index-abc.js"));

    expect(res).toBeInstanceOf(Response);
    expect(res!.type).toBe("error");
  });

  it("serves a cached asset at once and refreshes it in the background", async () => {
    const sw = loadWorker(fetchMock);
    const fresh = Object.assign(new Response("v1", { status: 200 }), {});
    Object.defineProperty(fresh, "type", { value: "basic" });
    fetchMock.mockResolvedValueOnce(fresh);
    await sw.request(asset("/assets/app.js"));

    const newer = new Response("v2", { status: 200 });
    Object.defineProperty(newer, "type", { value: "basic" });
    fetchMock.mockResolvedValueOnce(newer);
    const res = await sw.request(asset("/assets/app.js"));

    expect(await res!.text()).toBe("v1");
    const runtime = sw.named.get("techi-runtime-v2")!;
    expect(await (await runtime.match(asset("/assets/app.js")))!.text()).toBe("v2");
  });

  it("keeps the runtime cache bounded", async () => {
    const sw = loadWorker(fetchMock);
    fetchMock.mockImplementation(async () => {
      const res = new Response("x", { status: 200 });
      Object.defineProperty(res, "type", { value: "basic" });
      return res;
    });
    for (let i = 0; i < 160; i += 1) await sw.request(asset(`/assets/chunk-${i}.js`));

    const runtime = sw.named.get("techi-runtime-v2")!;
    expect(runtime.store.size).toBe(150);
    expect(runtime.store.has(`${ORIGIN}/assets/chunk-0.js`)).toBe(false);
    expect(runtime.store.has(`${ORIGIN}/assets/chunk-159.js`)).toBe(true);
  });

  it("leaves API, other origins and non-GET requests to the browser", async () => {
    const sw = loadWorker(fetchMock);
    expect(await sw.request({ method: "GET", url: `${ORIGIN}/api/v1/auth/session` })).toBeUndefined();
    expect(await sw.request({ method: "GET", url: "chrome-extension://abc/x.js" })).toBeUndefined();
    expect(await sw.request({ method: "POST", url: `${ORIGIN}/devices` })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
