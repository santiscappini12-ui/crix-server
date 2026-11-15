'use strict';
// ══════════════════════════════════════════════════════════════════
// Varias instancias del servidor jugando juntas (presencia y salas compartidas).
//
// Sin CRIX_REDIS_URL (o REDIS_URL) todo sigue igual que antes: una sola instancia, nada que coordinar.
// Con Redis:
//   · Socket.IO usa el adaptador de Redis: los broadcast y los mensajes a una persona (io.to(...)) llegan a
//     quien esté conectado a CUALQUIER instancia.
//   · Cada sala de juego vive en UNA instancia (la que la creó; su id va en el instanceId: "<nodo>-<uuid>").
//     Quien entra desde otra instancia queda "proxeado": sus eventos viajan por Redis hasta la sala y las
//     respuestas vuelven directo a su socket.
//   · Presencia (quién está en línea / jugando qué y en qué instancia) y lista de salas se replican entre
//     instancias por un bus de Redis; cada instancia manda un latido cada 5 s y se da por caída tras 15 s.
// Redis se usa solo como canal (pub/sub); no guarda datos.
// ══════════════════════════════════════════════════════════════════
const crypto = require('crypto');

const NODE_ID = crypto.randomBytes(4).toString('hex');   // 8 hex: va de prefijo en los instanceId
const REDIS_URL = process.env.CRIX_REDIS_URL || process.env.REDIS_URL || '';
const HB_MS = 5000, DEAD_MS = 15000, SNAP_MS = 60000;
const CH_ALL = 'crix:bus', chOf = id => 'crix:n:' + id;

module.exports = function createCluster() {
  let enabled = false, pub = null, busSub = null, hbTimer = null, snapTimer = null;
  const handlers = {};                       // type → fn(msg)
  const lastSeen = new Map();                // nodo → ms del último mensaje
  const remoteOnline = new Map();            // userId → Map(nodo → info)
  const remoteRooms = new Map();             // roomKey → { node, ...info }
  const localOnline = new Map();             // userId → info (lo que esta instancia anuncia)
  const localRooms = new Map();              // roomKey → info

  const now = () => Date.now();
  const alive = id => id === NODE_ID || (lastSeen.has(id) && now() - lastSeen.get(id) < DEAD_MS);

  function publish(channel, msg) {
    if (!enabled || !pub) return;
    pub.publish(channel, JSON.stringify({ ...msg, from: NODE_ID })).catch(e => console.error('[CLUSTER] publish:', e.message));
  }
  const broadcast = msg => publish(CH_ALL, msg);
  const sendTo = (node, msg) => { if (node === NODE_ID) return; publish(chOf(node), msg); };

  function dropNode(node) {
    for (const [uid, m] of remoteOnline) { m.delete(node); if (!m.size) remoteOnline.delete(uid); }
    for (const [k, r] of remoteRooms) if (r.node === node) remoteRooms.delete(k);
  }
  function applySnap(node, online, rooms) {
    dropNode(node);
    for (const [uid, info] of online || []) { if (!remoteOnline.has(uid)) remoteOnline.set(uid, new Map()); remoteOnline.get(uid).set(node, info); }
    for (const [k, info] of rooms || []) remoteRooms.set(k, { ...info, node });
  }
  const snapshot = () => ({ online: [...localOnline], rooms: [...localRooms] });

  function onMsg(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const from = msg && msg.from; if (!from || from === NODE_ID) return;
    lastSeen.set(from, now());
    switch (msg.type) {
      case 'hb': return;
      case 'bye': lastSeen.delete(from); dropNode(from); return;
      case 'sync_req': sendTo(from, { type: 'snap', ...snapshot() }); return;
      case 'snap': applySnap(from, msg.online, msg.rooms); return;
      case 'pres': {
        const m = remoteOnline.get(msg.userId) || new Map();
        if (msg.info) m.set(from, msg.info); else m.delete(from);
        if (m.size) remoteOnline.set(msg.userId, m); else remoteOnline.delete(msg.userId);
        return;
      }
      case 'room':
        if (msg.info) remoteRooms.set(msg.key, { ...msg.info, node: from }); else remoteRooms.delete(msg.key);
        return;
      default: { const h = handlers[msg.type]; if (h) { try { h(msg); } catch (e) { console.error('[CLUSTER] handler', msg.type, e.message); } } }
    }
  }

  async function init(io) {
    if (!REDIS_URL) return false;
    try {
      const { createClient } = require('redis');
      const { createAdapter } = require('@socket.io/redis-adapter');
      pub = createClient({ url: REDIS_URL });
      const sub = pub.duplicate(); busSub = pub.duplicate();
      for (const c of [pub, sub, busSub]) c.on('error', e => console.error('[CLUSTER] Redis:', e.message));
      await Promise.race([
        Promise.all([pub.connect(), sub.connect(), busSub.connect()]),
        new Promise((_, rej) => setTimeout(() => rej(new Error('no conectó en 10 s')), 10000)),
      ]);
      io.adapter(createAdapter(pub, sub));
      await busSub.subscribe(CH_ALL, onMsg);
      await busSub.subscribe(chOf(NODE_ID), onMsg);
      enabled = true;
      hbTimer = setInterval(() => broadcast({ type: 'hb' }), HB_MS); hbTimer.unref();
      snapTimer = setInterval(() => broadcast({ type: 'snap', ...snapshot() }), SNAP_MS); snapTimer.unref();
      setInterval(() => { for (const [n, t] of lastSeen) if (now() - t > DEAD_MS * 4) { lastSeen.delete(n); dropNode(n); } }, 30000).unref();
      broadcast({ type: 'hb' });
      broadcast({ type: 'sync_req' });
      console.log(`[CLUSTER] Redis conectado · instancia ${NODE_ID}`);
      return true;
    } catch (e) {
      enabled = false;
      console.error('[CLUSTER] No se pudo usar Redis (' + e.message + '). Sigo como instancia única.');
      try { pub && pub.disconnect(); busSub && busSub.disconnect(); } catch {}
      return false;
    }
  }

  function shutdown() { if (!enabled) return; try { broadcast({ type: 'bye' }); } catch {} }

  return {
    nodeId: NODE_ID,
    get enabled() { return enabled; },
    init, shutdown, alive, broadcast, sendTo,
    on(type, fn) { handlers[type] = fn; },
    // Lo que ESTA instancia anuncia a las demás.
    setLocalPresence(userId, info) {
      if (!enabled) return;
      if (info) localOnline.set(userId, info); else localOnline.delete(userId);
      broadcast({ type: 'pres', userId, info: info || null });
    },
    setLocalRoom(key, info) {
      if (!enabled) return;
      if (info) localRooms.set(key, info); else localRooms.delete(key);
      broadcast({ type: 'room', key, info: info || null });
    },
    // Lo que las OTRAS instancias anuncian (solo de instancias vivas).
    remotePresence(userId) {
      const m = remoteOnline.get(userId); if (!m) return null;
      let best = null;
      for (const [node, info] of m) if (alive(node) && (!best || (info.mapId && !best.mapId))) best = { ...info, node };
      return best;
    },
    remoteOnlineIds() { const out = []; for (const [uid, m] of remoteOnline) for (const node of m.keys()) if (alive(node)) { out.push(uid); break; } return out; },
    remoteRoom(key) { const r = remoteRooms.get(key); return r && alive(r.node) ? r : null; },
    remoteRoomsList() { return [...remoteRooms.values()].filter(r => alive(r.node)); },
  };
};
