// Minimal service worker: makes the app installable; caches only static assets (never client data).
const CACHE = 'l2c-static-v1';
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/style.css', '/app.js', '/icon.svg']))));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method === 'GET' && ['/style.css', '/app.js', '/icon.svg'].includes(u.pathname)) e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
