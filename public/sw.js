const CACHE = 'interview-facilitator-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/assets/app.js', '/assets/app.css'];
const SHELL_PATHS = new Set(SHELL);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match('/index.html')) ?? Response.error();
      })
    );
    return;
  }

  if (!SHELL_PATHS.has(url.pathname)) return;

  event.respondWith(
    caches.open(CACHE).then((cache) => cache.match(url.pathname).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) event.waitUntil(cache.put(url.pathname, response.clone()));
      return response;
    }).catch(() => Response.error())))
  );
});
