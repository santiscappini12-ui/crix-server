const CACHE_NAME = 'crix-shell-v12';
const SHELL = ['/', '/manifest.webmanifest', '/crix-icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-72.png'];
const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-72.png';

self.addEventListener('install', event => {
  // IMPORTANTE: cache.addAll() falla entera si UN solo archivo da 404 y entonces el service worker nunca se
  // instala (y sin service worker no hay notificaciones push). Se cachea archivo por archivo y los que falten se ignoran.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
      .catch(() => {})
  );
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
    // El HTML viene siempre de la red (con ?n=... incluido); sin conexión se usa la copia guardada.
    const key = new Request('/');
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        fetch(request).then(response => {
          if (!response.ok) return response;
          const cachedResponse = response.clone();
          return cache.put(key, cachedResponse).then(() => response, () => response);
        }).catch(() => cache.match(key))
      )
    );
    return;
  }

  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});

// ═══ Notificaciones push ═══
// El servidor solo manda push cuando la persona no tiene Crix a la vista, así que siempre se muestra algo
// (iOS y Chrome exigen una notificación visible por cada push).
function describe(d) {
  const name = d.fromName || 'Alguien';
  switch (d.type) {
    case 'call':
      return {
        title: name + ' te llama',
        body: d.callType === 'video' ? '📹 Videollamada entrante' : '📞 Llamada de voz entrante',
        tag: d.tag || 'call', renotify: true, requireInteraction: true,
        vibrate: [400, 200, 400, 200, 400, 200, 400, 200, 400],
        actions: [{ action: 'accept', title: 'Contestar' }, { action: 'decline', title: 'Rechazar' }]
      };
    case 'call_cancel':
      return {
        title: 'Llamada perdida',
        body: (d.callType === 'video' ? '📹 Videollamada' : '📞 Llamada') + ' de ' + name,
        tag: 'missed-' + (d.from || ''), renotify: true, vibrate: [200, 100, 200]
      };
    case 'message':
      return { title: name, body: '💬 Te envió un mensaje cifrado', tag: d.tag || 'msg', renotify: true, vibrate: [300, 150, 300, 150, 300] };
    case 'friend_request':
      return { title: 'Solicitud de amistad', body: name + ' quiere ser tu amigo en Crix', tag: d.tag || 'friend', renotify: true, vibrate: [150, 80, 150] };
    case 'friend_accepted':
      return { title: 'Solicitud aceptada', body: name + ' ahora es tu amigo en Crix', tag: d.tag || 'friend-ok', renotify: true, vibrate: [150, 80, 150] };
    default:
      return { title: d.title || 'Crix', body: d.body || '', tag: d.tag || 'crix', renotify: true };
  }
}

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  const info = describe(d);
  event.waitUntil((async () => {
    // Una llamada cancelada hace desaparecer el timbre antes de mostrar "Llamada perdida".
    if (d.type === 'call_cancel') {
      const open = await self.registration.getNotifications();
      open.filter(n => (n.tag || '').startsWith('call-' + (d.from || ''))).forEach(n => n.close());
      if (!d.missed) return;
    }
    const data = { type: d.type, from: d.from, url: d.url || '/' };
    try {
      await self.registration.showNotification(info.title, {
        body: info.body, tag: info.tag, renotify: info.renotify, requireInteraction: !!info.requireInteraction,
        vibrate: info.vibrate, actions: info.actions, icon: ICON, badge: BADGE, silent: false,
        timestamp: Date.now(), data
      });
    } catch (err) {
      // Algunos navegadores (iOS/Safari sobre todo) rechazan opciones que no soportan y entonces no se muestra
      // nada. Se reintenta con lo mínimo para que el aviso aparezca siempre.
      try { await self.registration.showNotification(info.title, { body: info.body, tag: info.tag, icon: ICON, data }); }
      catch { await self.registration.showNotification(info.title, { body: info.body, data }); }
    }
  })());
});

self.addEventListener('notificationclick', event => {
  const n = event.notification, data = n.data || {};
  n.close();
  // Una llamada genera varios avisos apilados: al tocar uno se quitan todos los de esa persona.
  if (data.type === 'call') event.waitUntil(self.registration.getNotifications().then(list => list.filter(x => (x.tag || '').startsWith('call-' + (data.from || ''))).forEach(x => x.close())));
  const action = event.action || '';
  const msg = { crixNotif: true, type: data.type, from: data.from, action };
  // Si la app no está abierta, se abre con los datos en la URL y el cliente los procesa al iniciar sesión.
  let target = new URL(data.url || '/', self.location.origin);
  if (action) target.searchParams.set('a', action);
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = list.find(c => c.url.startsWith(self.location.origin));
    // "Colgar" desde el aviso de llamada en curso: se corta sin traer la app al frente.
    if (data.type === 'call_ongoing' && action === 'hangup') { list.forEach(c => c.postMessage(msg)); return; }
    if (existing) {
      try { await existing.focus(); } catch {}
      existing.postMessage(msg);
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

// Si el navegador renueva la suscripción, la app la vuelve a registrar al abrirse.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(self.clients.matchAll({ includeUncontrolled: true }).then(list => list.forEach(c => c.postMessage({ crixResubscribe: true }))));
});
