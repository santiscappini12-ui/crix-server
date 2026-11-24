/* Crix — creaciones sin conexión (PWA)
 *
 * Permite descargar juegos, apps, videos y accesorios para usarlos sin internet, siempre que su creador lo haya permitido
 * (casilla «Permitir descargar» al publicar). El creador, su equipo y los admins siempre pueden bajar lo suyo.
 *
 * Dónde se guarda:
 *   · Los archivos (juego, texturas, sonidos, videos, modelos) en Cache Storage «crix-offline-v1». El service worker los sirve
 *     con las mismas direcciones de siempre, así que el juego no sabe que está sin conexión.
 *   · Un índice chico (qué hay descargado) en localStorage «crix_offline_index».
 *
 * Si el creador retira el permiso o borra la creación, la copia se elimina sola la próxima vez que haya conexión.
 */
(function () {
  'use strict';
  const CACHE = 'crix-offline-v1', INDEX_KEY = 'crix_offline_index';
  const KINDS = { map: { icon: '🎮', label: 'Juego' }, app: { icon: '📱', label: 'App' }, video: { icon: '🎬', label: 'Video' }, accessory: { icon: '🎩', label: 'Accesorio' } };
  const supported = typeof caches !== 'undefined' && 'serviceWorker' in navigator;
  const busy = {};   // 'kind:id' → true mientras se descarga
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, d) => { try { showToast(m, d || 3500); } catch (_) {} };
  const token = () => { try { return DB.get('token'); } catch (_) { return null; } };
  const authHeaders = () => { const t = token(); return t ? { Authorization: 'Bearer ' + t } : {}; };
  // El service worker ignora los pedidos con esta cabecera: así una descarga siempre baja la versión actual del servidor.
  const netHeaders = () => ({ ...authHeaders(), 'X-Crix-Fetch': 'network' });
  const fmt = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const keyOf = (kind, id) => (kind === 'app' ? 'map' : kind) + ':' + id;

  // ── Índice ──
  function readIndex() { try { const v = JSON.parse(localStorage.getItem(INDEX_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; } }
  function writeIndex(ix) { try { localStorage.setItem(INDEX_KEY, JSON.stringify(ix)); } catch (_) {} }
  function has(kind, id) { return !!readIndex()[keyOf(kind, id)]; }
  function list() { return Object.values(readIndex()).sort((a, b) => (b.at || 0) - (a.at || 0)); }
  const origin = location.origin;
  const abs = path => origin + path.split('?')[0];

  async function putJson(cache, path, obj) {
    await cache.put(abs(path), new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
    return JSON.stringify(obj).length;
  }
  // Baja un archivo y lo guarda. onBytes recibe lo que va llegando (los videos pueden pesar cientos de MB).
  async function fetchInto(cache, path, onBytes) {
    const r = await fetch(path, { headers: netHeaders(), cache: 'no-store' });
    if (!r.ok) throw new Error('No se pudo bajar un archivo (' + r.status + ')');
    let got = 0;
    const counter = new TransformStream({ transform(chunk, ctl) { got += chunk.byteLength; if (onBytes) onBytes(chunk.byteLength); ctl.enqueue(chunk); } });
    const body = r.body && onBytes ? r.body.pipeThrough(counter) : r.body;
    const headers = new Headers(); const ct = r.headers.get('Content-Type'); if (ct) headers.set('Content-Type', ct);
    await cache.put(abs(path), new Response(body, { status: 200, headers }));
    if (!got) { const hit = await cache.match(abs(path)); if (hit) { const b = await hit.blob(); got = b.size; } }
    return got;
  }
  async function dropKeys(cache, test) { for (const req of await cache.keys()) if (test(new URL(req.url).pathname)) await cache.delete(req); }

  async function apiGet(path) {
    const r = await fetch(path, { headers: netHeaders(), cache: 'no-store' });
    let data = {}; try { data = await r.json(); } catch (_) {}
    if (!r.ok || data.ok === false) { const e = new Error(data.err || 'No se pudo conectar con Crix'); e.code = data.code; e.status = r.status; throw e; }
    return data;
  }

  // ── Quién puede descargar (igual que el servidor; el servidor lo vuelve a comprobar) ──
  function mayDownload(item) {
    if (!item) return false;
    let me = null; try { me = ME; } catch (_) {}
    if (me && (me.isAdmin || item.authorId === me.id || (Array.isArray(item.collaborators) && item.collaborators.includes(me.id)))) return true;
    return item.allowDownload === true;
  }

  // ── Descargar ──
  async function download(kind, id, onProgress) {
    if (!supported) throw new Error('Este navegador no permite guardar creaciones sin conexión');
    if (!navigator.onLine) throw new Error('Necesitás conexión para descargar');
    const k = keyOf(kind, id); if (busy[k]) return;
    busy[k] = true;
    try {
      const cache = await caches.open(CACHE);
      let total = 0, done = 0, name = '', meta = {}, bytes = 0;
      const tick = n => { done += n; bytes += n; if (onProgress) onProgress(total ? Math.min(1, done / total) : 0, bytes); };
      try {
        if (kind === 'map' || kind === 'app') {
          const pack = await apiGet('/api/maps/' + encodeURIComponent(id) + '/offline-pack');
          const m = pack.map; name = m.name || 'Juego'; meta = { kind: m.kind === 'app' || m.isHtmlGame ? 'app' : 'map', author: m.authorName || '' };
          total = (pack.textures || []).length * 150000 + (pack.sounds || []).reduce((a, s) => a + (s.size || 200000), 0) + 200000;
          // Primero lo viejo se borra: así la nueva descarga reemplaza todo y no quedan archivos huérfanos.
          await dropKeys(cache, p => p === '/api/maps/' + id || p.startsWith('/api/maps/' + id + '/'));
          tick(await putJson(cache, '/api/maps/' + encodeURIComponent(id), { ok: true, map: m }));
          for (const t of pack.textures || []) { tick(await fetchInto(cache, t.url)); }
          for (const s of pack.sounds || []) { tick(await fetchInto(cache, s.url)); }
        } else if (kind === 'video') {
          const pack = await apiGet('/api/videos/' + encodeURIComponent(id) + '/offline-pack');
          const v = pack.video; name = v.title || 'Video'; meta = { kind: 'video', author: v.authorName || '' }; total = pack.size || 0;
          await dropKeys(cache, p => p === '/api/videos/' + id + '/stream' || p === '/__crix_offline__/video/' + id);
          await putJson(cache, '/__crix_offline__/video/' + encodeURIComponent(id), { ok: true, video: v });
          await fetchInto(cache, pack.url, tick);
        } else if (kind === 'accessory') {
          const pack = await apiGet('/api/accessories/' + encodeURIComponent(id) + '/offline-pack');
          const a = pack.accessory; name = a.name || 'Accesorio'; meta = { kind: 'accessory', author: a.authorName || '' }; total = pack.modelUrl ? 1500000 : 20000;
          await dropKeys(cache, p => p === '/api/accessories/' + id || p === '/api/accessories/' + id + '/model');
          tick(await putJson(cache, '/api/accessories/' + encodeURIComponent(id), { ok: true, accessory: a }));
          if (pack.modelUrl) tick(await fetchInto(cache, pack.modelUrl));
        } else throw new Error('Tipo de creación desconocido');
      } catch (err) {
        // Si algo falla a medias no queda una copia rota: se borra lo que se alcanzó a guardar.
        try { await dropKeys(cache, p => p === '/api/maps/' + id || p.startsWith('/api/maps/' + id + '/') || p === '/api/videos/' + id + '/stream' || p === '/__crix_offline__/video/' + id || p === '/api/accessories/' + id || p === '/api/accessories/' + id + '/model'); } catch (_) {}
        if (err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message)))) throw new Error('No hay espacio en el dispositivo para guardar esto');
        throw err;
      }
      const ix = readIndex();
      ix[k] = { key: k, id: String(id), kind: meta.kind, name, author: meta.author, bytes, at: Date.now() };
      writeIndex(ix);
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}   // pide que el navegador no lo borre solo
      return ix[k];
    } finally { delete busy[k]; }
  }

  async function remove(kind, id) {
    const k = keyOf(kind, id), ix = readIndex();
    try {
      const cache = await caches.open(CACHE);
      await dropKeys(cache, p => p === '/api/maps/' + id || p.startsWith('/api/maps/' + id + '/') || p === '/api/videos/' + id + '/stream' || p === '/__crix_offline__/video/' + id || p === '/api/accessories/' + id || p === '/api/accessories/' + id + '/model');
    } catch (_) {}
    delete ix[k]; writeIndex(ix);
  }

  // ── Usar sin conexión ──
  // Pone los juegos y videos descargados en el catálogo local para que aparezcan y se puedan abrir aunque el servidor no responda.
  async function mergeIntoCatalog() {
    if (!supported) return 0;
    const items = list(); if (!items.length) return 0;
    let n = 0;
    try {
      const cache = await caches.open(CACHE);
      let maps = DB.get('maps') || {}, videos = DB.get('crix_videos'); videos = Array.isArray(videos) ? videos : [];
      let mapsChanged = false, videosChanged = false;
      for (const it of items) {
        if (it.kind === 'map' || it.kind === 'app') {
          const hit = await cache.match(abs('/api/maps/' + encodeURIComponent(it.id))); if (!hit) continue;
          const m = (await hit.json()).map; if (!m || !m.id) continue;
          const cur = maps[m.id];
          if (!cur || cur.partial) { maps[m.id] = m; mapsChanged = true; n++; }
        } else if (it.kind === 'video') {
          const hit = await cache.match(abs('/__crix_offline__/video/' + encodeURIComponent(it.id))); if (!hit) continue;
          const v = (await hit.json()).video; if (!v || !v.id) continue;
          if (!videos.some(x => x.id === v.id)) { videos.push({ ...v, data: '[data]' }); videosChanged = true; n++; }
        }
      }
      if (mapsChanged) DB.set('maps', maps);
      if (videosChanged) DB.set('crix_videos', videos);
    } catch (e) { console.warn('[OFFLINE]', e.message); }
    return n;
  }

  // Accesorios guardados (para elegirlos en el editor de avatar sin conexión).
  async function cachedAccessories() {
    const out = [];
    try {
      const cache = await caches.open(CACHE);
      for (const it of list().filter(x => x.kind === 'accessory')) {
        const hit = await cache.match(abs('/api/accessories/' + encodeURIComponent(it.id)));
        if (hit) { const a = (await hit.json()).accessory; if (a) out.push(a); }
      }
    } catch (_) {}
    return out;
  }

  // Con conexión: si el creador retiró el permiso o borró la creación, la copia del dispositivo se elimina.
  // Se le pregunta al servidor por cada descarga (no se usa el catálogo local, que puede estar incompleto). Si no responde, no se borra nada.
  async function reconcile() {
    if (!supported || !navigator.onLine || !token()) return 0;
    const items = list(); if (!items.length) return 0;
    const ids = k => items.filter(it => (k === 'maps' ? (it.kind === 'map' || it.kind === 'app') : it.kind === k.slice(0, -1) || (k === 'accessories' && it.kind === 'accessory'))).map(it => encodeURIComponent(it.id)).join(',');
    let status = null;
    try {
      const r = await fetch('/api/offline/check?maps=' + ids('maps') + '&videos=' + ids('videos') + '&accessories=' + ids('accessories'), { headers: netHeaders(), cache: 'no-store' });
      if (!r.ok) return 0; status = (await r.json()).status;
    } catch (_) { return 0; }
    let removed = 0;
    for (const it of items) {
      const st = status && status[keyOf(it.kind, it.id)];
      if (st === 'gone' || st === 'revoked') { await remove(it.kind, it.id); removed++; }
    }
    if (removed) toast('🗑️ Se quitaron ' + removed + ' descarga(s): su creador ya no las permite o las borró', 5000);
    return removed;
  }

  // ── Interfaz ──
  function btnLabel(kind, id) { return has(kind, id) ? '✅ Guardado sin conexión' : '📥 Descargar para usar sin conexión'; }
  // HTML de un botón (juego, app, video o accesorio). Devuelve '' si no corresponde mostrarlo.
  function button(kind, item, extraStyle) {
    if (!supported || !item) return '';
    const id = item.id, saved = has(kind, id);
    if (!saved && !mayDownload(item)) return '';
    return '<button class="btn btn-g" data-off="' + esc(keyOf(kind, id)) + '" style="' + esc(extraStyle || '') + '" onclick="CrixOffline.toggle(\'' + esc(kind) + '\',\'' + esc(id) + '\',this)">' + btnLabel(kind, id) + '</button>';
  }
  async function toggle(kind, id, btn) {
    const set = t => { if (btn) btn.textContent = t; };
    if (has(kind, id)) {
      if (!confirm('¿Quitar esta descarga del dispositivo? Ya no se podrá usar sin conexión.')) return;
      await remove(kind, id); set('📥 Descargar para usar sin conexión'); toast('Descarga quitada'); refreshManager(); return;
    }
    if (btn) btn.disabled = true;
    try {
      set('⏳ Descargando…');
      const it = await download(kind, id, (p, b) => set('⏳ ' + (p ? Math.round(p * 100) + '% · ' : '') + fmt(b)));
      set('✅ Guardado sin conexión'); toast('✅ «' + it.name + '» ya se puede usar sin conexión (' + fmt(it.bytes) + ')'); refreshManager();
    } catch (e) {
      set('📥 Descargar para usar sin conexión');
      toast(e && e.code === 'DOWNLOAD_NOT_ALLOWED' ? '🚫 Su creador no permitió descargar esta creación' : '⚠️ ' + ((e && e.message) || 'No se pudo descargar'), 5000);
    } finally { if (btn) btn.disabled = false; }
  }
  // Casilla del creador: «Permitir descargar». Va dentro de los formularios de publicar.
  function allowCheckboxHtml(id, checked) {
    return '<label class="tgl-row" style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;font-size:13px"><input type="checkbox" id="' + esc(id) + '"' + (checked ? ' checked' : '') + ' style="margin-top:3px">' +
      '<span>📥 Permitir que otras personas lo descarguen para usarlo sin conexión<br><span class="set-note" style="margin:0">Se guarda en su dispositivo y se puede abrir sin internet. Podés quitar el permiso cuando quieras: las copias se borran solas cuando vuelvan a tener conexión.</span></span></label>';
  }

  function ensureManager() {
    let el = document.getElementById('mo-offline'); if (el) return el;
    el = document.createElement('div'); el.className = 'mo-overlay'; el.id = 'mo-offline';
    el.innerHTML = '<div class="mo-box" style="width:min(560px,94vw);max-height:90vh;overflow:auto"><h3>📥 Sin conexión</h3><div id="off-body"></div><div class="mo-btns"><button class="btn btn-g" onclick="closeModal(\'mo-offline\')">Cerrar</button></div></div>';
    document.body.appendChild(el); return el;
  }
  async function refreshManager() {
    const body = document.getElementById('off-body'); if (!body) return;
    const items = list(); let est = '';
    try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); est = '<div class="set-note">Espacio usado por Crix: ' + fmt(e.usage || 0) + (e.quota ? ' de ' + fmt(e.quota) : '') + '</div>'; } } catch (_) {}
    const online = navigator.onLine;
    body.innerHTML = '<div class="set-note">' + (supported ? (online ? 'Lo que descargues se puede abrir sin internet desde Crix instalada como app.' : '📴 Estás sin conexión: acá ves lo que tenés guardado.') : 'Este navegador no permite guardar creaciones sin conexión.') + '</div>' + est +
      (items.length ? items.map(it => '<div style="display:flex;align-items:center;gap:8px;background:var(--bg3);border-radius:8px;padding:8px;margin:6px 0">' +
        '<div style="font-size:22px">' + (KINDS[it.kind] || KINDS.map).icon + '</div>' +
        '<div style="flex:1;min-width:0"><div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(it.name) + '</div><div class="set-note" style="margin:0">' + (KINDS[it.kind] || KINDS.map).label + (it.author ? ' · ' + esc(it.author) : '') + ' · ' + fmt(it.bytes || 0) + '</div></div>' +
        ((it.kind === 'map' || it.kind === 'app') ? '<button class="btn btn-p" style="font-size:11px;padding:4px 8px" onclick="closeModal(\'mo-offline\');playMap(\'' + esc(it.id) + '\')">▶ Abrir</button>' : '') +
        (online ? '<button class="btn btn-g" style="font-size:11px;padding:4px 8px" title="Volver a bajar la última versión" onclick="CrixOffline.update(\'' + esc(it.kind) + '\',\'' + esc(it.id) + '\')">🔄</button>' : '') +
        '<button class="btn btn-g" style="font-size:11px;padding:4px 8px" title="Quitar" onclick="CrixOffline.removeAsk(\'' + esc(it.kind) + '\',\'' + esc(it.id) + '\')">🗑</button></div>').join('')
        : '<div class="set-note" style="margin:12px 0">Todavía no descargaste nada. Buscá el botón «📥 Descargar para usar sin conexión» en la página de un juego, app o video (aparece solo si su creador lo permitió).</div>');
  }
  function openManager() { ensureManager(); refreshManager(); openModal('mo-offline'); }
  async function update(kind, id) { toast('⏳ Actualizando…'); try { const it = await download(kind, id); toast('✅ «' + it.name + '» actualizado'); } catch (e) { toast('⚠️ ' + ((e && e.message) || 'No se pudo actualizar'), 5000); } refreshManager(); }
  async function removeAsk(kind, id) { if (!confirm('¿Quitar esta descarga del dispositivo?')) return; await remove(kind, id); refreshManager(); }

  // Sin conexión: se muestran los juegos y videos descargados; al volver, se revisan los permisos.
  addEventListener('offline', () => { mergeIntoCatalog().then(n => { toast('📴 Sin conexión. Podés usar lo que descargaste.', 4000); try { if (n && document.getElementById('s-home') && document.getElementById('s-home').classList.contains('active')) renderHome(); } catch (_) {} }); });
  addEventListener('online', () => { setTimeout(() => { try { if (typeof refreshCloudContent === 'function') refreshCloudContent().then(reconcile); } catch (_) {} }, 1500); });
  if (!navigator.onLine) setTimeout(mergeIntoCatalog, 800);

  window.CrixOffline = { supported, has, list, download, remove, mayDownload, mergeIntoCatalog, cachedAccessories, reconcile, button, toggle, allowCheckboxHtml, openManager, update, removeAsk, fmt };
})();
