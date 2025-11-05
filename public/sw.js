// Custom Tube service worker: makes the app installable and lets its screens open offline.
// - Pages: network first, falling back to the cached app shell (every route is the same shell).
// - /static/*: versioned per deploy, so served from cache, refreshed in the background.
// - /api/*: always the network. Feeds and searches are never served stale.
// The server fills in __VERSION__ (a hash of this deploy's files); a new deploy is a new cache.
const VERSION = '__VERSION__';
const CACHE = `customtube-${VERSION}`;
const SHELL = ['/', `/static/app.js?v=${VERSION}`, `/static/styles.css?v=${VERSION}`, '/static/favicon.svg', '/static/icon.svg', '/static/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          // keep the offline shell as fresh as the last page that loaded
          // only the app page itself (marked by the server), not e.g. /static/licenses.txt
          if (res.ok && res.headers.get('x-app-shell') === '1') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(async () => (await caches.match('/')) || Response.error()),
    );
    return;
  }

  if (url.pathname.startsWith('/static/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const fresh = fetch(request)
          .then((res) => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || fresh;
      }),
    );
  }
});
