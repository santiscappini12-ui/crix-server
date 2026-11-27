// El servidor reemplaza __CRIX_BUILD__ por un identificador que cambia con CADA actualización del código: así el caché de la app
// (PWA y web) se tira entero y se vuelve a bajar todo. Si este archivo se abre sin pasar por el servidor, queda un nombre fijo.
const BUILD = '__CRIX_BUILD__';
const CACHE_NAME = 'crix-shell-' + BUILD;
// Archivos que la persona descargó para usar sin conexión (juegos, apps, videos, accesorios). Este caché NO se borra al
// actualizar el service worker: solo se vacía cuando la persona quita la descarga (o borra los datos del sitio).
const OFFLINE_CACHE = 'crix-offline-v1';
const SHELL = ['/', '/manifest.webmanifest', '/crix-icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-72.png'];
// Código de la app: se guarda para que Crix abra sin internet (siempre se intenta primero la red, así las actualizaciones llegan igual).
const APP_FILES = ['/crix-rules-v2.js', '/crix-rules.js', '/crix-report.js', '/crix-console.js', '/crix-native.js', '/crix-gfx.js', '/GLTFLoader.js', '/crix-avatar.js', '/crix-joints.js', '/crix-objects.js', '/crix-anim.js',
  '/socket.io/socket.io.js', '/crix-rigid.js', '/crix-predict.js', '/crix-rapier.js', '/crix-fx.js', '/crix-ext.js', '/crix-animator.js', '/crix-csg.js', '/crix-edit.js',
  '/crix-offline.js', '/crix-avatar.glb', '/death-scream.mp3', '/favicon.svg', '/favicon-48.png', '/crix-loading.gif', '/crix-splash.gif', '/discover-banner.jpg', '/icons/apple-touch-icon.png', '/icons/icon-maskable-512.png'];
const CDN_FILES = ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'];
const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-72.png';

self.addEventListener('install', event => {
  // IMPORTANTE: cache.addAll() falla entera si UN solo archivo da 404 y entonces el service worker nunca se
  // instala (y sin service worker no hay notificaciones push). Se cachea archivo por archivo y los que falten se ignoran.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled([
        ...SHELL.concat(APP_FILES).map(url => cache.add(new Request(url, { cache:'reload' }))),   // 'reload' = salta el caché HTTP del navegador
        ...CDN_FILES.map(url => fetch(url, { mode: 'cors' }).then(r => r.ok ? cache.put(url, r) : null))
      ]))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  // Formatea TODO lo que no sea el caché actual ni las descargas sin conexión que la persona eligió (esas se conservan a propósito).
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter(key => key !== CACHE_NAME && key !== OFFLINE_CACHE);
    await Promise.all(stale.map(key => caches.delete(key)));
    await self.clients.claim();
    // Si había una versión anterior instalada, las pestañas abiertas se recargan para usar el código nuevo.
    if (stale.some(k => k.startsWith('crix-shell-'))) {
      const all = await self.clients.matchAll({ type:'window' });
      all.forEach(c => c.postMessage({ crixUpdated:true, build:BUILD }));
    }
  })());
});

// ── Respuestas desde lo descargado ──
// Soporta rangos (Range) para que <video> y <audio> puedan adelantar y retroceder desde el archivo guardado.
async function rangeFrom(response, request) {
  const range = request.headers.get('range');
  if (!range || response.status !== 200) return response;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m) return response;
  const blob = await response.blob(), size = blob.size;   // Blob: el navegador no carga el archivo entero en memoria
  let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  const headers = new Headers(response.headers);
  headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + size); headers.set('Content-Length', String(end - start + 1)); headers.set('Accept-Ranges', 'bytes');
  return new Response(blob.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}
async function offlineMatch(request) {
  const cache = await caches.open(OFFLINE_CACHE);
  const hit = await cache.match(request.url.split('?')[0], { ignoreSearch: true });   // el ?t=<token> de lo privado no cuenta
  return hit ? rangeFrom(hit, request) : null;
}
// Archivos pesados que no cambian (texturas, sonidos, videos): primero lo descargado, si no hay, la red.
const OFFLINE_FIRST = /^\/api\/(maps\/[^/]+\/sounds\/[^/]+|videos\/[^/]+\/stream)$/;
// Datos que sí pueden cambiar (el juego, el accesorio): primero la red; sin conexión, lo descargado. Si estaba descargado, se actualiza la copia.
// Las texturas también van por aquí: si el creador las reemplaza (mismo nombre), la PWA NO puede quedarse con la vieja.
const OFFLINE_FRESH = /^\/api\/(maps\/[^/]+(\/textures\/[^/]+)?|accessories\/[^/]+(\/model)?)$/;

async function networkFirst(request, cacheName, key) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') cache.put(key || request, response.clone()).catch(() => {});
    return response;
  } catch (err) {
    const hit = await cache.match(key || request, { ignoreSearch: !!key });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  // Las descargas piden "la red de verdad": así bajan siempre la versión actual y no la copia vieja.
  if (request.headers.get('X-Crix-Fetch') === 'network') return;

  if (url.origin !== self.location.origin) {
    if (CDN_FILES.includes(request.url)) event.respondWith(caches.match(request.url).then(cached => cached || fetch(request).then(r => { if (r.ok) caches.open(CACHE_NAME).then(c => c.put(request.url, r.clone())).catch(() => {}); return r; })));
    return;
  }

  // Juegos, videos y accesorios descargados.
  if (OFFLINE_FIRST.test(url.pathname)) {
    event.respondWith(offlineMatch(request).then(hit => hit || fetch(request)));
    return;
  }
  if (OFFLINE_FRESH.test(url.pathname)) {
    const key = url.origin + url.pathname;
    event.respondWith((async () => {
      const cache = await caches.open(OFFLINE_CACHE);
      const saved = await cache.match(key);
      try {
        const response = await fetch(request, { cache: 'no-cache' });   // revalida con el servidor: nunca sirve la copia vieja del caché HTTP de iOS/Chrome
        // Solo se refresca la copia si ya la había descargado la persona (nunca se guarda algo por cuenta propia).
        if (saved && response.ok) cache.put(key, response.clone()).catch(() => {});
        return response;
      } catch (err) {
        if (saved) return rangeFrom(saved, request);
        throw err;
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/api/') || (url.pathname.startsWith('/socket.io/') && url.pathname !== '/socket.io/socket.io.js')) return;

  // Abrir Crix o un enlace (/juego/…, /video/…, /u/…) sin conexión: se usa la copia guardada de la app.
  const isRoute = url.pathname === '/' || /^\/(juego|video|u)\//.test(url.pathname);
  if (isRoute && (request.mode === 'navigate' || url.pathname === '/')) {
    const key = new Request('/');
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        fetch(request).then(response => {
          if (!response.ok) return response;
          if (url.pathname === '/') { const cachedResponse = response.clone(); return cache.put(key, cachedResponse).then(() => response, () => response); }
          return response;
        }).catch(async () => {
          const shell = await cache.match(key);
          if (!shell) return Response.error();
          // Sin servidor el HTML del enlace no llega: se le vuelve a poner a qué juego/video/perfil apuntaba.
          const m = /^\/(juego|video|u)\/([^/]+)/.exec(url.pathname);
          if (!m) return shell;
          let html = await shell.text();
          const route = JSON.stringify({ kind: m[1], key: decodeURIComponent(m[2]) }).replace(/</g, '\\u003c');
          html = html.replace('</head>', () => '<script>window.__CRIX_ROUTE__=' + route + ';</script></head>');
          return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        })
      )
    );
    return;
  }

  // Resto de la app (scripts, íconos, manifiesto): red primero y, sin conexión, la copia guardada.
  if (SHELL.includes(url.pathname) || APP_FILES.includes(url.pathname)) {
    event.respondWith(networkFirst(request, CACHE_NAME, url.pathname).catch(() => caches.match(url.pathname, { ignoreSearch: true })));
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
    case 'activity':   // comentarios, me gusta, seguidores, novedades de a quienes seguís, equipo, cuenta...
      return { title: d.title || 'Crix', body: d.body || '', tag: d.tag || 'act', renotify: true, vibrate: [150, 80, 150] };
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
    const data = { type: d.type, from: d.from, kind: d.kind, id: d.id, url: d.url || '/' };
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
  const msg = { crixNotif: true, type: data.type, from: data.from, kind: data.kind, id: data.id, action, tag: n.tag, script: data.script };
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
