'use strict';
// ══════════════════════════════════════════════════════════════════
// Sincronización de la base entre varias instancias del servidor.
//
// Problema que resuelve: cada instancia carga la base en memoria al arrancar y sube su copia
// COMPLETA al bucket. Con dos o más instancias (escalado, o el solape de un deploy) un juego
// subido en una no aparecía en las otras y, peor, la siguiente subida de otra instancia lo pisaba.
//
// Cómo funciona: cada registro (mapa, usuario, sesión, video, publicación) recibe una marca `_u`
// (última modificación, la pone el servidor) y los borrados dejan una "lápida" en DB.tomb.
// persist.js baja la base remota cada pocos segundos y antes de cada subida, y `merge()` combina
// las dos copias registro por registro (gana el más reciente; las lápidas evitan que un
// borrado "resucite"). Después avisa por Socket.IO a los clientes de ESTA instancia.
// ══════════════════════════════════════════════════════════════════
const crypto = require('crypto');

const KEYED = ['users', 'maps', 'sessions'];   // objeto { id: registro }
const LISTS = ['videos', 'posts'];             // arreglo de registros con `id`
const COLS = [...KEYED, ...LISTS];
const TOMB_KEEP_MS = 30 * 24 * 3600 * 1000;

module.exports = function createDbSync({ getDB, onRemoteChange }) {
  const cache = new Map();   // 'col:id' → { sig, u }
  const known = {};          // col → Set de ids vistos en la última pasada
  for (const c of COLS) known[c] = new Set();

  const sigOf = rec => { const { _u, ...rest } = rec; return crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex'); };
  const isRec = r => r && typeof r === 'object' && !Array.isArray(r);
  const tombs = () => { const DB = getDB(); if (!DB.tomb || typeof DB.tomb !== 'object') DB.tomb = {}; for (const c of COLS) if (!DB.tomb[c] || typeof DB.tomb[c] !== 'object') DB.tomb[c] = {}; return DB.tomb; };
  function entries(DB, col) {
    if (KEYED.includes(col)) return Object.entries(DB[col] || {}).filter(([, r]) => isRec(r));
    return (Array.isArray(DB[col]) ? DB[col] : []).filter(r => isRec(r) && r.id != null).map(r => [String(r.id), r]);
  }
  function put(DB, col, id, rec) {
    if (KEYED.includes(col)) { DB[col] = DB[col] || {}; DB[col][id] = rec; return; }
    DB[col] = Array.isArray(DB[col]) ? DB[col] : [];
    const i = DB[col].findIndex(r => r && String(r.id) === id);
    if (i >= 0) DB[col][i] = rec; else DB[col].unshift(rec);
  }
  function drop(DB, col, id) {
    if (KEYED.includes(col)) { if (DB[col]) delete DB[col][id]; return; }
    DB[col] = (Array.isArray(DB[col]) ? DB[col] : []).filter(r => !(r && String(r.id) === id));
  }
  const remember = (col, id, rec) => { cache.set(col + ':' + id, { sig: sigOf(rec), u: Number(rec._u) || 0 }); known[col].add(id); };

  // Primera lectura (al arrancar): no se estampa nada, solo se memoriza el estado actual.
  function init() {
    const DB = getDB(); tombs();
    for (const c of COLS) for (const [id, rec] of entries(DB, c)) remember(c, id, rec);
  }

  // Se llama antes de cada guardado y antes de cada fusión: estampa lo que cambió y deja lápidas.
  function reconcile() {
    const DB = getDB(), T = tombs(), now = Date.now();
    for (const col of COLS) {
      const seen = new Set();
      for (const [id, rec] of entries(DB, col)) {
        seen.add(id);
        const key = col + ':' + id, sig = sigOf(rec), c = cache.get(key);
        if (!c) { rec._u = now; cache.set(key, { sig, u: now }); delete T[col][id]; }          // registro nuevo
        else if (c.sig !== sig) { rec._u = now; cache.set(key, { sig, u: now }); }              // cambió
        else rec._u = c.u;                                                                       // `_u` lo decide solo el servidor
      }
      for (const id of known[col]) if (!seen.has(id)) { T[col][id] = now; cache.delete(col + ':' + id); }   // se borró
      known[col] = seen;
      for (const [id, ts] of Object.entries(T[col])) if (now - ts > TOMB_KEEP_MS) delete T[col][id];
    }
  }

  // Combina la base remota en la local. Devuelve true si la local cambió.
  function merge(remote) {
    if (!isRec(remote)) return false;
    const DB = getDB(), T = tombs(); reconcile();
    const events = [];
    let changed = false;

    // 1) Lápidas: se unen (gana la más reciente).
    const RT = isRec(remote.tomb) ? remote.tomb : {};
    for (const col of COLS) for (const [id, ts] of Object.entries(isRec(RT[col]) ? RT[col] : {}))
      if (Number(ts) > (Number(T[col][id]) || 0)) T[col][id] = Number(ts);

    // 2) Registros, uno por uno.
    for (const col of COLS) {
      const local = new Map(entries(DB, col));
      for (const [id, r] of entries(remote, col)) {
        const l = local.get(id), t = Number(T[col][id]) || 0, ru = Number(r._u) || 0;
        if (t && t >= ru) {   // fue borrado después de su última modificación
          if (l && (Number(l._u) || 0) <= t) { drop(DB, col, id); cache.delete(col + ':' + id); known[col].delete(id); events.push([col, 'deleted', id, l]); changed = true; }
          continue;
        }
        if (!l) { put(DB, col, id, r); remember(col, id, r); delete T[col][id]; events.push([col, 'new', id, r]); changed = true; continue; }
        const lu = Number(l._u) || 0;
        const plays = col === 'maps' ? Math.max(Number(l.plays) || 0, Number(r.plays) || 0) : 0;   // las reproducciones solo crecen
        if (ru > lu) {
          if (col === 'maps') r.plays = plays;
          put(DB, col, id, r); remember(col, id, r); events.push([col, 'updated', id, r]); changed = true;
        } else if (col === 'maps' && plays > (Number(l.plays) || 0)) {
          l.plays = plays; cache.set('maps:' + id, { sig: sigOf(l), u: lu }); changed = true;   // sin cambiar `_u`
        }
      }
      // Registros locales que una lápida remota borró (la remota ya no los tiene).
      for (const [id, ts] of Object.entries(T[col])) {
        const l = KEYED.includes(col) ? DB[col]?.[id] : (DB[col] || []).find(x => x && String(x.id) === id);
        if (l && (Number(l._u) || 0) <= Number(ts)) {
          drop(DB, col, id); cache.delete(col + ':' + id); known[col].delete(id); events.push([col, 'deleted', id, l]); changed = true;
        }
      }
    }
    // Las publicaciones más nuevas van primero.
    if (events.some(e => e[0] === 'posts' && e[1] === 'new') && Array.isArray(DB.posts)) {
      const ts = p => Number(new Date(p.created ?? p.t ?? p.ts ?? p.time ?? 0)) || 0;
      DB.posts.sort((a, b) => ts(b) - ts(a));
    }

    // 3) Mensajes del chat: unión por id de mensaje.
    for (const [cid, msgs] of Object.entries(isRec(remote.convs) ? remote.convs : {})) {
      if (!Array.isArray(msgs)) continue;
      const mine = DB.convs[cid] = Array.isArray(DB.convs[cid]) ? DB.convs[cid] : [];
      const ids = new Set(mine.map(m => m && m.id)); let added = 0;
      for (const m of msgs) if (m && m.id && !ids.has(m.id)) { mine.push(m); ids.add(m.id); added++; }
      if (added) { mine.sort((a, b) => (a.t || 0) - (b.t || 0)); changed = true; events.push(['convs', 'updated', cid]); }
    }
    // 4) Suscripciones push: unión por endpoint.
    DB.push = DB.push || {};
    for (const [uid, subs] of Object.entries(isRec(remote.push) ? remote.push : {})) {
      if (!Array.isArray(subs)) continue;
      const mine = DB.push[uid] = Array.isArray(DB.push[uid]) ? DB.push[uid] : [];
      for (const s of subs) if (s && s.endpoint && !mine.some(x => x.endpoint === s.endpoint)) { mine.push(s); changed = true; }
    }
    // 5) Datos sueltos: se adoptan solo si faltan acá.
    for (const k of ['pushKeys', 'pushSubject', 'appData', 'appScores']) {
      if (remote[k] === undefined) continue;
      if (DB[k] === undefined) { DB[k] = remote[k]; changed = true; }
      else if (isRec(DB[k]) && isRec(remote[k]) && (k === 'appData' || k === 'appScores'))
        for (const [mid, v] of Object.entries(remote[k])) if (DB[k][mid] === undefined && DB.maps?.[mid]) { DB[k][mid] = v; changed = true; }
    }

    DB._v = Math.max(Number(DB._v) || 0, Number(remote._v) || 0);
    if (events.length && onRemoteChange) { try { onRemoteChange(events); } catch (e) { console.warn('[SYNC]', e.message); } }
    return changed;
  }

  return { init, reconcile, merge };
};
