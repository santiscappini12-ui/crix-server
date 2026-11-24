'use strict';
// ══════════════════════════════════════════════════════════════════
// DataStore: guardado persistente por juego (mapa) para los Script de servidor.
//
//   const ds = game.getDataStore('Puntos');
//   await ds.set(String(jugador.userId), { monedas: 10 });
//   const datos = await ds.get(String(jugador.userId));
//
// Los datos viven en DB.datastores[mapId].stores[nombreDelStore][clave] dentro de la misma base JSON del servidor (se respaldan
// y se sincronizan entre instancias igual que el resto; db-sync.js trata cada mapa como un registro). Este módulo es PURO:
// no toca sockets ni procesos, solo valida y aplica la operación. server.js lo llama cuando el proceso aislado de scripts pide algo.
// ══════════════════════════════════════════════════════════════════

const LIMITS = {
  storeName: 50,          // caracteres del nombre del store
  key: 100,               // caracteres de la clave
  value: 16 * 1024,       // bytes (JSON) por valor
  stores: 20,             // stores por juego
  keys: 5000,             // claves por store
  mapBytes: 1024 * 1024,  // todo el DataStore de un juego (JSON)
  list: 100,              // máximo de resultados de keys() / top()
};

const NAME_RE = /^[\w .:-]{1,50}$/u;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

class DataStoreError extends Error {}
const fail = msg => { throw new DataStoreError(msg); };

function cleanName(name) {
  const s = String(name === undefined || name === null ? '' : name);
  if (!NAME_RE.test(s)) fail('Nombre de DataStore inválido (1–' + LIMITS.storeName + ' caracteres: letras, números, espacio y . : _ -)');
  return s;
}
function cleanKey(key) {
  const s = String(key === undefined || key === null ? '' : key);
  if (!s || s.length > LIMITS.key) fail('La clave debe tener entre 1 y ' + LIMITS.key + ' caracteres');
  if (s === '__proto__' || s === 'constructor' || s === 'prototype') fail('Clave no permitida');
  return s;
}
// Solo JSON: undefined/funciones se pierden como en JSON.stringify; no se aceptan valores que no se puedan serializar.
function cleanValue(value) {
  if (value === undefined) fail('El valor no puede ser undefined (usá remove() para borrar)');
  let json;
  try { json = JSON.stringify(value); } catch (_) { fail('El valor no se puede guardar (¿referencia circular?)'); }
  if (json === undefined) fail('El valor no se puede guardar como JSON');
  if (Buffer.byteLength(json) > LIMITS.value) fail('El valor supera ' + (LIMITS.value / 1024) + ' KB');
  return JSON.parse(json);
}

module.exports = function createDataStore({ getDB, saveDB }) {
  function record(mapId, create) {
    const DB = getDB();
    if (!isObj(DB.datastores)) { if (!create) return null; DB.datastores = {}; }
    let rec = DB.datastores[mapId];
    if (!isObj(rec)) { if (!create) return null; rec = DB.datastores[mapId] = { stores: {} }; }
    if (!isObj(rec.stores)) rec.stores = {};
    return rec;
  }
  function bytes(rec) { return Buffer.byteLength(JSON.stringify(rec.stores)); }
  function store(mapId, name, create) {
    const rec = record(mapId, create); if (!rec) return null;
    let st = rec.stores[name];
    if (!isObj(st)) {
      if (!create) return null;
      if (Object.keys(rec.stores).length >= LIMITS.stores) fail('Máximo ' + LIMITS.stores + ' DataStores por juego');
      st = rec.stores[name] = {};
    }
    return st;
  }
  // Tras escribir: tope de tamaño total del juego (si se pasa, se deshace con `undo`).
  function commit(rec, undo) {
    if (bytes(rec) > LIMITS.mapBytes) { undo(); fail('El DataStore del juego superó ' + (LIMITS.mapBytes / 1024 / 1024) + ' MB'); }
    if (saveDB) saveDB();
  }
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // req: { store, op, key, value, delta, opts }. Devuelve el resultado (JSON) o tira DataStoreError.
  function handle(mapId, req) {
    mapId = String(mapId || '');
    if (!mapId) fail('Este juego no tiene identificador');
    if (!isObj(req)) fail('Pedido inválido');
    const name = cleanName(req.store), op = String(req.op || '');
    switch (op) {
      case 'get': {
        const key = cleanKey(req.key), st = store(mapId, name, false);
        return st && has(st, key) ? st[key] : null;
      }
      case 'set': {
        const key = cleanKey(req.key), value = cleanValue(req.value), st = store(mapId, name, true), rec = record(mapId, true);
        if (!has(st, key) && Object.keys(st).length >= LIMITS.keys) fail('Máximo ' + LIMITS.keys + ' claves por DataStore');
        const had = has(st, key), prev = st[key]; st[key] = value;
        commit(rec, () => { if (had) st[key] = prev; else delete st[key]; });
        return true;
      }
      case 'remove': {
        const key = cleanKey(req.key), st = store(mapId, name, false);
        if (!st || !has(st, key)) return false;
        delete st[key]; if (saveDB) saveDB();
        return true;
      }
      case 'increment': {
        const key = cleanKey(req.key), delta = Number(req.delta === undefined ? 1 : req.delta);
        if (!Number.isFinite(delta)) fail('increment necesita un número');
        const st = store(mapId, name, true), rec = record(mapId, true), had = has(st, key), prev = st[key];
        if (had && typeof prev !== 'number') fail('increment: el valor guardado en «' + key + '» no es un número');
        if (!had && Object.keys(st).length >= LIMITS.keys) fail('Máximo ' + LIMITS.keys + ' claves por DataStore');
        const next = (had ? prev : 0) + delta;
        if (!Number.isFinite(next)) fail('increment: resultado fuera de rango');
        st[key] = next;
        commit(rec, () => { if (had) st[key] = prev; else delete st[key]; });
        return next;
      }
      case 'keys': {
        const st = store(mapId, name, false); if (!st) return [];
        const prefix = req.opts && req.opts.prefix !== undefined ? String(req.opts.prefix) : '';
        const limit = Math.max(1, Math.min(LIMITS.list, Number(req.opts && req.opts.limit) || LIMITS.list));
        return Object.keys(st).filter(k => k.startsWith(prefix)).sort().slice(0, limit);
      }
      case 'top': {   // ranking: claves con valor numérico, de mayor a menor (o de menor a mayor con ascending:true)
        const st = store(mapId, name, false); if (!st) return [];
        const o = req.opts || {}, limit = Math.max(1, Math.min(LIMITS.list, Number(o.limit) || 10)), sign = o.ascending ? 1 : -1;
        return Object.keys(st).filter(k => typeof st[k] === 'number').sort((a, b) => sign * (st[a] - st[b]) || (a < b ? -1 : 1)).slice(0, limit).map(k => ({ key: k, value: st[k] }));
      }
      default: fail('Operación de DataStore desconocida: ' + op);
    }
  }

  // Al borrar un juego se borran sus datos.
  function removeMap(mapId) {
    const DB = getDB();
    if (isObj(DB.datastores) && DB.datastores[String(mapId)]) { delete DB.datastores[String(mapId)]; if (saveDB) saveDB(); }
  }

  return { handle, removeMap, LIMITS, DataStoreError };
};
module.exports.DataStoreError = DataStoreError;
module.exports.LIMITS = LIMITS;
