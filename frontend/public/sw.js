// Minimal service worker — satisfies PWA installability.
// Network-first, no aggressive caching: this is a live-data dashboard and
// stale API responses would cause confusion. Falls back to cache only if
// the network is completely unreachable (e.g. airplane mode).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
