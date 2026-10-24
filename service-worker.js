const CACHE_NAME = 'crix-shell-v6';
const SHELL = ['/', '/manifest.webmanifest', '/crix-icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  if (url.pathname === '/') {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        fetch(request).then(response => {
          if (!response.ok) return response;
          // Clone before returning the response to the page; afterward its body may be consumed.
          const cachedResponse = response.clone();
          return cache.put(request, cachedResponse).then(() => response, () => response);
        }).catch(() => cache.match(request))
      )
    );
    return;
  }

  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});
