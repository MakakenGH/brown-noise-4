/**
 * Service Worker — Cache-first strategy for offline PWA support.
 */
const CACHE = 'deep-noise-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './noise-worklet.js',
  './icon.svg',
  './manifest.json',
];

// Pre-cache all app-shell assets on install
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

// Purge old caches on activate
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Serve from cache, fall back to network; navigations fall back to index.html
self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      return fetch(e.request);
    })
  );
});
