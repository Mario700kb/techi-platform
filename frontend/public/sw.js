// Service worker — Mobile UI 2.0 (MOBILE-DESIGN-SPEC.md — Offline States;
// audit finding B2: a full white screen on true offline).
//
// API/WebSocket traffic is NEVER cached — this is a live-data dashboard and
// stale API responses would cause confusion; the frontend's own
// OfflineBanner communicates staleness instead.
//
// Navigations are network-first; every successful one refreshes the cached
// app shell, so the offline fallback always matches the deployed build (the
// shell cached once at install pointed at assets a later deploy replaced).
// Static assets are stale-while-revalidate in a bounded runtime cache.
//
// Every respondWith() resolves to a Response. A cache miss used to resolve
// to undefined ("Failed to convert value to 'Response'", and the page did not
// load at all, e.g. while the frontend restarted during a deploy); it is now
// the cached shell, a small offline page, or Response.error().
const SHELL_CACHE = "techi-shell-v2";
const RUNTIME_CACHE = "techi-runtime-v2";
const SHELL_URL = "/";
const RUNTIME_MAX_ENTRIES = 150;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll([SHELL_URL, "/manifest.json"]))
      .catch(() => undefined),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

function offlinePage() {
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>TECHI Connect — offline</title></head>' +
    '<body style="margin:0;display:grid;place-items:center;min-height:100vh;font:15px system-ui,sans-serif;' +
    'background:#131316;color:#f5f5f7;text-align:center">' +
    '<div><p style="font-size:17px;font-weight:600;margin:0 0 6px">TECHI Connect is unreachable</p>' +
    '<p style="color:#a0a0aa;margin:0 0 18px">Check the connection, or wait a moment if an update is being installed.</p>' +
    '<a href="" style="color:#ff6b47;font-weight:600">Try again</a></div></body></html>';
  return new Response(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function trimRuntimeCache(cache) {
  const keys = await cache.keys();
  // Insertion order: the oldest entries (earlier builds' hashed assets) go first.
  for (let i = 0; i < keys.length - RUNTIME_MAX_ENTRIES; i += 1) await cache.delete(keys[i]);
}

async function handleNavigation(req) {
  try {
    const res = await fetch(req);
    // The SPA serves the same index.html for every route; keep the newest.
    // Never a redirected response: it cannot answer a navigation later.
    if (res.ok && !res.redirected) {
      const copy = res.clone();
      caches
        .open(SHELL_CACHE)
        .then((cache) => cache.put(SHELL_URL, copy))
        .catch(() => undefined);
    }
    return res;
  } catch {
    const cached = await caches.match(SHELL_URL, { ignoreSearch: true });
    return cached || offlinePage();
  }
}

async function handleAsset(event) {
  const req = event.request;
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then(async (res) => {
    if (res.ok && res.type === "basic") {
      await cache.put(req, res.clone()).catch(() => undefined);
      await trimRuntimeCache(cache).catch(() => undefined);
    }
    return res;
  });
  if (cached) {
    // Serve the cached copy now; refresh it in the background.
    event.waitUntil(network.catch(() => undefined));
    return cached;
  }
  try {
    return await network;
  } catch {
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Only this app's own origin. Browser extensions (chrome-extension://)
  // and third-party hosts pass straight through — the Cache API rejects
  // non-http(s) schemes.
  if (url.origin !== self.location.origin) return;

  // API and WebSocket traffic: always network, never cached.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;

  if (req.mode === "navigate") {
    event.respondWith(handleNavigation(req));
    return;
  }

  event.respondWith(handleAsset(event));
});
