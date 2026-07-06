// Service worker — Mobile UI 2.0 (MOBILE-DESIGN-SPEC.md — Offline States;
// audit finding B2: a full white screen on true offline).
//
// API/WebSocket traffic is NEVER cached — this is a live-data dashboard and
// stale API responses would cause confusion; the frontend's own
// OfflineBanner communicates staleness instead.
//
// Static assets (JS/CSS/fonts/images) ARE cached opportunistically at
// runtime (every successful fetch populates the cache), so a build's
// hashed filenames don't need to be known ahead of time. Navigations fall
// back to the cached app shell ("/") when offline, so the app boots
// instead of showing a blank page; the SPA's own router then renders
// whatever route was requested.
const SHELL_CACHE = "techi-shell-v1";
const RUNTIME_CACHE = "techi-runtime-v1";
const SHELL_URLS = ["/", "/manifest.json"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).catch(() => undefined),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // API and WebSocket traffic: always network, never cached.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) {
    return;
  }

  // Navigations (HTML documents): network-first, cached shell on failure.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/", { ignoreSearch: true })),
    );
    return;
  }

  // Static assets: stale-while-revalidate via a runtime cache.
  event.respondWith(
    caches.open(RUNTIME_CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    }),
  );
});
