const express  = require('express');
const CrixAvatar = require('./crix-avatar.js');   // validación compartida de avatares (la misma que usa el cliente)
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const crypto   = require('crypto');
const { fork } = require('node:child_process');
const persist  = require('./persist');
const LOWRES = require('./low-resource');   // detecta contenedores pequeños (poca RAM / CPU) y baja la carga
const worldPhysics = require('./world-physics');
const CrixRigid = require('./crix-rigid');   // física realista (Rapier); mientras no cargue, rige la física clásica
let rapierLib = null;
try { rapierLib = require('@dimforge/rapier3d-compat'); } catch (err) { console.warn('[FÍSICA] Rapier no instalado, se usa la física clásica:', err.message); }
if (rapierLib) CrixRigid.init(rapierLib).then(() => console.log('[FÍSICA] Rapier listo: física realista activa')).catch(err => console.warn('[FÍSICA] No se pudo iniciar Rapier:', err.message));
const CrixJoints = require('./crix-joints.js');
const CrixObjects = require('./crix-objects.js');
const CrixAnim = require('./crix-anim.js');   // uniones Weld / Motor6D / Hinge… (el mismo módulo que usa el cliente)
const classification = require('./classification');   // cuestionario de clasificación por país (juegos, apps y videos)

if (persist.enabled && !persist.restored) {
  console.error('[PERSIST] Hay almacenamiento externo configurado: arrancá con "npm start" (start.js) para restaurar los datos antes de iniciar el servidor.');
  process.exit(1);
}

// Un error no controlado (en un timer, un evento de socket o una promesa) ya NO cierra el proceso: antes tumbaba el servidor
// entero y todas las partidas decían «se cerró / creá una nueva». Ahora se registra y el servidor sigue en pie.
let _fatalCount = 0, _fatalWindowAt = 0;
function _onFatal(kind, err) {
  console.error(`[${kind}]`, err && err.stack ? err.stack : err);
  const t = Date.now(); if (t - _fatalWindowAt > 60000) { _fatalWindowAt = t; _fatalCount = 0; }
  if (++_fatalCount > 200) { console.error('[FATAL] Demasiados errores seguidos; reinicio limpio.'); process.exit(1); }
}
process.on('uncaughtException', err => _onFatal('uncaughtException', err));
process.on('unhandledRejection', err => _onFatal('unhandledRejection', err));
// Vigía del bucle de eventos: si algo lo bloquea mucho rato (física, guardado de la base…), los sockets caen por ping timeout
// y las demás instancias dan por muerta a esta. Queda anotado en el log para poder encontrar al culpable.
try {
  const { monitorEventLoopDelay } = require('perf_hooks'), h = monitorEventLoopDelay({ resolution: 20 }); h.enable();
  setInterval(() => { const max = h.max / 1e6; h.reset(); if (max > 1000) console.warn(`[LAG] El bucle de eventos se bloqueó ${Math.round(max)} ms`); }, 10000).unref();
} catch (_) { /* sin perf_hooks */ }
// Memoria: si el proceso supera el límite del hosting lo mata el sistema sin avisar (parece «el servidor se cerró»). Se anota cada minuto.
setInterval(() => { const m = process.memoryUsage(), mb = n => Math.round(n / 1048576); console.log(`[MEM] rss ${mb(m.rss)} MB · heap ${mb(m.heapUsed)}/${mb(m.heapTotal)} MB · salas ${Object.keys(rooms).length}`); }, 60000).unref();

const app    = express();
const server = http.createServer(app);
const cluster = require('./cluster')();   // varias instancias jugando juntas (Redis); sin CRIX_REDIS_URL queda inactivo
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 45000, pingInterval: 15000,
  maxHttpBufferSize: Math.round((Number(process.env.CRIX_MAX_SOCKET_MB) || 100) * 1024 * 1024),   // antes 1 GB: un solo mensaje podía agotar la memoria
});
// Node 22 corta por defecto cualquier petición que tarde más de 5 min en llegar entera (requestTimeout = 300000):
// los videos/audios grandes en conexiones lentas morían con "timed out". Se desactiva para las subidas binarias.
server.requestTimeout = 0;
server.timeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 65000;   // mayor que el idle de los proxies (60 s) para que no cierren la conexión justo al responder
// Espera a que el archivo llegue al bucket, pero como mucho `ms`: si tarda más, responde igual (la subida sigue en segundo plano
// y, si falla, persist la reintenta). Así el cliente/proxy no da timeout esperando la copia a S3 de un archivo enorme.
const settleUpload = (promise, ms = 20000) => Promise.race([Promise.resolve(promise).catch(() => false), new Promise(r => { const t = setTimeout(() => r(false), ms); t.unref?.(); })]);
// ── Límites de medios ──
// Prácticamente sin tope por defecto: se pueden ajustar con variables de entorno (en MB) sin tocar el código.
// Ojo con Supabase Storage: tiene un límite de tamaño POR ARCHIVO (50 MB en el plan gratis; configurable en Storage → Settings en planes
// de pago) y 1 GB de espacio / 5 GB de salida en el plan gratis. Un video o audio más grande que ese límite se guarda en el disco local
// pero NO se puede subir al bucket. Bajá CRIX_MAX_VIDEO_MB / CRIX_MAX_SOUND_MB si querés rechazarlos de entrada.
const envMB = (name, def) => { const v = Number(process.env[name]); return Math.round((Number.isFinite(v) && v > 0 ? v : def) * 1024 * 1024); };
const LIM = {
  json:  envMB('CRIX_MAX_JSON_MB', 8192),       // cuerpo JSON (texturas en base64, mapas)
  tex:   envMB('CRIX_MAX_TEXTURE_MB', 8192),     // una textura / imagen
  video: envMB('CRIX_MAX_VIDEO_MB', 1048576),     // un video (se sube por streaming, no ocupa memoria)
  sound: envMB('CRIX_MAX_SOUND_MB', 1048576),      // un audio (música larga incluida)
};
app.use(express.json({ limit: LIM.json }));
// Los listados de la API nunca se cachean (ni en el navegador ni en un proxy): cada cliente ve lo último que hay.
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
require('./rules')(app, { readSession, requireAuth, saveDB });   // antes que las rutas que protege
app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));   // health check del hosting
// Identifica qué instancia respondió (cabecera X-Crix-Instance): si dos navegadores ven ids distintos, hay más de una instancia corriendo.
const INSTANCE_TAG = cluster.nodeId;
const CRIX_BUILD = 'ligero-2026-11-25';   // sirve para comprobar qué versión del código está corriendo realmente en el hosting
app.use('/api', (req, res, next) => { res.set({ 'X-Crix-Instance': INSTANCE_TAG, 'X-Crix-Build': CRIX_BUILD }); next(); });
// Lecturas del catálogo: primero se trae lo que otra instancia haya subido (así lo publicado se ve en todos lados al instante).
app.use(['/api/maps', '/api/videos', '/api/posts', '/api/users'], async (req, res, next) => {
  if (req.method === 'GET') { try { await persist.pullFresh(2000, 2500); } catch {} }
  next();
});
// Sesión creada en OTRA instancia: si el token todavía no está en la copia local de la base, se sincroniza antes de
// responder 401 (antes solo lo hacía el socket, y el HTTP devolvía "Iniciá sesión" a alguien que sí la tenía).
app.use('/api', async (req, res, next) => {
  try {
    const h = req.get('authorization') || '';
    const tk = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (tk && persist.enabled && !DB.sessions[tokenHash(tk)]) await persist.pullFresh(0, 3000);
  } catch {}
  next();
});
app.get('/api/instance', (req, res) => res.json({ ok:true, build:CRIX_BUILD, instance:INSTANCE_TAG, uptime:Math.round(process.uptime()), maps:Object.keys(DB.maps).length, users:Object.keys(DB.users).length, persist:persist.enabled }));
// Compresión gzip (asíncrona) de las respuestas JSON grandes: el catálogo de mapas pesa muchos MB sin comprimir.
const zlib = require('zlib');
app.use('/api', (req, res, next) => {
  const orig = res.json.bind(res);
  res.json = obj => {
    if (res.headersSent || !/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return orig(obj);
    let raw; try { raw = Buffer.from(JSON.stringify(obj), 'utf8'); } catch (e) { return orig(obj); }
    if (raw.length < 4096) return orig(obj);
    zlib.gzip(raw, { level: 5 }, (err, gz) => {
      if (res.headersSent) return;
      if (err) return orig(obj);
      res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      res.end(gz);
    });
    return res;
  };
  next();
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = persist.DATA_FILE;

// ══════════════════════════════════════════════
// Base de datos JSON. En producción, CRIX_DATA_FILE debe apuntar
// a un disco persistente montado por el proveedor de alojamiento.
// ══════════════════════════════════════════════
let DB = { users: {}, maps: {}, convs: {}, videos: [], posts: [], sessions: {}, apiKeys: {}, accessories: {}, datastores: {}, push: {}, _v: 0 };
let dbSync = null;   // fusión entre instancias (db-sync.js); se crea justo después de loadDB()

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      DB = { users:{}, maps:{}, convs:{}, videos:[], posts:[], sessions:{}, apiKeys:{}, accessories:{}, datastores:{}, push:{}, _v:0, ...parsed };
      DB.users = DB.users || {}; DB.maps = DB.maps || {}; DB.convs = DB.convs || {};
      DB.videos = DB.videos || []; DB.posts = DB.posts || []; DB.sessions = DB.sessions || {}; DB.apiKeys = DB.apiKeys || {}; DB.accessories = DB.accessories || {}; DB.datastores = DB.datastores || {};
      // Los mensajes anteriores al cifrado E2EE no se pueden proteger retroactivamente.
      // Eliminarlos evita volver a servir o conservar conversaciones en texto plano.
      let legacyMessagesRemoved = 0;
      for (const [conversationId, messages] of Object.entries(DB.convs)) {
        const encrypted = (Array.isArray(messages) ? messages : []).filter(message =>
          message?.e2ee?.v === 1 && typeof message.e2ee.peer?.ciphertext === 'string' &&
          typeof message.e2ee.self?.ciphertext === 'string'
        );
        legacyMessagesRemoved += (Array.isArray(messages) ? messages.length : 0) - encrypted.length;
        if (encrypted.length) DB.convs[conversationId] = encrypted;
        else delete DB.convs[conversationId];
      }
      let rolesChanged = false;
      const crixUser = Object.values(DB.users).find(user => user.username?.toLowerCase() === 'crix');
      const crixAdminConfigured = !!(crixUser && process.env.CRIX_ADMIN_PASSWORD && verifyPassword(process.env.CRIX_ADMIN_PASSWORD, crixUser.pw));
      for (const user of Object.values(DB.users)) {
        if (user.username?.toLowerCase() === 'crix') {
          if (!!user.isAdmin !== crixAdminConfigured) { user.isAdmin = crixAdminConfigured; rolesChanged = true; }
        } else if (user.isAdmin && (!crixAdminConfigured || !crixUser || user.adminGrantedBy !== crixUser.id)) {
          user.isAdmin = false; delete user.adminGrantedBy; rolesChanged = true;
        }
      }
      if (rolesChanged) saveDB();
      if (legacyMessagesRemoved) {
        console.warn(`[E2EE] Eliminados ${legacyMessagesRemoved} mensajes antiguos que estaban en texto plano`);
        saveDB();
      }
      console.log(`[DB] Cargado: ${Object.keys(DB.users).length} usuarios, ${Object.keys(DB.maps).length} mapas`);
    } else {
      console.log('[DB] Archivo nuevo — empezando vacío');
    }
  } catch(e) { console.error('[DB] Error al cargar:', e.message); }
}

let lastDbSig = null;
// Guardar la base cuesta O(tamaño de la base) y es síncrono (reconcile + stringify + hash + disco). Se llamaba 59 veces desde las
// rutas (cada mensaje, like, edición…) y cada llamada congelaba el servidor: sockets con ping timeout, «partida no activa», etc.
// Ahora saveDB() solo AGENDA el guardado: todas las llamadas seguidas se funden en una, y la espera crece con lo que tarde cada guardado
// (el servidor nunca pasa más de ~12 % del tiempo guardando). En el cierre se usa saveDBNow() para no perder nada.
let _saveTimer = null, _saveCost = 0;
function saveDB() {
  if (_saveTimer) return;
  const wait = Math.max(1500, Math.min(30000, Math.round(_saveCost * 8)));
  _saveTimer = setTimeout(() => { _saveTimer = null; saveDBNow(); }, wait);
}
const SYNC_OFF = process.env.CRIX_SYNC_MS === '0';   // sin sincronización entre instancias nadie lee los sellos `_u`: no hace falta calcularlos
function saveDBNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  const t0 = Date.now();
  try {
    if (dbSync && !SYNC_OFF) dbSync.reconcile();   // estampa `_u` en lo que cambió y deja lápidas de lo que se borró
    // Solo se escribe (y se sube al almacenamiento externo) si el contenido cambió.
    // Antes la base se recorría 3 veces (sellos + firma + archivo); ahora se serializa UNA sola vez (sin `_v`), se firma ese texto
    // y, si cambió, el mismo texto es el archivo: menos CPU y menos memoria pasajera (clave en contenedores de 256 MB / 0,1 vCPU).
    const prevV = DB._v || 0;
    delete DB._v;
    let body; try { body = JSON.stringify(DB); } finally { DB._v = prevV; }
    const sig = crypto.createHash('sha1').update(body).digest('hex');
    if (sig === lastDbSig) return;
    DB._v = prevV + 1;
    const json = body === '{}' ? '{"_v":' + DB._v + '}' : '{"_v":' + DB._v + ',' + body.slice(1);
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tempFile = `${DATA_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, json, 'utf8');
    fs.renameSync(tempFile, DATA_FILE);
    lastDbSig = sig;
    persist.saveDb(json);
  } catch(e) { console.error('[DB] Error al guardar:', e.message); }
  finally {
    const cost = Date.now() - t0; _saveCost = _saveCost ? Math.round(_saveCost * 0.6 + cost * 0.4) : cost;
    if (cost > 500) console.warn(`[DB] Guardar la base tardó ${cost} ms (bloquea el servidor mientras tanto)`);
  }
}

loadDB();

// ══════════════════════════════════════════════
// TIEMPO REAL: avisos por Socket.IO
// ══════════════════════════════════════════════
// Cada cuenta tiene su sala `user:<id>`: TODOS sus dispositivos/pestañas conectados reciben los avisos
// (antes solo el último socket conectado, y por eso algo se veía en el celular y no en la PC).
const userRoom = id => 'user:' + id;
function toUser(id) { return io.to(userRoom(id)); }
// Un video privado solo lo ve su autor: sus avisos no se difunden al resto.
function emitVideoEvent(video, event, payload) {
  if (!video || videoIsPublic(video)) io.emit(event, payload);
  else toUser(video.authorId).emit(event, payload);
}
function emitMembers(convId, event, payload) { String(convId).split('_').forEach(uid => toUser(uid).emit(event, payload)); }

// ── Varias instancias comparten la base a través del bucket: se fusionan los cambios de las demás ──
function broadcastRemote(events) {
  for (const [col, kind, id, rec] of events) {
    if (col === 'maps') {
      if (kind === 'new') { if (mapIsPublic(rec)) io.emit('map_new', { mapId:id, name:rec.name, authorName:rec.authorName }); else io.emit('map_updated', { mapId:id }); }
      else if (kind === 'updated') io.emit('map_updated', { mapId:id });
      else if (kind === 'deleted') io.emit('map_deleted', { mapId:id });
    } else if (col === 'videos') {
      if (kind === 'new' && rec.ready !== false && videoIsPublic(rec)) io.emit('video_new', { id, title:rec.title, authorId:rec.authorId, authorName:rec.authorName, cat:rec.cat, thumb:rec.thumb, ...thumbLabel(rec), created:rec.created, privacy:rec.privacy });
      else if (kind === 'new') io.emit('video_updated', { id, refetch:true });   // borrador o privado: cada cliente pide lo que puede ver
      else if (kind === 'updated') io.emit('video_updated', { id, refetch:true });   // likes, vistas, comentarios, título, privacidad
      else if (kind === 'deleted') io.emit('video_deleted', { id });
    } else if (col === 'posts') {
      if (kind === 'new') io.emit('new_post', { id, authorId:rec.authorId, authorName:rec.authorName, text:(rec.text || '').substring(0, 100) });
      else if (kind === 'updated') io.emit('post_updated', { id, refetch:true });    // likes, respuestas, ediciones
      else if (kind === 'deleted') io.emit('post_deleted', { id });
    } else if (col === 'convs') {
      emitMembers(id, 'conv_updated', { convId:id });                                 // mensajes que entraron por otra instancia
    } else if (col === 'users') {
      if (kind === 'new') io.emit('user_new', { userId:id, username:rec.username, color:rec.color });
      else io.emit('user_updated', { userId:id });
    }
  }
}
dbSync = require('./db-sync')({ getDB: () => DB, onRemoteChange: broadcastRemote });
dbSync.init();
// Un contenido borrado no se puede volver a crear con el mismo id (un cliente con copia local vieja lo re-subía al iniciar sesión).
function rejectIfDeleted(res, col, id) {
  if (!dbSync || !dbSync.isDeleted(col, id)) return false;
  res.status(410).json({ ok:false, code:'DELETED', err:'Este contenido fue eliminado' });
  return true;
}
persist.setSync({ merge(remote) { const changed = dbSync.merge(remote); if (changed) saveDB(); return changed; } });
persist.startSync();

// DataStore de los Script de servidor (game.getDataStore): datos persistentes por juego dentro de la misma base. Ver datastore.js.
const scriptDataStore = require('./datastore')({ getDB: () => DB, saveDB });

// Notificaciones push (mensajes, llamadas y solicitudes con la app cerrada)
const push = require('./push')({ getDB: () => DB, saveDB });
push.init();
// Guardar cada 10 segundos para no perder datos
setInterval(saveDB, LOWRES.low ? 60000 : 20000);   // red de seguridad; los cambios normales ya agendan su propio guardado

// ══════════════════════════════════════════════
// ESTADO EN MEMORIA (sesiones activas)
// ══════════════════════════════════════════════
const rooms          = {};
const connSockets    = {};   // socketId → { userId, username, color, mapId }
const onlineUsers    = {};   // userId   → { socketId, username, color }
const stats = { start: Date.now(), total: 0 };
const calls = new Map();       // userId → { peer, caller, accepted, type, timer } (llamadas sonando o activas)
// ¿Hace falta mandar push? Solo si la persona no tiene Crix abierto y a la vista en algún dispositivo.
// La decisión es por dispositivo: solo se omite el push a los dispositivos que tienen Crix a la vista en este
// momento. Otro dispositivo de la misma cuenta (por ejemplo el iPhone con la PC abierta) igual recibe el aviso.
// Un "visible" solo vale si se renovó hace poco (el cliente lo reenvía cada 10 s mientras está a la vista).
// Si cierran la PWA y el socket queda colgado hasta el ping timeout (iPhone/PC), el estado viejo no puede
// seguir tapando el push: pasados VIS_FRESH_MS se considera que la app ya no está a la vista.
const VIS_FRESH_MS = 25000;
const CALL_DISCONNECT_GRACE_MS = 120000;                // margen para que una llamada en curso sobreviva al segundo plano
const RING_EVERY_MS = 4000, RING_MAX_REPEATS = 10;   // timbre repetido por push mientras la llamada suena
function visibleEndpoints(userId) {
  const set = new Set(), now = Date.now();
  for (const meta of Object.values(connSockets)) {
    if (meta.userId === userId && meta.visible === true && meta.endpoint && now - (meta.visAt || 0) < VIS_FRESH_MS) set.add(meta.endpoint);
  }
  return set;
}
function needsPush(userId) {
  if (!push.has(userId)) return false;
  const skip = visibleEndpoints(userId);
  return !skip.size || (DB.push?.[userId] || []).some(sub => !skip.has(sub.endpoint));
}
function notifyPush(userId, payload, options) {
  if (!userId || !needsPush(userId)) return;
  push.send(userId, payload, { ...(options || {}), excludeEndpoints: visibleEndpoints(userId) }).catch(() => {});
}
// ── Novedades como notificación ──
// Un aviso de actividad (comentario, me gusta, seguidor nuevo, algo nuevo de alguien que seguís...) llega por dos vías:
// en vivo por socket (toast si la app está abierta) y como push al PWA cuando no está a la vista.
// `tag` hace que avisos repetidos de lo mismo se reemplacen en vez de apilarse. El push nunca lleva datos privados.
const clip = (t, n = 110) => { t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function notifyActivity(userId, p, options) {
  const { noSocket, ...pushOpts } = options || {};
  if (!userId || !p || !DB.users[userId]) return;
  if (p.from && String(p.from) === String(userId)) return;   // nunca te avisa de lo que hiciste vos
  const id = p.id == null ? '' : String(p.id);
  const payload = { type:'activity', kind:p.kind, id, from:p.from || '', fromName:p.fromName || '', title:clip(p.title, 80), body:clip(p.body, 140),
    tag:p.tag || ('act-' + p.kind + '-' + id), url:'/?n=open&k=' + encodeURIComponent(p.kind) + '&id=' + encodeURIComponent(id) + (p.kind === 'user' ? '&u=' + encodeURIComponent(id) : '') };
  if (!noSocket) try { toUser(userId).emit('activity', { kind:payload.kind, id, title:payload.title, body:payload.body, tag:payload.tag }); } catch {}
  notifyPush(userId, payload, { ttl:3 * 24 * 3600, ...pushOpts });
}
// Quién quiere enterarse de lo nuevo de una cuenta: sus seguidores y sus amigos (máx. 1000).
function audienceOf(authorId) {
  const author = DB.users[authorId], friends = new Set((author && author.friends) || []), out = [];
  for (const u of Object.values(DB.users)) {
    if (!u || u.id === authorId || banActive(u)) continue;
    if ((Array.isArray(u.following) && u.following.includes(authorId)) || friends.has(u.id)) { out.push(u); if (out.length >= 1000) break; }
  }
  return out;
}
function announceNew(kind, rec, authorId, authorName, title, body) {
  for (const u of audienceOf(authorId)) {
    if ((kind === 'game' || kind === 'video') && !canEnterAdult(rec, u)) continue;   // el contenido +18 solo se anuncia a quien puede abrirlo
    notifyActivity(u.id, { kind, id:rec.id, from:authorId, fromName:authorName, title, body }, { noSocket:true });
  }
}
const kindWord = m => (m && m.kind === 'app') ? 'app' : 'juego';
// El chat y las llamadas son solo entre amigos (la amistad es mutua: ambas cuentas se tienen en su lista).
function areFriends(a, b) {
  const ua = DB.users[a], ub = DB.users[b];
  return !!(ua && ub && a !== b && (ua.friends || []).includes(b) && (ub.friends || []).includes(a));
}
// Cómo terminó la última llamada de cada persona (2 min): si estaba sin conexión justo cuando la otra rechazó/cortó, lo recibe
// al volver (call_sync) y la pantalla no queda en "Llamando…" para siempre.
const callOutcomes = new Map();   // userId → { peer, event, reason, at }
function rememberOutcome(userId, peerId, event, reason) { callOutcomes.set(userId, { peer:peerId, event, reason:reason || '', at:Date.now() }); }
setInterval(() => { const now = Date.now(); for (const [k, v] of callOutcomes) if (now - v.at > 120000) callOutcomes.delete(k); }, 60000).unref?.();
const CALL_STALE_RING_MS = 55000;                        // una llamada que sigue "sonando" pasado esto quedó huérfana
function dropStaleRinging(userId) {
  const c = calls.get(userId);
  if (c && !c.accepted && Date.now() - (c.startedAt || 0) > CALL_STALE_RING_MS) clearCall(userId);
}
function clearCall(userId, notify) {
  const c = calls.get(userId); if (!c) return null;
  clearTimeout(c.timer); clearInterval(c.ring); clearTimeout(c.dcTimer); calls.delete(userId);
  const other = calls.get(c.peer);
  if (other && other.peer === userId) { clearTimeout(other.timer); clearInterval(other.ring); clearTimeout(other.dcTimer); calls.delete(c.peer); }
  if (notify) {
    rememberOutcome(c.peer, userId, notify.event, notify.reason);
    const target = onlineUsers[c.peer]; if (target) io.to(target.socketId).emit(notify.event, { from:userId, reason:notify.reason });
  }
  // Si la llamada no llegó a atenderse y la cortó/perdió quien llamaba, se cancela el timbre en los
  // dispositivos de quien recibía y queda un aviso de llamada perdida.
  if (!c.accepted && c.caller && push.has(c.peer)) {
    const caller = DB.users[userId];
    push.send(c.peer, {
      type:'call_cancel', missed:true, from:userId, fromName:caller?.username || 'Alguien',
      callType:c.type || 'audio', tag:'call-' + userId, url:'/?n=missed&u=' + encodeURIComponent(userId)
    }, { ttl:600, urgency:'high', topic:'call' + String(userId).slice(0,20) }).catch(() => {});
  }
  return c;
}

function maxPlayersFor(map) { const n = Number(map?.maxPlayers); return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 50; }
function roomKey(mapId, instanceId) { return JSON.stringify([mapId, instanceId]); }
function gameChannel(mapId, instanceId) { return `game:${encodeURIComponent(mapId)}:${instanceId}`; }
function getRoom(mapId, instanceId) {
  const key = roomKey(mapId, instanceId);
  if (!rooms[key]) rooms[key] = { mapId, instanceId, createdAt:Date.now(), players:{}, avatars:{}, npcs:{}, chat:[], worldParts:null, basePartIds:new Set(), changedPartIds:new Set(), removedPartIds:new Set(), physicsVelocities:{}, scriptStarted:false, scriptStatus:'stopped', pendingReset:false, commandTimes:[], watched:new Set(), appliedSeq:0, phys:null, collectedIds:new Set() };
  return rooms[key];
}
function roomPlayers(room) { return Object.values(room.players); }
// Velocidad de cada jugador (studs/s), estimada con sus últimas posiciones; no viaja a los demás clientes.
const playerVelocity = new WeakMap();
function playersForRunner(room) { return roomPlayers(room).map(player => { const v = playerVelocity.get(player) || {x:0,y:0,z:0}; return { ...player, vx:v.x, vy:v.y, vz:v.z }; }); }
function log(t,d) { console.log(`[${new Date().toLocaleTimeString()}] ${t}:`, d); }

function normalizeRoomPart(id, source = {}) {
  const pos=source.position||{}, size=source.size||{};
  const number=(value,fallback=0,min=-1e9,max=1e9)=>{const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;};
  const types=['Block','Sphere','Cylinder','Wedge','TrussPart','Spawn','ImportedMesh'];
  const materials=['SmoothPlastic','Plastic','Brick','Wood','WoodPlanks','Metal','DiamondPlate','Neon','Glass','Ice','Grass','Sand','Concrete','Rock','Marble','Cobblestone','Fabric'];
  const type=types.includes(source.type)?source.type:'Block';
  const part={
    id:String(id).slice(0,120), name:String(source.name||'Part').slice(0,80), type,
    x:number(source.x??pos.x??pos.X),y:number(source.y??pos.y??pos.Y),z:number(source.z??pos.z??pos.Z),
    sx:number(source.sx??size.x??size.X,4,0.001,1e9),sy:number(source.sy??size.y??size.Y,4,0.001,1e9),sz:number(source.sz??size.z??size.Z,4,0.001,1e9),
    rx:number(source.rx),ry:number(source.ry),rz:number(source.rz),
    color:/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(source.color||''))?String(source.color):'#5b8def',
    material:materials.includes(source.material)?source.material:'SmoothPlastic',
    anchored:source.anchored!==false,canCollide:source.canCollide!==false,transparent:number(source.transparent,0,0,1),
    behavior:['none','kill','bounce','checkpoint','speed','coin','heal','teleport','win'].includes(source.behavior)?source.behavior:'none',
    behaviorValue:number(source.behaviorValue,0,-1e9,1e9),target:String(source.target||'').slice(0,80),
    textureId:/^tx_[a-z0-9]{3,40}$/.test(String(source.textureId||''))?String(source.textureId):'',texScale:number(source.texScale,4,0.001,1e6),texTint:source.texTint===true,
  };
  for(const [key,lo,hi,fallback] of [['friction',0,1,0.15],['bounce',0,1,0.05],['drag',0,1,0.003],['gravityScale',-5,5,1]])if(source[key]!==undefined&&source[key]!==null)part[key]=number(source[key],fallback,lo,hi);
  if(Array.isArray(source.tags))part.tags=source.tags.map(tag=>String(tag).slice(0,40));
  // Propiedades extra estilo Roblox (BasePart). Solo se guardan las que vienen definidas.
  if(source.reflectance!==undefined)part.reflectance=number(source.reflectance,0,0,1);
  if(source.density!==undefined)part.density=number(source.density,0.7,0.01,100);
  for(const key of ['castShadow','canTouch','canQuery','massless','locked','negate'])if(source[key]!==undefined)part[key]=source[key]!==false;
  if(source.collisionGroup!==undefined)part.collisionGroup=String(source.collisionGroup||'Default').slice(0,40);
  if(source.parent!==undefined&&source.parent!==null)part.parent=String(source.parent).slice(0,120);
  if(source.attributes&&typeof source.attributes==='object'&&!Array.isArray(source.attributes)){
    const attrs={};for(const [k,v] of Object.entries(source.attributes).slice(0,32)){if(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k)&&['string','number','boolean'].includes(typeof v))attrs[k]=typeof v==='string'?v.slice(0,200):v;}
    part.attributes=attrs;
  }
  if(type==='ImportedMesh'&&typeof source.meshData==='string')part.meshData=source.meshData;
  if(typeof source.avatarMesh==='string'&&/^[A-Za-z]{2,20}$/.test(source.avatarMesh))part.avatarMesh=source.avatarMesh;
  return part;
}

function initializeRoomWorld(room, map) {
  { const legacy=CrixObjects.migrateLegacyNpcs(map||{});if(legacy.converted)map={...map,parts:legacy.parts,joints:legacy.joints,instances:legacy.instances}; }   // NPC antiguos → Model sin comportamiento
  room.avatars={}; room.npcs={};
  worldPhysics.disposeRoom(room);
  room.physicsMode=(map&&(map.physicsMode==='classic'||(map.settings&&map.settings.physicsMode==='classic')))?'classic':'realistic';
  room.worldParts={}; room.basePartIds=new Set(); room.changedPartIds=new Set(); room.removedPartIds=new Set(); room.physicsVelocities={};
  for(const [index,source] of (Array.isArray(map?.parts)?map.parts:[]).entries()){
    if(source&&source.isNPC){const nid=String(source.id||`map-part-${index}`);room.npcs[nid]={id:nid,name:String(source.name||'NPC').slice(0,80),x:Number(source.x)||0,y:Number(source.y)||0,z:Number(source.z)||0,look:source.look&&typeof source.look==='object'?CrixAvatar.sanitizeLook(source.look,{}):null};continue;}
    if(!source)continue;
    const id=String(source.id||`map-part-${index}`),part=normalizeRoomPart(id,source);
    room.worldParts[id]=part;room.basePartIds.add(id);
  }
  room.joints=(Array.isArray(map?.joints)?map.joints:[]).map((joint,index)=>CrixJoints.sanitize(joint,'joint-'+index));
  room.jointState={};room.jointVel={};room.jointDriven=null;room.jointAt=0;room.jointErrors=new Set();
  room.instances=(Array.isArray(map?.instances)?map.instances:[]).map((item,index)=>CrixObjects.sanitizeInstance(item,'inst-'+index));
  room.models=CrixObjects.buildModelsInfo(Object.values(room.worldParts||{}),room.joints,room.instances);
  room.animations=(Array.isArray(map?.animations)?map.animations:[]).map(item=>CrixAnim.sanitize(item));   // biblioteca de animaciones del mapa (por id)
  room.pendingReset=false;room.scriptStarted=false;room.scriptStatus='stopped';room.commandTimes=[];room.watched=new Set();room.appliedSeq=0;room.phys=null;room.collectedIds=new Set();
}

function roomWorldSnapshot(room) {
  const runtimeParts=Object.values(room.worldParts||{}).filter(part=>!room.basePartIds.has(part.id)&&part.type!=='Spawn');
  const worldChanges=Array.from(room.changedPartIds).map(id=>room.worldParts[id]).filter(part=>part&&part.type!=='Spawn');
  return {runtimeParts,worldChanges,removedParts:[...room.removedPartIds],collectedParts:[...(room.collectedIds||[])]};
}

let scriptRunner=null, scriptRunnerError=null, scriptRunnerFailedAt=0;
function ensureScriptRunner() {
  if(scriptRunner?.connected)return scriptRunner;
  // Un fallo puntual del proceso aislado ya no deja los scripts muertos hasta el próximo deploy: se reintenta a los 15 s.
  if(scriptRunnerError){if(Date.now()-scriptRunnerFailedAt<15000)return null;scriptRunnerError=null;}
  try{
    const major=Number(process.versions.node.split('.')[0]);
    scriptRunner=fork(path.join(__dirname,'script-runner.js'),[],{execArgv:(major>=20?['--no-node-snapshot']:[]).concat(LOWRES.low?['--max-old-space-size='+Math.max(32,Math.round(LOWRES.memMB*0.2))]:[]),stdio:['ignore','inherit','inherit','ipc']});
    scriptRunner.on('message',handleScriptRunnerMessage);
    scriptRunner.on('error',error=>{scriptRunnerError=error.message;scriptRunnerFailedAt=Date.now();log('SCRIPT_RUNNER',error.message);});
    scriptRunner.on('exit',(code)=>{scriptRunner=null;if(code!==0){scriptRunnerError='El proceso aislado de scripts terminó ('+code+'). Se reintentará solo en unos segundos.';scriptRunnerFailedAt=Date.now();log('SCRIPT_RUNNER',scriptRunnerError);for(const room of Object.values(rooms)){if(room.scriptStarted){room.scriptStarted=false;room.scriptStatus='error';io.to(gameChannel(room.mapId,room.instanceId)).emit('script_runtime_status',{status:'error',message:scriptRunnerError});}}}});
    return scriptRunner;
  }catch(error){scriptRunnerError=error.message;scriptRunnerFailedAt=Date.now();log('SCRIPT_RUNNER',error.message);return null;}
}

function startRoomServerScripts(room,map) {
  if(room.scriptStarted)return;
  const scripts=(Array.isArray(map?.scripts)?map.scripts:[]).filter(script=>script?.type==='Script');
  room.scriptChars=scripts.reduce((sum,script)=>sum+String(script.code||'').length,0);
  if(!scripts.length){room.scriptStarted=true;room.scriptStatus='ready';io.to(gameChannel(room.mapId,room.instanceId)).emit('script_runtime_status',{status:'ready',scriptCount:0,scriptChars:0});return;}
  const runner=ensureScriptRunner();
  if(!runner){room.scriptStatus='error';io.to(gameChannel(room.mapId,room.instanceId)).emit('script_runtime_status',{status:'error',message:scriptRunnerError||'No se pudo iniciar el entorno de scripts.'});return;}
  room.scriptStarted=true;room.scriptStatus='starting';
  room.watched=new Set();room.appliedSeq=0;
  runner.send({type:'start',roomId:roomKey(room.mapId,room.instanceId),mapId:room.mapId,instanceId:room.instanceId,scripts,parts:Object.values(room.worldParts||{}),joints:(room.joints||[]).map(joint=>({id:joint.id,class:joint.class,name:joint.name})),models:room.models||[],animations:room.animations||[],npcs:Object.values(room.npcs||{}).map(n=>({id:n.id,name:n.name,x:n.x,y:n.y,z:n.z})),npcStates:Object.fromEntries(Object.entries(room.avatars||{}).filter(([k])=>k.startsWith('n:')).map(([k,v])=>[k.slice(2),v])),players:playersForRunner(room)});
}

function sendRoomPlayersToRunner(room) {
  if(!scriptRunner?.connected||!room?.scriptStarted)return;
  scriptRunner.send({type:'players',roomId:roomKey(room.mapId,room.instanceId),players:playersForRunner(room)});
}

function handleScriptRunnerMessage(message) {
  if(!message||typeof message!=='object')return;
  if(message.type==='fatal'){scriptRunnerError=String(message.message||'Falló el entorno aislado de scripts.');scriptRunnerFailedAt=Date.now();log('SCRIPT_RUNNER',scriptRunnerError);return;}
  const room=Object.values(rooms).find(item=>roomKey(item.mapId,item.instanceId)===String(message.roomId||''));
  if(!room)return;
  if(message.type==='started'){
    room.scriptStatus='ready';
    io.to(gameChannel(room.mapId,room.instanceId)).emit('script_runtime_status',{status:'ready',scriptCount:message.scriptCount||0,scriptChars:room.scriptChars||0});
    return;
  }
  if(message.type==='roomError'){
    room.scriptStarted=false;room.scriptStatus='error';
    io.to(gameChannel(room.mapId,room.instanceId)).emit('script_runtime_status',{status:'error',message:String(message.message||'Error al iniciar scripts.').slice(0,300)});
    return;
  }
  if(message.type==='output'){
    io.to(gameChannel(room.mapId,room.instanceId)).emit('script_output',{script:String(message.script||'Script').slice(0,80),text:String(message.text||'').slice(0,500),cls:message.cls==='warn'?'warn':message.cls==='err'?'err':''});
    return;
  }
  if(message.type==='watch'){if(room.watched.size<200)room.watched.add(String(message.key||'').slice(0,120));return;}
  if(message.type==='playerCommand'){
    const target=roomPlayers(room).find(player=>String(player.userId)===String(message.userId));
    if(target)io.to(target.socketId).emit('server_player_cmd',{op:String(message.op||''),...(message.payload&&typeof message.payload==='object'?message.payload:{})});
    return;
  }
  if(message.type==='soundCommand'){
    const channel=gameChannel(room.mapId,room.instanceId),raw=String(message.target??'*');
    if(raw==='*'||raw==='all'){io.to(channel).emit('sound_cmd',message.cmd);return;}
    const target=roomPlayers(room).find(player=>String(player.userId)===raw||String(player.socketId)===raw);
    if(target)io.to(target.socketId).emit('sound_cmd',message.cmd);
    return;
  }
  if(message.type==='avatarCommand'){
    const diff=CrixAvatar.sanitizeCommand(message.cmd);if(!diff)return;
    const raw=String(message.target??'').slice(0,120),keys=[];
    if(raw==='*'||raw==='all'){for(const player of roomPlayers(room))keys.push(player.socketId);}
    else{
      const player=roomPlayers(room).find(item=>String(item.userId)===raw||String(item.socketId)===raw);
      if(player)keys.push(player.socketId);
      else if(raw.startsWith('p:')&&room.worldParts&&room.worldParts[raw.slice(2)])keys.push(raw);   // cara de la pieza Head de un Model (animación de cara)
      else for(const npc of Object.values(room.npcs||{}))if(npc.id===raw||npc.name===raw)keys.push('n:'+npc.id);
    }
    const channel=gameChannel(room.mapId,room.instanceId);
    for(const key of keys.slice(0,64)){
      if(diff.move&&!(key[0]==='n'&&key[1]===':'))continue;   // mover solo vale para NPC (los jugadores se mueven con teleportPlayer)
      const state=room.avatars[key]||(room.avatars[key]={});CrixAvatar.mergeState(state,diff);
      if(JSON.stringify(state).length>24000){delete room.avatars[key];continue;}
      if(key[0]!=='n'||key[1]!==':'){const pl=room.players[key];if(pl&&state.look)pl.look=CrixAvatar.sanitizeLook(state.look,pl.look);}
      io.to(channel).emit('avatar_cmd',{target:key,diff,ts:Date.now()});
    }
    return;
  }
  if(message.type==='dsRequest'){
    const reply={type:'dsResponse',roomId:message.roomId,id:message.id};
    try{reply.ok=true;reply.result=scriptDataStore.handle(room.mapId,message.req);}
    catch(error){reply.ok=false;reply.error=error instanceof scriptDataStore.DataStoreError?error.message:'Error interno del DataStore';if(!(error instanceof scriptDataStore.DataStoreError))log('DATASTORE',error.message);}
    if(scriptRunner?.connected)scriptRunner.send(reply);
    return;
  }
  if(message.type==='remoteOut'){
    const name=String(message.name||'');
    if(message.userId==='*'){io.to(gameChannel(room.mapId,room.instanceId)).emit('script_remote',{name,data:message.data});return;}
    const target=roomPlayers(room).find(player=>String(player.userId)===String(message.userId));
    if(target)io.to(target.socketId).emit('script_remote',{name,data:message.data});
    return;
  }
  if(message.type==='sceneCommand'){room.appliedSeq=Math.max(room.appliedSeq||0,Number(message.seq)||0);applyServerScriptCommand(room,message.command,message.payload||{});}
}

function applyServerScriptCommand(room,command,payload) {
  const now=Date.now();room.commandTimes=room.commandTimes.filter(time=>now-time<1000);
  if(room.commandTimes.length>=300)return;
  room.commandTimes.push(now);
  const id=String(payload.id||'').slice(0,120);
  if(command==='physVelocity'||command==='physImpulse'){
    const part=room.worldParts?.[id],v=payload.v||{};
    if(!part||part.anchored)return;           // solo las piezas sueltas (anchored:false) tienen física
    const vector={};for(const axis of ['x','y','z'])if(v[axis]!==undefined)vector[axis]=Math.max(-500,Math.min(500,Number(v[axis])||0));
    if(command==='physVelocity')worldPhysics.setVelocity(room,id,vector);else worldPhysics.addImpulse(room,id,vector);
    return;
  }
  if(command==='jointCreate'||command==='jointUpdate'||command==='jointDestroy'){
    const jid=String(payload.id||'').slice(0,120);if(!jid||!room.joints)return;
    const index=room.joints.findIndex(joint=>joint.id===jid);
    if(command==='jointDestroy'){if(index>=0){room.joints.splice(index,1);delete room.jointState[jid];}return;}
    if(command==='jointCreate'){
      if(index>=0)return;
      const joint=CrixJoints.sanitize({...(payload.data||{}),id:jid},jid);
      if(payload.preserve!==false&&joint.part0&&joint.part1&&room.worldParts[joint.part0]&&room.worldParts[joint.part1]&&!(payload.data&&payload.data.c0))CrixJoints.preserve(joint,room.worldParts[joint.part0],room.worldParts[joint.part1]);
      room.joints.push(joint);return;
    }
    if(index>=0){const merged=CrixJoints.sanitize({...room.joints[index],...(payload.patch||{}),id:jid,class:room.joints[index].class},jid);room.joints[index]=merged;if(room.jointState[jid])room.jointState[jid].rel=null;}
    return;
  }
  if(command==='createPart'){
    if(Object.keys(room.worldParts||{}).length>=1000||!/^server-[a-z0-9-]{1,100}$/i.test(id)||room.worldParts[id])return;
    const part=normalizeRoomPart(id,payload.data||{});room.worldParts[id]=part;
    io.to(gameChannel(room.mapId,room.instanceId)).emit('runtime_scene',{command:'upsertPart',payload:{part}});
    return;
  }
  if(command==='updatePart'){
    const current=room.worldParts?.[id];if(!current)return;
    const patch=payload.patch&&typeof payload.patch==='object'?payload.patch:{};
    const merged={...current,...patch,id};
    if(patch.position)for(const axis of ['x','y','z'])if(patch.position[axis]!==undefined||patch.position[axis.toUpperCase()]!==undefined)merged[axis]=patch.position[axis]??patch.position[axis.toUpperCase()];
    if(patch.size)for(const axis of ['x','y','z'])if(patch.size[axis]!==undefined||patch.size[axis.toUpperCase()]!==undefined)merged['s'+axis]=patch.size[axis]??patch.size[axis.toUpperCase()];
    const part=normalizeRoomPart(id,merged);room.worldParts[id]=part;
    if(room.basePartIds.has(id))room.changedPartIds.add(id);
    if(part.anchored||part.y!==current.y)worldPhysics.resetBody(room,id);
    scriptRunner?.send({type:'worldPart',roomId:roomKey(room.mapId,room.instanceId),part,appliedSeq:room.appliedSeq||0});
    io.to(gameChannel(room.mapId,room.instanceId)).emit('runtime_scene',{command:'upsertPart',payload:{part},t:Date.now()});   // `t`: hora del servidor, el cliente predice el movimiento con ella (crix-predict.js)
    return;
  }
  if(command==='destroyPart'){
    if(!room.worldParts?.[id])return;
    delete room.worldParts[id];delete room.physicsVelocities[id];
    if(room.basePartIds.has(id))room.removedPartIds.add(id);
    scriptRunner?.send({type:'worldRemove',roomId:roomKey(room.mapId,room.instanceId),id});
    io.to(gameChannel(room.mapId,room.instanceId)).emit('runtime_scene',{command:'destroyPart',payload:{id}});
  }
}

// Uniones: antes de la física se marcan las piezas que controla el solver (la gravedad normal las ignora);
// después se resuelven y se envían las poses nuevas a todos (`joint_poses`, 20 Hz).
function reportJointError(room,joint,message) {
  const key=joint.id+'|'+message;if(room.jointErrors.has(key))return;room.jointErrors.add(key);
  io.to(gameChannel(room.mapId,room.instanceId)).emit('script_output',{script:'Uniones',text:message,cls:'err'});
}
function stepRoomJoints(room,now,channel,roomId,mark) {
  if(!room.joints||!room.joints.length)return;
  if(mark){
    room.jointDriven=CrixJoints.drivenIds(room.joints,room.worldParts);
    for(const part of Object.values(room.worldParts))part.jointDriven=room.jointDriven.has(part.id);
    return;
  }
  const elapsed=room.jointAt?Math.min(0.25,(now-room.jointAt)/1000):0.05;room.jointAt=now;
  const n=Math.max(1,Math.min(5,Math.round(elapsed*60))),h=elapsed/n,moved=new Set();
  const world={parts:room.worldParts,joints:room.joints,state:room.jointState,vel:room.jointVel,partBox:worldPhysics.partBox,onError:(joint,message)=>reportJointError(room,joint,message)};
  for(let i=0;i<n;i++)for(const id of CrixJoints.step(world,h).changed)moved.add(id);
  if(!moved.size)return;
  const r3=v=>Math.round(v*1000)/1000,list=[],update=[];
  for(const id of moved){
    const part=room.worldParts[id];if(!part)continue;
    if(room.basePartIds.has(id))room.changedPartIds.add(id);
    list.push([id,r3(part.x),r3(part.y),r3(part.z),r3(part.rx||0),r3(part.ry||0),r3(part.rz||0)]);
    update.push({id,x:part.x,y:part.y,z:part.z});
  }
  if(list.length){io.to(channel).emit('joint_poses',{t:now,parts:list.slice(0,600)});scriptRunner?.send({type:'worldPositions',roomId,parts:update,appliedSeq:room.appliedSeq||0});}
}

function stepRoomPhysicsSafe(room,now) {
  {
    if(!Object.keys(room.players).length||!room.worldParts){if(room.phys)room.phys.lastAt=0;return;}
    const roomId=roomKey(room.mapId,room.instanceId),channel=gameChannel(room.mapId,room.instanceId);
    stepRoomJoints(room,now,channel,roomId,true);
    const result=worldPhysics.stepRoom(room,now,playersForRunner(room));
    stepRoomJoints(room,now,channel,roomId,false);
    if(result.changed.length){
      for(const update of result.changed)if(room.basePartIds.has(update.id))room.changedPartIds.add(update.id);
      // Un único paquete por tick con todas las piezas que se movieron (antes era uno por pieza).
      // `t` permite al cliente interpolar y descartar paquetes viejos.
      io.to(channel).emit('world_delta',{t:now,parts:result.changed});
      scriptRunner?.send({type:'worldPositions',roomId,parts:result.changed,appliedSeq:room.appliedSeq||0});
    }
    if(result.events.length&&scriptRunner?.connected&&room.scriptStarted)scriptRunner.send({type:'contacts',roomId,events:result.events});
    // Resincronización de seguridad cada 2 s: estado autoritativo de TODAS las piezas con física.
    // Corrige a cualquier cliente que se haya perdido un paquete o estuviera en segundo plano.
    if(!room.lastSyncAt||now-room.lastSyncAt>=(LOWRES.low?4000:2000)){
      room.lastSyncAt=now;
      const parts=[];
      for(const part of Object.values(room.worldParts)){
        if(part.anchored||part.type==='Spawn'||part.y<=-500)continue;
        const entry={id:part.id,x:part.x,y:part.y,z:part.z};
        if(part.type==='Sphere'||room.rigid){entry.rx=part.rx||0;entry.ry=part.ry||0;entry.rz=part.rz||0;}
        parts.push(entry);
        if(parts.length>=400)break;
      }
      if(parts.length)io.to(channel).emit('world_sync',{t:now,parts});
    }
  }
}

function stepServerWorldPhysics() {
  const now=Date.now();
  for(const room of Object.values(rooms)){
    try{stepRoomPhysicsSafe(room,now);}
    catch(err){
      // Una sala con la física rota no debe afectar a las demás ni al servidor: se registra, se libera Rapier y esa sala sigue con la física clásica.
      room._physErrors=(room._physErrors||0)+1;
      console.error('[FÍSICA] Error en la sala '+roomKey(room.mapId,room.instanceId)+':',err&&err.stack?err.stack:err);
      try{if(room.rigid)CrixRigid.dispose(room);}catch(_){}
      try{if(room.phys){room.phys.lastAt=0;room.phys.acc=0;}}catch(_){}
      if(room._physErrors>=3&&room.physicsMode!=='classic'){room.physicsMode='classic';console.warn('[FÍSICA] La sala '+roomKey(room.mapId,room.instanceId)+' pasa a física clásica por errores repetidos.');}
    }
  }
}
// Bucle autoprogramado (en vez de setInterval): si un tick tarda, se espera antes del siguiente para que el servidor pueda atender
// sockets y latidos. En contenedores pequeños (0,1 vCPU) la física va a ~15 Hz, y si un tick tarda mucho (CPU limitada por el hosting)
// el intervalo crece solo: la física nunca ocupa más de ~40 % del tiempo y el servidor no se cuelga.
const PHYS_BASE_MS = LOWRES.low ? 66 : 33;
(function physicsLoop(){
  const t0=Date.now();
  try{stepServerWorldPhysics();}catch(err){console.error('[FÍSICA]',err&&err.stack?err.stack:err);}
  const spent=Date.now()-t0;
  if(spent>100)console.warn('[FÍSICA] Tick lento: '+spent+' ms');
  const t=setTimeout(physicsLoop,Math.max(8,PHYS_BASE_MS-spent,Math.round(spent*1.5)));
})();

// Presencia visible para todos: qué juego e instancia está jugando cada persona.
// Presencia de una persona: la de esta instancia o, si está conectada a otra, la que esa instancia anunció.
function presenceOf(userId) { return onlineUsers[userId] || (cluster.enabled ? cluster.remotePresence(userId) : null); }
// Cuántas personas hay en una sala, esté en esta instancia o en otra.
function roomPlayerCount(mapId, instanceId) {
  const key = roomKey(mapId, instanceId), room = rooms[key];
  if (room) return Object.keys(room.players).length;
  const r = cluster.enabled ? cluster.remoteRoom(key) : null;
  return r ? r.count : 0;
}
function publishPresence(userId) {
  const p = onlineUsers[userId];
  cluster.setLocalPresence(userId, p ? { username:p.username, color:p.color, mapId:p.mapId || null, instanceId:p.instanceId || null } : null);
}
function publishRoom(room) {
  const players = Object.values(room.players);
  cluster.setLocalRoom(roomKey(room.mapId, room.instanceId), players.length && !room.playtest
    ? { mapId:room.mapId, instanceId:room.instanceId, startedAt:room.createdAt, count:players.length, players:players.slice(0, 50).map(pl => ({ id:pl.userId, username:pl.username })) }
    : null);
}
function presenceInfo(userId, viewer) {
  const presence = presenceOf(userId);
  if (!presence) return { online:false };
  const info = { online:true };
  const map = presence.mapId ? DB.maps[presence.mapId] : null;
  if (map && presence.instanceId && (viewer === undefined ? mapIsPublic(map) : (viewer?.id === userId || canReadMap(map, viewer)))) {
    info.currentGameId = presence.mapId; info.currentInstanceId = presence.instanceId;
    info.currentGameName = map.name || presence.mapId;
    info.currentInstancePlayers = roomPlayerCount(presence.mapId, presence.instanceId) || 1;
  }
  return info;
}
function emitPresence(userId) {
  const user = DB.users[userId]; if (!user) return;
  publishPresence(userId);
  io.emit('presence_update', { userId, username:user.username, color:user.color, ...presenceInfo(userId) });
}

// ¿El ban sigue vigente? Un ban con fecha vencida se limpia solo (antes bloqueaba la sesión hasta volver a loguearse).
function banActive(u) {
  const b = u && u.banned; if (!b) return false;
  const until = b.until ? new Date(b.until) : null;
  if (b.permanent || (until && until > new Date())) return true;
  delete u.banned; saveDB();
  return false;
}
// +18: el detalle (cómo lo consiguió cada cuenta) NUNCA sale de acá. La cuenta solo recibe un booleano sobre sí misma
// (el cliente lo usa para abrir o no contenido +18, no lo muestra). Ninguna cuenta, ni admin, ve el detalle: solo el sistema y los scripts.
function safeUser(u) { if (!u) return null; const {pw:_,e2eeVault:__,googleSub:___g,ageVerified:___a,ageCheck:___c,...s}=u; s.adult = isAgeVerified(u); if (s.look && typeof s.look === 'object') s.look = CrixAvatar.profileLook(s.look); return s; }
function publicUser(u) {
  if (!u) return null;
  const { pw:_, e2eeVault:__, banned:___, adminGrantedBy:____, friendRequests:_____, friendRequests_recv:______, friendRequests_sent:_______, googleSub:________, ageVerified:_________, ageCheck:__________, prefs:___________, mail:____________, ...profile } = u;
  if (profile.look && typeof profile.look === 'object') profile.look = CrixAvatar.profileLook(profile.look);
  return profile;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  if (!stored.startsWith('scrypt$')) return stored === String(password); // Upgrade legacy server-side plaintext after login.
  const [, salt, expected] = stored.split('$');
  if (!salt || !expected) return false;
  const actual = Buffer.from(hashPassword(password, salt).split('$')[2], 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return actual.length === expectedBytes.length && crypto.timingSafeEqual(actual, expectedBytes);
}
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function issueSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  DB.sessions[tokenHash(token)] = { userId: user.id, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30 };
  saveDB();
  return token;
}
// ── Apelaciones de baneo ──
// Una cuenta baneada no puede iniciar sesión, así que apela con un token de un solo propósito (30 min) que recibe al intentar entrar,
// o con usuario + contraseña. La apelación se guarda y se manda por mail a crix.support@gmail.com (reply_to = el contacto que dejó).
const APPEAL_TOKEN_MS = 30 * 60 * 1000, APPEAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
function issueAppealToken(user) {
  const now = Date.now(), toks = DB.appealTokens || (DB.appealTokens = {});
  for (const k of Object.keys(toks)) if (toks[k].expiresAt <= now) delete toks[k];
  const token = crypto.randomBytes(24).toString('base64url');
  toks[tokenHash(token)] = { userId: user.id, expiresAt: now + APPEAL_TOKEN_MS };
  saveDB();
  return token;
}
function readSession(req) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const key = tokenHash(token);
  const session = DB.sessions[key];
  if (!session || session.expiresAt <= Date.now()) {
    if (session) { delete DB.sessions[key]; saveDB(); }
    return null;
  }
  const user = DB.users[session.userId];
  if (!user || banActive(user)) return null;
  return user;
}
function requireAuth(req, res, next) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ ok:false, err:'Se requieren permisos de administración' });
  next();
}
// Un juego/app todavía sin clasificar (borrador) no se muestra a nadie más hasta que su autor complete el cuestionario.
function mapIsPublic(map) { return !!map && !map.modHidden && (map.privacy || 'public') === 'public' && !map.unrated; }
function canReadMap(map, user) {
  if (map.modHidden) return !!user && (user.isAdmin || map.authorId === user.id);   // oculto por denuncia
  const privacy = map.privacy || 'public';
  if (map.unrated && !(user && (map.authorId === user.id || user.isAdmin || (Array.isArray(map.collaborators) && map.collaborators.includes(user.id))))) return false;
  if (privacy === 'public') return true;
  if (!user) return false;
  if (map.authorId === user.id || user.isAdmin) return true;
  if (Array.isArray(map.collaborators) && map.collaborators.includes(user.id)) return true;
  if (privacy === 'friends') return (user.friends || []).includes(map.authorId);
  if (privacy === 'assigned') return (map.assignedPlayers || []).includes(user.username);
  return false;
}

// ═══ CONTENIDO +18 ("categoría C") ═══
// Un juego, app o video clasificado como solo para adultos (classification.adult, 18+) solo se abre si la cuenta tiene la edad
// verificada. Hay dos caminos, y el servidor es quien decide (el cliente solo muestra el aviso):
//   1) ageefy.com: estimación de edad por selfie (POST /api/age/start → ageefy → POST /api/age/complete).
//   2) Un admin que te conoce te marca como +18 (POST /api/admin/users/:id/adult). Un admin también puede marcarse a sí mismo.
// user.ageVerified = { method:'ageefy'|'admin', at, verificationId? | by?, byName? }
const AGE_MIN = 18;
const AGEEFY_BASE = String(process.env.AGEEFY_BASE || 'https://www.ageefy.com').replace(/\/+$/, '');
function isAdultContent(rec) { const c = rec && rec.classification; return !!c && (c.adult === true || Number(c.age) >= AGE_MIN); }
function isAgeVerified(user) { const a = user && user.ageVerified; return !!a && (a.method === 'ageefy' || a.method === 'admin'); }
// El autor (y quienes editan el proyecto) siempre pueden abrir lo suyo; todos los demás necesitan la edad verificada.
function canEnterAdult(rec, user) {
  if (!isAdultContent(rec)) return true;
  if (user && (rec.authorId === user.id || (Array.isArray(rec.collaborators) && rec.collaborators.includes(user.id)))) return true;
  return isAgeVerified(user);
}
const AGE_REQUIRED_MSG = 'Este contenido es solo para mayores de 18. Verificá tu edad para entrar.';
function ageRequired(res) { return res.status(403).json({ ok:false, code:'AGE_REQUIRED', err:AGE_REQUIRED_MSG }); }

// ═══ MODO EQUIPO: colaboradores y co-edición en vivo ═══
// map.collaborators = ids de cuentas que pueden editar el proyecto (lo administra solo el creador o un admin).
// Mientras alguien edita en vivo (sesión de equipo), el servidor es la fuente de verdad: aplica cada cambio (parte, script,
// iluminación…) sobre el mapa y lo reenvía al resto; un guardado completo (POST /api/maps) no pisa esos campos.
const MAX_COLLABORATORS = Infinity;
const TEAM_PROTECTED = ['parts', 'scripts', 'lighting', 'settings', 'guis'];
const teamSessions = {};   // mapId → { members: Map(socketId → {userId,username,color,sel}), rev }
function canEditMap(map, user) {
  return !!(map && user && (map.authorId === user.id || user.isAdmin || (Array.isArray(map.collaborators) && map.collaborators.includes(user.id))));
}
function teamChannel(mapId) { return 'team:' + encodeURIComponent(mapId); }
function teamInfo(map) {
  return (map.collaborators || []).map(id => { const u = DB.users[id]; return u ? { id, username:u.username, color:u.color || '#5b8def' } : null; }).filter(Boolean);
}
function teamInSession(mapId, userId) {
  const sess = teamSessions[mapId]; if (!sess) return false;
  for (const m of sess.members.values()) if (m.userId === userId) return true;
  return false;
}
let _lazySaveTimer = null;
function scheduleSave(ms = 1500) { if (_lazySaveTimer) return; _lazySaveTimer = setTimeout(() => { _lazySaveTimer = null; saveDB(); }, ms); _lazySaveTimer.unref?.(); }
function teamLeave(socket) {
  const mapId = socket.data.teamMapId; if (!mapId) return;
  socket.data.teamMapId = null;
  const sess = teamSessions[mapId];
  try { socket.leave(teamChannel(mapId)); } catch {}
  if (!sess) return;
  sess.members.delete(socket.id);
  io.to(teamChannel(mapId)).emit('team_member', { action:'leave', socketId:socket.id });
  if (!sess.members.size) { delete teamSessions[mapId]; saveDB(); io.emit('map_updated', { mapId }); }
}
function rateOk(socket, key, perSec) {
  const rl = socket.data.rl || (socket.data.rl = {}), now = Date.now(), b = rl[key] || (rl[key] = { t:now, n:0 });
  if (now - b.t >= 1000) { b.t = now; b.n = 0; }
  return ++b.n <= perSec;
}
function jsonSize(v, max) { try { const t = JSON.stringify(v); return t !== undefined && t.length <= max ? t.length : -1; } catch { return -1; } }

app.get('/api/maps/:id/team', requireAuth, (req, res) => {
  const map = DB.maps[req.params.id];
  if (!map || !canReadMap(map, req.user)) return res.status(404).json({ ok:false, err:'Proyecto no encontrado' });
  const owner = DB.users[map.authorId];
  res.json({ ok:true, owner: owner ? { id:owner.id, username:owner.username, color:owner.color || '#5b8def' } : { id:map.authorId, username:map.authorName || 'Creador' },
    team: teamInfo(map), canManage: map.authorId === req.user.id || !!req.user.isAdmin, canEdit: canEditMap(map, req.user) });
});
app.post('/api/maps/:id/team', requireAuth, (req, res) => {
  const map = DB.maps[req.params.id];
  if (!map) return res.status(404).json({ ok:false, err:'Proyecto no encontrado' });
  if (map.authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ ok:false, err:'Solo el creador puede administrar el equipo' });
  map.collaborators = Array.isArray(map.collaborators) ? map.collaborators : [];
  const add = typeof req.body?.add === 'string' ? req.body.add.trim().toLowerCase().slice(0, 40) : '';
  const remove = typeof req.body?.remove === 'string' ? req.body.remove.slice(0, 80) : '';
  if (add) {
    const target = Object.values(DB.users).find(u => String(u.username || '').toLowerCase() === add);
    if (!target) return res.status(404).json({ ok:false, err:'No existe una cuenta con ese nombre' });
    if (target.banned) return res.status(400).json({ ok:false, err:'Esa cuenta está suspendida' });
    if (target.id === map.authorId) return res.status(400).json({ ok:false, err:'Esa cuenta ya es la creadora' });
    if (map.collaborators.includes(target.id)) return res.status(400).json({ ok:false, err:'Ya está en el equipo' });
    if (map.collaborators.length >= MAX_COLLABORATORS) return res.status(400).json({ ok:false, err:'El equipo está completo (' + MAX_COLLABORATORS + ')' });
    map.collaborators.push(target.id);
    toUser(target.id).emit('team_invite', { mapId:map.id, mapName:map.name || 'Proyecto', from:req.user.username });
    notifyActivity(target.id, { kind:'game', id:map.id, from:req.user.id, fromName:req.user.username, title:'🤝 ' + req.user.username + ' te sumó a su equipo', body:map.name || 'Proyecto', tag:'team-' + map.id });
  } else if (remove) {
    map.collaborators = map.collaborators.filter(id => id !== remove);
    const sess = teamSessions[map.id];
    if (sess) for (const [sid, m] of sess.members) if (m.userId === remove) {
      io.to(sid).emit('team_kicked', { mapId:map.id });
      const sock = io.sockets.sockets.get(sid); if (sock) teamLeave(sock);
    }
  } else return res.status(400).json({ ok:false, err:'Falta el usuario' });
  saveDB();
  io.emit('map_updated', { mapId:map.id });
  res.json({ ok:true, team: teamInfo(map) });
});
// Estado completo para entrar a editar en vivo (incluye la revisión de la sesión para ordenar los cambios que lleguen después).
app.get('/api/maps/:id/edit-state', requireAuth, (req, res) => {
  const map = DB.maps[req.params.id];
  if (!map || !canEditMap(map, req.user)) return res.status(403).json({ ok:false, err:'No podés editar este proyecto' });
  res.json({ ok:true, rev: teamSessions[map.id]?.rev || 0, map });
});

// ═══ API del servidor para apps y juegos HTML (se usa desde el SDK window.Crix) ═══
const APP_KEY_RE = /^[\w.:-]{1,40}$/;
function appCtx(socket) {
  const meta = connSockets[socket.id]; if (!meta?.mapId) return null;
  const room = rooms[roomKey(meta.mapId, meta.instanceId)]; if (!room || !room.players[socket.id]) return null;
  return { meta, room, map: DB.maps[meta.mapId] };
}
const publicPlayer = p => ({ id:p.userId, socketId:p.socketId, username:p.username, color:p.color, joinedAt:p.joinedAt, isAdult:!!p.isAdult });   // isAdult: solo lo sabe el script/app, nunca cómo se obtuvo
// ── Almacenamiento de videos: archivos en disco (no base64 dentro del JSON de la base) ──
const VIDEO_DIR = persist.VIDEO_DIR;
const VIDEO_EXT = { 'video/mp4':'mp4', 'video/webm':'webm', 'video/ogg':'ogv' };
const MAX_VIDEO_BYTES = LIM.video;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Guarda un stream (la petición HTTP) en disco sin cargarlo en memoria; corta si pasa del límite.
function streamToFile(readable, dest, maxBytes) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest); let n = 0, failed = false;
    const fail = err => { if (failed) return; failed = true; try { readable.unpipe(ws); } catch {} ws.destroy(); try { fs.rmSync(dest, { force:true }); } catch {} reject(err); };
    readable.on('data', c => { n += c.length; if (n > maxBytes) { const e = new Error('El archivo supera el máximo de ' + Math.round(maxBytes / 1048576) + ' MB'); e.code = 'TOO_BIG'; fail(e); } });
    readable.on('error', fail); readable.on('aborted', () => fail(new Error('Subida cancelada')));
    ws.on('error', fail); ws.on('finish', () => { if (!failed) resolve(n); });
    readable.pipe(ws);
  });
}
// Detecta el formato REAL por los primeros bytes (no confía en lo que diga el cliente).
function sniffVideo(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'video/webm';
  if (buf.toString('latin1', 0, 4) === 'OggS') return 'video/ogg';
  const box = buf.toString('latin1', 4, 8);
  if (['ftyp','moov','mdat','free','wide','skip'].includes(box)) return 'video/mp4';  // MP4 / MOV / M4V / 3GP
  return null;
}
// Con varias instancias, el video creado por POST puede estar en otra instancia y aún no haber llegado a esta:
// lo buscamos aquí y, si falta, traemos la base del bucket y reintentamos antes de dar 404.
async function findVideoFresh(id) {
  let v = (DB.videos || []).find(x => x.id === id);
  if (v || !persist.enabled) return v || null;
  for (let i = 0; i < 5 && !v; i++) {
    try { await persist.pullFresh(0, 3000); } catch {}
    v = (DB.videos || []).find(x => x.id === id);
    if (!v) await new Promise(r => setTimeout(r, 800));
  }
  return v || null;
}
async function findVideoReady(id) {   // para reproducir: el registro (con su archivo) puede estar recién subido en otra instancia
  let v = (DB.videos || []).find(x => x.id === id);
  if ((!v || v.ready === false || !v.file) && persist.enabled) {
    for (let i = 0; i < 4; i++) {
      try { await persist.pullFresh(0, 3000); } catch {}
      v = (DB.videos || []).find(x => x.id === id);
      if (v && v.file && v.ready !== false) break;
      await new Promise(r => setTimeout(r, 700));
    }
  }
  return v || null;
}
function videoFilePath(video) { return video && video.file ? path.join(VIDEO_DIR, path.basename(video.file)) : null; }
function storeVideoBuffer(video, buffer) {
  if (!VIDEO_ID_RE.test(String(video.id))) throw new Error('Identificador de video inválido');
  if (buffer.length > MAX_VIDEO_BYTES) throw new Error('El video supera el máximo de ' + Math.round(MAX_VIDEO_BYTES / 1048576) + ' MB');
  const mime = sniffVideo(buffer);
  if (!mime) throw new Error('Formato no soportado. Usá MP4, WebM u OGG.');
  fs.mkdirSync(VIDEO_DIR, { recursive:true });
  const oldPath = videoFilePath(video);
  const file = `${video.id}.${VIDEO_EXT[mime]}`;
  fs.writeFileSync(path.join(VIDEO_DIR, file), buffer);
  if (oldPath && path.basename(oldPath) !== file) { try { fs.unlinkSync(oldPath); } catch {} persist.delKey('videos/' + path.basename(oldPath)); }
  video.file = file; video.mime = mime; video.size = buffer.length; video.ready = true;
  delete video.data;
  return persist.putFile('videos/' + file, path.join(VIDEO_DIR, file));   // promesa: se resuelve cuando la copia llegó al bucket
}
async function videoLocalFile(video) {   // ruta local del video; lo baja del bucket si el disco se reinició
  const f = videoFilePath(video); if (!f) return null;
  return (await persist.ensureLocal('videos/' + path.basename(f), f)) ? f : null;
}
function dataUrlToBuffer(value) {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(String(value || ''));
  return m ? Buffer.from(m[2], 'base64') : null;
}
// Miniatura sensible (declarada por el creador): 0 normal · 1 desnudez parcial · 2 humor tabú en caricatura (parte íntima suelta, o personaje/objeto con esa forma; no es +18 explícito) · 3 genitales descubiertos en un cuerpo o personaje.
// Edad mínima del CONTENIDO para poder llevar cada tipo de miniatura. La miniatura se ve en el catálogo sin que nadie la elija,
// así que su clasificación es independiente de la del video (se puede subir una miniatura que no sale en el video).
const THUMB_MIN_AGE = [0, 16, 16, 18];
const thumbLevelOf = v => { const n = Number(v && v.thumbLevel); return Number.isInteger(n) && n >= 0 && n <= 3 ? n : 0; };
// La API NO decide quién ve qué: solo entrega la etiqueta (thumbLevel + thumbAge) junto a la miniatura. Cada cliente decide cómo tratarla.
// El cliente de Crix la oculta o la difumina según la edad verificada; otros clientes hacen lo suyo.
const thumbLabel = v => { const l = thumbLevelOf(v); return { thumbLevel: l, thumbAge: THUMB_MIN_AGE[l] }; };
function publicVideo(video) {
  const { data, file, ...rest } = video;
  return { ...rest, ...thumbLabel(video), data: video.ready !== false ? '[data]' : null, ready: video.ready !== false, unrated: !video.classification };
}
// Migración: videos viejos guardados como base64 dentro de la base → archivos.
(function migrateVideos() {
  let moved = 0, failed = 0;
  for (const video of DB.videos || []) {
    if (typeof video.data !== 'string' || video.data === '[data]' || video.file) { if (video.file) video.ready = true; continue; }
    try { const buf = dataUrlToBuffer(video.data); if (!buf) throw new Error('sin datos'); storeVideoBuffer(video, buf); moved++; }
    catch (err) { failed++; video.ready = false; delete video.data; console.warn('[VIDEO] No se pudo migrar', video.id, err.message); }
  }
  if (moved || failed) { console.log(`[VIDEO] Migración: ${moved} a archivo, ${failed} inválidos`); saveDB(); }
})();
function userFromToken(token) {
  if (!token) return null;
  const session = DB.sessions[tokenHash(String(token))];
  if (!session || session.expiresAt <= Date.now()) return null;
  const user = DB.users[session.userId];
  return user && !banActive(user) ? user : null;
}

// Igual que los juegos: un video sin clasificar (cuestionario sin completar) es un borrador que solo ven su autor y los admins.
function videoIsPublic(video) { return !!video && !video.modHidden && (video.privacy || 'public') === 'public' && !!video.classification; }
function canReadVideo(video, user) {
  const owner = !!user && (video.authorId === user.id || user.isAdmin);
  if (video.modHidden) return owner;
  if (!video.classification) return owner;
  if ((video.privacy || 'public') === 'public') return true;
  return owner;
}

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) { socket.data.user = null; return next(); }
  let session = DB.sessions[tokenHash(token)];
  if (!session && persist.enabled) { try { await persist.pullFresh(0, 3000); } catch {} session = DB.sessions[tokenHash(token)]; }
  const user = session && session.expiresAt > Date.now() ? DB.users[session.userId] : null;
  if (!user || banActive(user)) return next(new Error('Sesión inválida'));
  socket.data.user = user;
  next();
});

// ══════════════════════════════════════════════
// HTTP — archivos estáticos
// ══════════════════════════════════════════════
app.use((req, res, next) => {
  let requestedPath;
  try { requestedPath = path.resolve(__dirname, '.' + decodeURIComponent(req.path)); }
  catch { return res.sendStatus(404); }
  if (requestedPath === DATA_FILE || requestedPath.startsWith(DATA_FILE + '.')) return res.sendStatus(404);
  next();
});
// Solo se publican los archivos del cliente. Antes se servía el directorio completo
// (server.js, package.json, script-runner.js...).
const PUBLIC_FILES = ['/index.html','/crix-rules-v2.js','/crix-rigid.js','/crix-predict.js','/service-worker.js','/manifest.webmanifest','/crix-icon.svg','/favicon.svg','/favicon-48.png','/crix-avatar.js','/crix-avatar.glb','/GLTFLoader.js','/crix-joints.js','/crix-objects.js','/crix-anim.js','/crix-animator.js','/crix-csg.js','/crix-edit.js','/crix-console.js','/death-scream.mp3','/crix-offline.js','/crix-fx.js','/crix-gfx.js','/crix-ext.js','/crix-native.js','/crix-report.js','/crix-rules.js',
  '/icons/icon-192.png','/icons/icon-512.png','/icons/icon-maskable-512.png','/icons/apple-touch-icon.png','/icons/badge-72.png',
  '/google2fdf198aa054809a.html'];   // verificación de Google Search Console
app.get('/', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'index.html')); });
// Página para probar la API de clasificación desde el navegador (misma dirección que Crix, sin problemas de CORS): /probar-api
app.get('/probar-api', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'probar-api.html')); });   // sin caché: así un deploy nuevo se ve enseguida

// ── Enlaces compartibles ──────────────────────────────────────────────────────────────────────
//   /juego/<id>/<nombre>   /video/<id>/<nombre>   /u/<usuario>
// Sirven la misma app, pero con título y vista previa (Open Graph) del contenido para que al pegar el enlace en
// Discord, WhatsApp, etc. se vea el nombre y la descripción. Solo se revela el título de contenido público; el
// contenido privado muestra una vista previa genérica (el cliente igualmente comprueba los permisos al abrirlo).
const htmlEsc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
let indexCache = { mtime: 0, html: '' };
function readIndexHtml() {
  const file = path.join(__dirname, 'index.html');
  const stat = fs.statSync(file);
  if (stat.mtimeMs !== indexCache.mtime) indexCache = { mtime: stat.mtimeMs, html: fs.readFileSync(file, 'utf8') };
  return indexCache.html;
}
function shareMeta(kind, key) {
  const fallback = { title: 'Crix — Plataforma de Juegos', desc: 'Juega, crea y comparte juegos y videos en Crix.' };
  try {
    if (kind === 'juego') {
      const map = DB.maps[key];
      if (mapIsPublic(map)) return { title: `${map.name || 'Juego'} — Crix`, desc: String(map.desc || `Juega a ${map.name || 'este juego'} en Crix`).slice(0, 200) };
    } else if (kind === 'video') {
      const video = (DB.videos || []).find(item => item.id === key);
      if (video && (video.privacy || 'public') === 'public' && video.ready !== false) return { title: `${video.title || 'Video'} — Crix`, desc: String(video.desc || video.description || `Mira este video de ${video.authorName || 'Crix'} en Crix`).slice(0, 200) };
    } else if (kind === 'u') {
      const user = Object.values(DB.users).find(item => String(item.username || '').toLowerCase() === key.toLowerCase());
      if (user && !user.banned) return { title: `${user.username} en Crix`, desc: String(user.bio || `Perfil de ${user.username} en Crix`).slice(0, 200) };
    }
  } catch (_) {}
  return fallback;
}
function sharePage(kind) {
  return (req, res) => {
    const key = String(req.params.id || req.params.username || '').slice(0, 200);
    const meta = shareMeta(kind, key);
    const origin = `${req.protocol}://${req.get('host')}`;
    const url = origin + req.originalUrl.split('?')[0];
    const tags = [
      `<meta property="og:site_name" content="Crix">`, `<meta property="og:type" content="website">`,
      `<meta property="og:title" content="${htmlEsc(meta.title)}">`, `<meta property="og:description" content="${htmlEsc(meta.desc)}">`,
      `<meta property="og:url" content="${htmlEsc(url)}">`, `<meta property="og:image" content="${htmlEsc(origin + '/icons/icon-512.png')}">`,
      `<meta name="twitter:card" content="summary">`, `<meta name="description" content="${htmlEsc(meta.desc)}">`,
      `<link rel="canonical" href="${htmlEsc(url)}">`,
      `<script>window.__CRIX_ROUTE__=${JSON.stringify({ kind, key }).replace(/</g, '\\u003c')};</script>`,
    ].join('\n');
    let html = readIndexHtml().replace(/<title>[\s\S]*?<\/title>/, () => `<title>${htmlEsc(meta.title)}</title>`).replace('</head>', () => tags + '\n</head>');
    const gm = kind === 'juego' ? publicMapForShortcut(key) : null;
    if (gm) {
      const gid = encodeURIComponent(key);
      html = html.replace('<link rel="manifest" href="/manifest.webmanifest">', () => `<link rel="manifest" href="/juego/${gid}/manifest.webmanifest">`)
        .replace('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">', () => `<link rel="apple-touch-icon" href="/juego/${gid}/icon.png?v=${gameIconVersion(gm)}">`)
        .replace('<meta name="apple-mobile-web-app-title" content="Crix">', () => `<meta name="apple-mobile-web-app-title" content="${htmlEsc(String(gm.name || 'Juego').slice(0, 30))}">`);
    }
    res.set('Cache-Control', 'no-cache').type('html').send(html);
  };
}
// ── Acceso directo de un juego: manifiesto + ícono propios (ícono elegido por el creador; si no, la miniatura) ──
const ICON_DATA_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/;
const okIconData = v => typeof v === 'string' && v.length <= 600000 && ICON_DATA_RE.test(v);
function publicMapForShortcut(id) { const m = DB.maps[String(id || '')]; return mapIsPublic(m) ? m : null; }
function gameIconSource(map) { return okIconData(map?.icon) ? map.icon : (typeof map?.thumb === 'string' && ![1, 3].includes(thumbLevelOf(map)) && map.thumb.length <= 2000000 && ICON_DATA_RE.test(map.thumb) ? map.thumb : null); }
function gameIconVersion(map) { const src = gameIconSource(map); return src ? crypto.createHash('sha1').update(src).digest('hex').slice(0, 10) : '0'; }
app.get('/juego/:id/icon.png', (req, res) => {
  const map = publicMapForShortcut(req.params.id), src = map && gameIconSource(map), m = src && ICON_DATA_RE.exec(src);
  if (!m) return res.set('Cache-Control', 'public, max-age=300').sendFile(path.join(__dirname, 'icons', 'icon-512.png'));
  res.set({ 'Content-Type': m[1], 'Cache-Control': 'public, max-age=3600' }).send(Buffer.from(m[2], 'base64'));
});
app.get('/juego/:id/manifest.webmanifest', (req, res) => {
  const map = publicMapForShortcut(req.params.id), id = encodeURIComponent(String(req.params.id || '').slice(0, 120));
  const name = String(map?.name || 'Juego de Crix').slice(0, 60);
  const src = map && gameIconSource(map), type = (src && ICON_DATA_RE.exec(src)?.[1]) || 'image/png';
  const icon = map && src ? `/juego/${id}/icon.png?v=${gameIconVersion(map)}` : '/icons/icon-512.png';
  res.set({ 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' }).send(JSON.stringify({
    id: `/juego/${id}`, name, short_name: name.slice(0, 12), description: String(map?.desc || `Jugá ${name} en Crix`).slice(0, 200), lang: 'es',
    start_url: `/juego/${id}?pwa=1`, scope: '/', display: 'standalone', orientation: 'any', background_color: '#07112a', theme_color: '#07112a',
    categories: ['games'], icons: [{ src: icon, sizes: '192x192', type, purpose: 'any' }, { src: icon, sizes: '512x512', type, purpose: 'any' }],
  }));
});
app.get(['/juego/:id', '/juego/:id/:slug'], sharePage('juego'));
app.get(['/video/:id', '/video/:id/:slug'], sharePage('video'));
app.get('/u/:username', sharePage('u'));
// Rapier para el navegador: el paquete npm es CommonJS con el .wasm incrustado; se envuelve para exponerlo como window.CrixRapierLib.
let rapierBrowserBundle = null, rapierBrowserGzip = null;
app.get('/crix-rapier.js', (req, res) => {
  try {
    if (!rapierBrowserBundle) {
      const file = require.resolve('@dimforge/rapier3d-compat');
      rapierBrowserBundle = '(function(){var module={exports:{}},exports=module.exports;\n' + fs.readFileSync(file, 'utf8') + '\n;self.CrixRapierLib=module.exports.default||module.exports;})();';
    }
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=604800, immutable', 'Vary': 'Accept-Encoding' });
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {   // 4,3 MB → ~1,2 MB; se comprime una sola vez
      if (!rapierBrowserGzip) rapierBrowserGzip = require('zlib').gzipSync(rapierBrowserBundle, { level: 9 });
      res.set('Content-Encoding', 'gzip'); return res.send(rapierBrowserGzip);
    }
    res.send(rapierBrowserBundle);
  } catch (err) { res.status(404).type('text/plain').send('Rapier no instalado'); }
});
app.get(PUBLIC_FILES, (req, res) => {
  // El service worker y el manifiesto no deben quedar en caché para que las actualizaciones lleguen rápido.
  if (req.path === '/service-worker.js' || req.path === '/manifest.webmanifest') res.set('Cache-Control', 'no-cache');
  if (req.path === '/service-worker.js') res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, req.path));
});

// ── Límite de intentos de acceso por IP ──
const authAttempts = new Map();
function authLimited(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || 'x';
  const now = Date.now(), entry = authAttempts.get(ip) || { count:0, first:now };
  if (now - entry.first > 10 * 60 * 1000) { entry.count = 0; entry.first = now; }
  entry.count++; authAttempts.set(ip, entry);
  if (entry.count > 30) { res.status(429).json({ ok:false, err:'Demasiados intentos. Esperá unos minutos.' }); return true; }
  return false;
}
setInterval(() => { const now = Date.now(); for (const [ip, e] of authAttempts) if (now - e.first > 10 * 60 * 1000) authAttempts.delete(ip); }, 60 * 1000);

// ── REGISTER ──
app.post('/api/register', (req, res) => {
  if (authLimited(req, res)) return;
  try {
    const { username, pw, color } = req.body;
    if (!username || !pw) return res.json({ ok:false, err:'Faltan campos' });
    if (typeof username !== 'string' || typeof pw !== 'string')
      return res.status(400).json({ ok:false, err:'Datos de acceso inválidos' });
    if (username.length < 3 || username.length > 24 || !/^[a-zA-Z0-9_]+$/.test(username))
      return res.status(400).json({ ok:false, err:'Nombre inválido' });
    if (pw.length < 6 || pw.length > 128)
      return res.status(400).json({ ok:false, err:'La contraseña debe tener entre 6 y 128 caracteres' });
    const dup = Object.values(DB.users).find(u =>
      u.username.toLowerCase() === username.toLowerCase()
    );
    if (dup) return res.json({ ok:false, err:'Ese nombre ya existe' });
    const isCrix = username.toLowerCase() === 'crix';
    const adminPassword = process.env.CRIX_ADMIN_PASSWORD;
    if (isCrix && !adminPassword)
      return res.status(503).json({ ok:false, err:'La cuenta Crix aún no está configurada por el administrador del servidor' });
    if (isCrix && pw !== adminPassword)
      return res.status(403).json({ ok:false, err:'La contraseña de administración no coincide' });
    const uid = `u${crypto.randomUUID()}`;
    const user = {
      id: uid, username, pw: hashPassword(pw), color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#5b8def',
      created: new Date().toISOString(),
      friends:[], games:[], visits:0, bio:'',
      following:[], liked:[], isAdmin: false,
    };
    if (isCrix) user.isAdmin = true;
    user.rulesAccepted = require('./rules').RULES_VERSION; user.rulesAcceptedAt = user.created;
    DB.users[uid] = user;
    const token = issueSession(user);
    log('REGISTER', username);
    io.emit('user_new', { userId: uid, username, color: user.color });
    res.json({ ok:true, user: safeUser(user), token });
  } catch(e) { res.json({ ok:false, err:e.message }); }
});

// ── LOGIN ──
app.post('/api/login', (req, res) => {
  if (authLimited(req, res)) return;
  try {
    const { username, pw } = req.body;
    if (!username || !pw) return res.json({ ok:false, err:'Faltan campos' });
    if (typeof username !== 'string' || typeof pw !== 'string' || pw.length > 128)
      return res.status(400).json({ ok:false, err:'Datos de acceso inválidos' });
    const user = Object.values(DB.users).find(u =>
      u.username.toLowerCase() === username.toLowerCase()
    );
    if (!user) return res.json({ ok:false, err:'Usuario no encontrado' });
    const isConfiguredCrix = user.username.toLowerCase() === 'crix' && process.env.CRIX_ADMIN_PASSWORD && pw === process.env.CRIX_ADMIN_PASSWORD;
    if (!verifyPassword(pw, user.pw) && !isConfiguredCrix) return res.json({ ok:false, err:'Contraseña incorrecta' });
    if (isConfiguredCrix) { user.pw = hashPassword(pw); user.isAdmin = true; }
    else if (user.username.toLowerCase() === 'crix') user.isAdmin = false;
    if (!String(user.pw).startsWith('scrypt$')) user.pw = hashPassword(pw);
    // Verificar ban
    if (user.banned) {
      const perm  = user.banned.permanent;
      const until = user.banned.until ? new Date(user.banned.until) : null;
      if (perm || (until && until > new Date())) {
        return res.json({ ok:false, banned: user.banned, appealToken: issueAppealToken(user), appealMail: hasMail(user) ? maskEmail(user.mail.address) : '' });
      }
      delete user.banned; saveDB();
    }
    log('LOGIN', username);
    res.json({ ok:true, user: safeUser(user), token: issueSession(user) });
  } catch(e) { res.json({ ok:false, err:e.message }); }
});


// ── Acceso con Google ──
// Se activa definiendo GOOGLE_CLIENT_ID (ID de cliente OAuth "Web" de Google Cloud). Sin esa variable el botón no aparece.
app.get('/api/config', (req, res) => res.json({ ok:true, googleClientId: process.env.GOOGLE_CLIENT_ID || '' }));
function uniqueUsername(base) {
  let name = String(base || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 18);
  if (name.length < 3) name = 'user' + name;
  if (name.toLowerCase() === 'crix') name = 'crix_user';
  const taken = n => Object.values(DB.users).some(u => u.username.toLowerCase() === n.toLowerCase());
  let candidate = name;
  while (taken(candidate)) candidate = name + Math.floor(1000 + Math.random() * 9000);
  return candidate;
}
app.post('/api/google', async (req, res) => {
  if (authLimited(req, res)) return;
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(503).json({ ok:false, err:'El acceso con Google no está configurado en este servidor' });
    const credential = req.body && req.body.credential;
    if (typeof credential !== 'string' || credential.length < 20 || credential.length > 4096)
      return res.status(400).json({ ok:false, err:'Credencial de Google inválida' });
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), { signal: AbortSignal.timeout(8000) });
    const info = await r.json().catch(() => ({}));
    const issuerOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
    if (!r.ok || info.aud !== clientId || !issuerOk || !info.sub || Number(info.exp) * 1000 < Date.now() || String(info.email_verified) !== 'true')
      return res.status(401).json({ ok:false, err:'No se pudo verificar tu cuenta de Google' });
    let user = Object.values(DB.users).find(u => u.googleSub === info.sub);
    let isNew = false;
    if (!user) {
      isNew = true;
      const uid = `u${crypto.randomUUID()}`;
      const username = uniqueUsername(info.given_name || info.name || String(info.email || '').split('@')[0]);
      const palette = ['#5b8def', '#8b5cf6', '#ec4899', '#22d3a6', '#f59e0b', '#ef4444', '#f97316', '#38bdf8'];
      user = {
        id: uid, username, pw: hashPassword(crypto.randomBytes(32).toString('hex')),   // sin contraseña utilizable: entra solo con Google
        color: palette[Math.floor(Math.random() * palette.length)], created: new Date().toISOString(),
        friends:[], games:[], visits:0, bio:'', following:[], liked:[], isAdmin:false, googleSub: info.sub,
      };
      DB.users[uid] = user;
      io.emit('user_new', { userId: uid, username, color: user.color });
    }
    if (user.banned) {
      const until = user.banned.until ? new Date(user.banned.until) : null;
      if (user.banned.permanent || (until && until > new Date())) return res.status(403).json({ ok:false, err:'Esta cuenta está suspendida.', banned: user.banned, appealToken: issueAppealToken(user), appealMail: hasMail(user) ? maskEmail(user.mail.address) : '' });
      delete user.banned; saveDB();
    }
    log('GOOGLE', user.username);
    res.json({ ok:true, user: safeUser(user), token: issueSession(user), isNew });
  } catch (e) { res.status(500).json({ ok:false, err:'No se pudo iniciar sesión con Google' }); }
});

app.get('/api/session', requireAuth, (req, res) => res.json({ ok:true, user:safeUser(req.user) }));

// ── Preferencias de la cuenta (idioma, difuminado de miniaturas, sonido, etc.) ──
// Se guardan en la cuenta (`user.prefs`) para que acompañen a la persona en cualquier dispositivo. Solo las ve su dueña
// (safeUser las incluye; publicUser no). Cada clave tiene su validación; lo que no se reconoce se ignora. `null` borra la clave.
const PREF_RULES = {
  crix_lang:          v => ['es','en','pt','fr','de','it'].includes(v) ? v : null,
  crix_thumb_blur_on: v => (v === '0' || v === '1') ? v : null,
  crix_thumb_blur_px: v => { const n = parseInt(v, 10); return n >= 2 && n <= 60 ? String(n) : null; },
  crix_thumb_filter:  v => ['strict','medium','off'].includes(v) ? v : null,
  crix_sound:         v => (v === 'on' || v === 'off') ? v : null,
  crix_nav_hidden:    v => (v === '0' || v === '1') ? v : null,
  crix_country:       v => /^[A-Z_]{2,10}$/.test(v) ? v : null,
};
// ── Accesorios de avatar ──
// Los crea la gente (formas + un modelo .glb opcional), los ubica sobre el personaje y los sube "solo para mí" (private) o "para todos"
// (public: aparecen en el catálogo y cualquiera puede usarlos). Se llevan puestos con look.equip (ver CrixAvatar.sanitizeLook), así que
// los ven todos los jugadores aunque el accesorio sea privado: lo privado solo significa que no figura en el catálogo de los demás.
// La definición vive en DB.accessories (se sincroniza como el resto); el modelo, en un archivo (+ copia en el bucket).
const ACC_ID_PARAM = /^ac_[a-z0-9]{6,24}$/;
const ACC_PER_USER = 40, ACC_MODELS_PER_USER = 5;
const ACC_MODEL_MAX = Math.round((Number(process.env.CRIX_MAX_ACC_MODEL_MB) || 1.5) * 1048576);
const accModelPath = id => path.join(persist.ACC_DIR, id + '.glb');
const accView = a => ({ id:a.id, name:a.name, authorId:a.authorId, authorName:a.authorName, scope:a.scope, parts:a.parts, hasModel:!!a.hasModel, allowDownload:a.allowDownload === true, createdAt:a.createdAt, updatedAt:a.updatedAt });
// Un .glb válido y autocontenido: sin enlaces externos (evita rastreo/filtrado de IP) ni extensiones que el visor no soporta (Draco, KTX…).
function validateGlb(buf) {
  if (!buf || buf.length < 24) return 'El archivo del modelo está vacío';
  if (buf.length > ACC_MODEL_MAX) return 'El modelo supera ' + (ACC_MODEL_MAX / 1048576).toFixed(1).replace(/\.0$/, '') + ' MB';
  if (buf.readUInt32LE(0) !== 0x46546C67 || buf.readUInt32LE(4) !== 2) return 'Solo se aceptan modelos .glb (glTF 2.0)';
  if (buf.readUInt32LE(8) !== buf.length) return 'El archivo .glb está dañado';
  const jl = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4E4F534A || jl < 2 || 20 + jl > buf.length) return 'El archivo .glb está dañado';
  let j; try { j = JSON.parse(buf.slice(20, 20 + jl).toString('utf8')); } catch { return 'El archivo .glb está dañado'; }
  const external = u => typeof u === 'string' && !/^data:/i.test(u);
  if ((j.buffers || []).some(b => b && external(b.uri)) || (j.images || []).some(i => i && external(i.uri))) return 'El modelo debe traer todo incluido (sin enlaces externos)';
  if (Array.isArray(j.extensionsRequired) && j.extensionsRequired.length) return 'El modelo usa extensiones no soportadas (' + j.extensionsRequired.slice(0, 3).join(', ') + ')';
  return null;
}
app.get('/api/accessories', (req, res) => {
  const user = readSession(req), all = Object.values(DB.accessories || {}).filter(a => a && a.id);
  const mine = user ? all.filter(a => a.authorId === user.id).sort((a, b) => b.createdAt - a.createdAt) : [];
  const pub = all.filter(a => a.scope === 'public' && !a.modHidden && (!user || a.authorId !== user.id)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  res.set('Cache-Control', 'no-store'); res.json({ ok:true, mine:mine.map(accView), pub:pub.map(accView) });
});
app.get('/api/accessories/:id', (req, res) => {
  const a = ACC_ID_PARAM.test(req.params.id) && DB.accessories && DB.accessories[req.params.id];
  if (!a || (a.modHidden && !(readSession(req) && (readSession(req).isAdmin || readSession(req).id === a.authorId)))) return res.status(404).json({ ok:false, err:'Accesorio no encontrado' });
  res.set('Cache-Control', 'no-cache'); res.json({ ok:true, accessory:accView(a) });
});
app.get('/api/accessories/:id/model', async (req, res) => {
  const a = ACC_ID_PARAM.test(req.params.id) && DB.accessories && DB.accessories[req.params.id];
  if (!a || !a.hasModel) return res.status(404).end();
  const file = (fs.existsSync(accModelPath(a.id)) ? accModelPath(a.id) : null) || await persist.fetchAccModel(a.id); if (!file) return res.status(404).end();
  res.set({ 'Content-Type':'model/gltf-binary', 'X-Content-Type-Options':'nosniff', 'Cache-Control':'no-cache' });
  res.sendFile(file, { dotfiles:'allow' }, err => { if (err && !res.headersSent) res.status(err.status || 500).end(); });
});
app.get('/api/accessories/:id/offline-pack', (req, res) => {
  const a = ACC_ID_PARAM.test(req.params.id) && DB.accessories && DB.accessories[req.params.id], viewer = readSession(req) || userFromToken(req.query.t);
  if (!a) return res.status(404).json({ ok:false, err:'Accesorio no encontrado' });
  if (!(a.scope === 'public' || (viewer && (viewer.id === a.authorId || viewer.isAdmin)))) return res.status(404).json({ ok:false, err:'Accesorio no encontrado' });
  if (!mayDownload(a, viewer)) return res.status(403).json({ ok:false, code:'DOWNLOAD_NOT_ALLOWED', err:'Su creador no permitió descargar esta creación' });
  res.json({ ok:true, accessory:accView(a), modelUrl:a.hasModel ? `/api/accessories/${encodeURIComponent(a.id)}/model` : null });
});
app.post('/api/accessories', requireAuth, async (req, res) => {
  try {
    const b = req.body || {}, def = CrixAvatar.sanitizeAccessoryDef(b);
    if (!def) return res.status(400).json({ ok:false, err:'El accesorio necesita al menos una pieza' });
    if (!DB.accessories) DB.accessories = {};
    const own = Object.values(DB.accessories).filter(a => a.authorId === req.user.id);
    let rec = null;
    if (b.id) {
      rec = ACC_ID_PARAM.test(String(b.id)) ? DB.accessories[String(b.id)] : null;
      if (!rec) return res.status(404).json({ ok:false, err:'Accesorio no encontrado' });
      if (rec.authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ ok:false, err:'No podés editar este accesorio' });
    } else if (own.length >= ACC_PER_USER) return res.status(400).json({ ok:false, err:`Llegaste al máximo de ${ACC_PER_USER} accesorios. Borrá alguno para crear otro.` });
    let buf = null;
    if (typeof b.model === 'string' && b.model) {
      buf = Buffer.from(b.model, 'base64');
      const bad = validateGlb(buf); if (bad) return res.status(400).json({ ok:false, err:bad });
    }
    const wantsModel = def.parts.some(p => p.shape === 'model');
    if (wantsModel && !buf && !(rec && rec.hasModel)) { def.parts = def.parts.filter(p => p.shape !== 'model'); if (!def.parts.length) return res.status(400).json({ ok:false, err:'Falta el archivo del modelo' }); }
    if (buf && !(rec && rec.hasModel) && own.filter(a => a.hasModel).length >= ACC_MODELS_PER_USER) return res.status(400).json({ ok:false, err:`Podés tener hasta ${ACC_MODELS_PER_USER} accesorios con modelo importado.` });
    const now = Date.now(), id = rec ? rec.id : 'ac_' + crypto.randomBytes(8).toString('hex'), keepsModel = def.parts.some(p => p.shape === 'model');
    if (buf && keepsModel) {
      fs.mkdirSync(persist.ACC_DIR, { recursive:true });
      const tmp = accModelPath(id) + '.' + process.pid + '.part'; fs.writeFileSync(tmp, buf); fs.renameSync(tmp, accModelPath(id));
      await settleUpload(persist.putFile(`accessories/${id}.glb`, accModelPath(id)));
    } else if (!keepsModel && rec && rec.hasModel) { try { fs.rmSync(accModelPath(id), { force:true }); } catch {} persist.delKey(`accessories/${id}.glb`); }
    const next = { id, name:def.name, authorId:rec ? rec.authorId : req.user.id, authorName:rec ? rec.authorName : req.user.username, scope:b.scope === 'public' ? 'public' : 'private',
      parts:def.parts, hasModel:keepsModel && (!!buf || !!(rec && rec.hasModel)), allowDownload:b.allowDownload === undefined ? !!(rec && rec.allowDownload) : b.allowDownload === true, createdAt:rec ? rec.createdAt : now, updatedAt:now };
    DB.accessories[id] = next; saveDB();
    if (rec) io.emit('accessory_updated', { id });
    res.json({ ok:true, accessory:accView(next) });
  } catch (e) { res.status(500).json({ ok:false, err:'No se pudo guardar el accesorio' }); }
});
app.delete('/api/accessories/:id', requireAuth, (req, res) => {
  const a = ACC_ID_PARAM.test(req.params.id) && DB.accessories && DB.accessories[req.params.id];
  if (!a) return res.status(404).json({ ok:false, err:'Accesorio no encontrado' });
  if (a.authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ ok:false, err:'No podés borrar este accesorio' });
  delete DB.accessories[a.id];
  try { fs.rmSync(accModelPath(a.id), { force:true }); } catch {} persist.delKey(`accessories/${a.id}.glb`);
  saveDB(); io.emit('accessory_updated', { id:a.id }); res.json({ ok:true });
});

app.put('/api/prefs', requireAuth, (req, res) => {
  const input = req.body && req.body.prefs;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return res.status(400).json({ ok:false, err:'Preferencias inválidas' });
  const prefs = { ...(req.user.prefs || {}) };
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(PREF_RULES, key)) continue;
    if (input[key] === null) { delete prefs[key]; continue; }
    const value = PREF_RULES[key](String(input[key]));
    if (value !== null) prefs[key] = value;
  }
  req.user.prefs = prefs;
  saveDB();
  res.json({ ok:true, prefs });
});
app.post('/api/logout', requireAuth, (req, res) => {
  const token = (req.get('authorization') || '').slice(7);
  delete DB.sessions[tokenHash(token)];
  saveDB();
  res.json({ ok:true });
});

// ── Traspaso de una llamada entrante a Safari (iPhone con la app instalada) ──
// La app instalada (PWA) no puede mantener el micrófono en segundo plano en iOS; Safari sí (con la ventana flotante).
// La app pide un código de un solo uso mientras suena la llamada, abre Safari con ese código en el fragmento (#), y
// Safari lo canjea por una sesión propia. El código vive en memoria, vence a los 60 s y solo se emite con una llamada sonando.
const handoffs = new Map();   // hash del código → { userId, peerId, expiresAt }
const HANDOFF_TTL_MS = 60000;
function handoffLive(userId) {
  const now = Date.now();
  for (const [k, v] of handoffs) { if (v.expiresAt <= now) handoffs.delete(k); else if (v.userId === userId) return true; }
  return false;
}
app.post('/api/handoff', requireAuth, (req, res) => {
  const c = calls.get(req.user.id);
  if (!c || c.caller || c.accepted) return res.status(409).json({ ok:false, err:'No hay una llamada entrante para pasar a Safari' });
  let live = 0; for (const v of handoffs.values()) if (v.userId === req.user.id && v.expiresAt > Date.now()) live++;
  if (live >= 3) return res.status(429).json({ ok:false, err:'Demasiados códigos activos' });
  const token = crypto.randomBytes(32).toString('base64url');
  handoffs.set(tokenHash(token), { userId: req.user.id, peerId: c.peer, expiresAt: Date.now() + HANDOFF_TTL_MS });
  res.json({ ok:true, token, ttl: HANDOFF_TTL_MS });
});
app.post('/api/handoff/redeem', (req, res) => {
  if (authLimited(req, res)) return;
  const token = typeof req.body?.token === 'string' ? req.body.token.slice(0, 200) : '';
  const key = tokenHash(token), h = token ? handoffs.get(key) : null;
  if (h) handoffs.delete(key);   // un solo uso
  if (!h || h.expiresAt <= Date.now()) return res.status(410).json({ ok:false, err:'El enlace venció. Volvé a intentarlo desde la llamada.' });
  const user = DB.users[h.userId];
  if (!user || banActive(user)) return res.status(403).json({ ok:false, err:'Cuenta no disponible' });
  log('HANDOFF', user.username);
  res.json({ ok:true, user: safeUser(user), token: issueSession(user), peerId: h.peerId });
});

// ── GET usuario ──
app.get('/api/user/:id', (req, res) => {
  const u = DB.users[req.params.id];
  if (!u) return res.json({ ok:false, err:'No encontrado' });
  res.json({ ok:true, user: readSession(req)?.id === u.id ? safeUser(u) : publicUser(u) });
});

// ── UPDATE usuario ──
app.post('/api/user/:id', (req, res) => {
  try {
    const actor = readSession(req);
    if (!actor) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
    if (actor.id !== req.params.id && !actor.isAdmin)
      return res.status(403).json({ ok:false, err:'No podés editar esta cuenta' });
    const u = DB.users[req.params.id];
    if (!u) return res.json({ ok:false });
    if (req.body.avatar !== undefined && req.body.avatar !== '' &&
        (typeof req.body.avatar !== 'string' || req.body.avatar.length > 180000 ||
         !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(req.body.avatar)))
      return res.status(400).json({ ok:false, err:'La foto debe ser JPG, PNG o WebP y no superar el límite permitido' });
    if (req.body.look !== undefined) {
      if (req.body.look === null) delete u.look;
      else if (typeof req.body.look !== 'object' || JSON.stringify(req.body.look).length > 1200) return res.status(400).json({ ok:false, err:'Aspecto de avatar inválido' });
      else u.look = CrixAvatar.profileLook(req.body.look);   // sin expresión ni tamaño: eso lo hacen solo las animaciones
    }
    const allowed = ['bio','color','games','visits','following','liked','onlineAt','avatar'];
    // Solo un admin pone/quita bans. Poner: objeto. Quitar: banned:null (o false). Antes un cuerpo SIN 'banned' (lo que mandaba
    // "Desbanear" tras hacer delete u.banned) se ignoraba, y el ban seguía en el servidor y volvía en la próxima sincronización.
    let unbanned = false;
    if (actor.isAdmin && req.body.banned && typeof req.body.banned === 'object') allowed.push('banned');
    else if (actor.isAdmin && 'banned' in req.body && !req.body.banned && u.banned) { delete u.banned; unbanned = true; }
    const followedBefore = new Set(Array.isArray(u.following) ? u.following : []);
    allowed.forEach(k => { if (req.body[k] !== undefined) u[k] = req.body[k]; });
    if (actor.id === u.id && Array.isArray(u.following))
      for (const fid of u.following) if (!followedBefore.has(fid) && DB.users[fid]) notifyActivity(fid, { kind:'user', id:u.id, from:u.id, fromName:u.username, title:'👤 ' + u.username + ' te sigue ahora', body:'Tenés un seguidor nuevo', tag:'follow-' + u.id });
    if (actor.isAdmin && req.body.isAdmin !== undefined) {
      // Quitar el admin solo se hace por /api/admin/users/:id/remove-admin (con sus reglas); aquí únicamente se concede.
      if (req.body.isAdmin && !u.isAdmin) { u.isAdmin = true; u.adminGrantedBy = actor.id; }
    }
    DB.users[req.params.id] = u;
    saveDB();
    if (actor.isAdmin && req.body.banned && typeof req.body.banned === 'object') notifyActivity(u.id, { kind:'home', id:'ban', title:'🚫 Tu cuenta fue suspendida', body:clip(req.body.banned.reason || 'Revisá las normas de Crix.'), tag:'ban' });
    if (unbanned) notifyActivity(u.id, { kind:'home', id:'unban', title:'✅ Tu cuenta fue reactivada', body:'Ya podés volver a usar Crix.', tag:'ban' });
    if (unbanned) { log('UNBAN', req.params.id); const t = onlineUsers[req.params.id]; if (t) io.to(t.socketId).emit('you_are_unbanned'); }
    io.emit('user_updated', { userId: req.params.id });
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, err:e.message }); }
});

// ═══ QUITAR ADMIN ═══
// La cuenta principal "crix" es la dueña: nadie puede quitarle el admin, y solo ella puede quitárselo a otra persona.
// Cualquier admin puede renunciar a su propio rol. El cambio se guarda en el servidor (no solo en el navegador).
const isOwnerAccount = u => !!u && String(u.username || '').toLowerCase() === 'crix';
app.post('/api/admin/users/:id/remove-admin', requireAuth, requireAdmin, (req, res) => {
  const target = DB.users[req.params.id];
  if (!target) return res.status(404).json({ ok:false, err:'Usuario no encontrado' });
  if (!target.isAdmin) return res.json({ ok:true, already:true });
  if (isOwnerAccount(target)) return res.status(403).json({ ok:false, err:'La cuenta principal de Crix no puede dejar de ser admin' });
  const self = target.id === req.user.id;
  if (!self && !isOwnerAccount(req.user)) return res.status(403).json({ ok:false, err:'Solo la cuenta principal de Crix puede quitarle el admin a otra persona' });
  target.isAdmin = false;
  delete target.adminGrantedBy;
  DB.users[target.id] = target;
  saveDB();
  io.emit('user_updated', { userId:target.id });
  if (!self) notifyActivity(target.id, { kind:'home', id:'admin', title:'⛔ Se quitó tu rol de admin', body:'Ya no tenés permisos de administración en Crix.', tag:'admin-role' });
  console.log(`[ADMIN] ${req.user.username} ${self ? 'renunció al rol de admin' : 'quitó el admin a ' + target.username}`);
  res.json({ ok:true });
});

// ═══ VERIFICACIÓN DE EDAD (+18) ═══
// Camino 1 · ageefy.com (https://www.ageefy.com/docs). El servidor crea la sesión, manda a la persona a ageefy y, cuando vuelve,
// CONSULTA el resultado él mismo (POST /api/verification/check). Nunca se confía en lo que diga el navegador ni en el webhook
// (ageefy no lo firma): la sesión tiene que ser la que esta cuenta abrió, haber terminado y con edad estimada >= 18.
function publicOrigin(req) {
  const fixed = String(process.env.CRIX_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(fixed)) return fixed;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return proto + '://' + req.get('host');
}
const ageefyPost = (route, body) => fetchJson(AGEEFY_BASE + route, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) }, 10000);
const AGEEFY_HOST_RE = /(^|\.)ageefy\.(com|app)$/i;
const AGE_START_COOLDOWN_MS = 15 * 1000, AGE_SESSION_TTL_MS = 24 * 3600 * 1000;

app.get('/api/age/status', requireAuth, (req, res) => {
  res.json({ ok:true, verified:isAgeVerified(req.user), pending:!!req.user.ageCheck });
});

app.post('/api/age/start', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    if (isAgeVerified(user)) return res.json({ ok:true, verified:true });
    if (user.ageCheck && Date.now() - (user.ageCheck.startedAt || 0) < AGE_START_COOLDOWN_MS)
      return res.status(429).json({ ok:false, err:'Esperá unos segundos antes de reintentar.' });
    const created = await ageefyPost('/api/verification/new', {
      internalId: user.id,
      redirectUrl: publicOrigin(req) + '/?age=done&id=%verificationId%',
      ip: classification.clientIp(req) || '0.0.0.0',
      minAge: AGE_MIN,
    });
    let url; try { url = new URL(String(created?.verificationUrl || '')); } catch { url = null; }
    if (!created?.id || !url || url.protocol !== 'https:' || !AGEEFY_HOST_RE.test(url.hostname))
      return res.status(502).json({ ok:false, err:'ageefy devolvió una respuesta inválida. Probá de nuevo más tarde.' });
    user.ageCheck = { id:String(created.id), startedAt:Date.now() };
    saveDB();
    res.json({ ok:true, verified:false, url:url.href });
  } catch (e) { res.status(502).json({ ok:false, err:'No se pudo conectar con ageefy. Probá de nuevo más tarde.' }); }
});

app.post('/api/age/complete', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    if (isAgeVerified(user)) return res.json({ ok:true, verified:true });
    const pending = user.ageCheck;
    if (!pending?.id) return res.status(409).json({ ok:false, code:'AGE_NO_SESSION', err:'No hay una verificación en curso. Empezá una nueva.' });
    const id = String(req.body?.id || pending.id);
    if (id !== pending.id) return res.status(403).json({ ok:false, code:'AGE_SESSION_MISMATCH', err:'Esa verificación no es de tu cuenta.' });
    if (Date.now() - (pending.startedAt || 0) > AGE_SESSION_TTL_MS) { delete user.ageCheck; saveDB(); return res.status(410).json({ ok:false, code:'AGE_SESSION_EXPIRED', err:'La verificación venció. Empezá una nueva.' }); }
    let r; try { r = await ageefyPost('/api/verification/check', { id }); } catch { return res.status(502).json({ ok:false, err:'No se pudo consultar a ageefy. Probá de nuevo en un momento.' }); }
    if (!r || String(r.id) !== id || String(r.internalId) !== String(user.id))
      return res.status(403).json({ ok:false, code:'AGE_SESSION_MISMATCH', err:'Esa verificación no es de tu cuenta.' });
    if (r.status !== 'completed' || !Number.isFinite(Number(r.detectedAge)))
      return res.json({ ok:true, verified:false, pending:true });   // todavía no terminó (o se cerró la ventana a mitad)
    if (Number(r.detectedAge) < AGE_MIN) {
      delete user.ageCheck; saveDB();
      return res.status(403).json({ ok:false, code:'AGE_TOO_YOUNG', err:'ageefy no pudo confirmar que seas mayor de 18.' });
    }
    // Se guarda lo mínimo: método, fecha e id de la sesión. No se conserva la edad estimada.
    user.ageVerified = { method:'ageefy', at:new Date().toISOString(), verificationId:id };
    delete user.ageCheck;
    saveDB();
    toUser(user.id).emit('user_updated', { userId:user.id });
    res.json({ ok:true, verified:true });
  } catch (e) { res.status(500).json({ ok:false, err:'No se pudo completar la verificación.' }); }
});

// Camino 2 · un admin marca (o desmarca) a una cuenta como +18. Puede marcarse a sí mismo.
app.post('/api/admin/users/:id/adult', requireAuth, requireAdmin, (req, res) => {
  const target = DB.users[req.params.id];
  if (!target) return res.status(404).json({ ok:false, err:'Usuario no encontrado' });
  // Acepta true/false (JSON) y también "true"/"false"/1/0, por si un cliente lo manda como texto.
  const raw = req.body ? req.body.adult : undefined;
  const adult = raw === true || raw === 'true' || raw === 1 || raw === '1' ? true : raw === false || raw === 'false' || raw === 0 || raw === '0' ? false : null;
  if (adult === null) return res.status(400).json({ ok:false, err:'Falta indicar si es +18 (adult: true/false)' });
  if (adult) target.ageVerified = { method:'admin', at:new Date().toISOString(), by:req.user.id, byName:req.user.username };
  else delete target.ageVerified;
  delete target.ageCheck;
  DB.users[target.id] = target;
  saveDB();
  toUser(target.id).emit('user_updated', { userId:target.id });
  io.emit('user_updated', { userId:target.id });
  toUser(target.id).emit('map_updated', { all:true });
  notifyActivity(target.id, { kind:'home', id:'age', title:adult ? '🔞 Tu cuenta ya puede ver contenido +18' : '🔞 Se quitó el acceso a contenido +18', body:adult ? 'Ya podés abrir juegos y videos +18.' : 'Los juegos y videos +18 vuelven a estar bloqueados.', tag:'age-status' });   // el catálogo cambia para esa cuenta: los juegos +18 se abren o se bloquean
  console.log(`[AGE] ${req.user.username} ${adult ? 'marcó como +18 a' : 'quitó el +18 de'} ${target.username}${target.id === req.user.id ? ' (él mismo)' : ''}`);
  res.json({ ok:true, adult });
});

// ── GET todos los usuarios (sin pw) ──
// Vista de admin: incluye el booleano `adult` de cada cuenta (para que el botón muestre Marcar o Desmarcar).
// Nunca sale el detalle de cómo lo consiguió (ageVerified): solo el booleano, y solo para admins.
function adminView(u, viewer) {
  const { mail:_m, ...rest } = safeUser(u) || {};   // el admin responde desde el panel: no necesita ver la dirección
  return rest;
}
app.get('/api/users', (req, res) => {
  const viewer = readSession(req);
  const out = {};
  for (const [id, u] of Object.entries(DB.users)) {
    const presence = presenceOf(id);
    const activeMap = presence?.mapId ? DB.maps[presence.mapId] : null;
    const canSeeGame = !!presence?.instanceId && !!activeMap && (viewer?.id === id || viewer?.isAdmin || canReadMap(activeMap, viewer));
    if (!viewer?.isAdmin && u.banned && u.banned.permanent) {
      out[id] = { id, username:'Banned User', color:'#333344', banned:true, created:u.created };
    } else {
      out[id] = {
        ...(viewer?.isAdmin ? adminView(u, viewer) : publicUser(u)),
        online: !!presence,
        ...(canSeeGame ? {
          currentGameId: presence.mapId,
          currentInstanceId: presence.instanceId,
          currentGameName: activeMap?.name || presence.mapId,
          currentInstancePlayers: roomPlayerCount(presence.mapId, presence.instanceId) || 1,
        } : {}),
      };
    }
  }
  res.json({ ok:true, users: out });
});

// ── Servidores ICE para las llamadas (STUN público; TURN opcional por variables de entorno) ──
app.get('/api/push/key', requireAuth, (req, res) => {
  if (!push.ready) return res.status(503).json({ ok:false, err:'Las notificaciones push no están disponibles' });
  res.json({ ok:true, key:push.publicKey });
});
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const proto = String(req.get('x-forwarded-proto') || req.protocol || '').split(',')[0].trim();
  if (proto === 'https' && req.get('host')) push.setSubject('https://' + req.get('host'));
  const result = push.subscribe(req.user.id, req.body?.subscription, req.get('user-agent'));
  res.status(result.ok ? 200 : 400).json(result);
});
app.get('/api/push/status', requireAuth, (req, res) => {
  res.json({ ok:true, ready:push.ready, devices:(DB.push?.[req.user.id] || []).length, lastError:push.lastError });
});
app.post('/api/push/test', requireAuth, async (req, res) => {
  const devices = (DB.push?.[req.user.id] || []).length;
  if (!push.ready) return res.status(503).json({ ok:false, err:'El servidor no tiene push configurado' });
  if (!devices) return res.status(409).json({ ok:false, err:'Este dispositivo no está suscrito todavía' });
  const sent = await push.send(req.user.id, { type:'test', title:'Crix', body:'🔔 Así van a sonar tus avisos', tag:'crix-test', url:'/' }, { ttl:60, urgency:'high' });
  res.json({ ok:true, devices, sent, lastError:push.lastError });
});
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  push.unsubscribe(req.user.id, typeof req.body?.endpoint === 'string' ? req.body.endpoint : '');
  res.json({ ok:true });
});
// ── Servidores ICE para las llamadas ──
// Sin un servidor TURN, dos teléfonos en datos móviles (CGNAT) o detrás de ciertos routers NO logran conectarse:
// la llamada queda en "Conectando…" y cada uno solo se ve a sí mismo. Opciones (todas sin tarjeta):
//  1) Metered Open Relay (20 GB/mes gratis, solo registro): CRIX_METERED_DOMAIN (ej. crix.metered.live) + CRIX_METERED_API_KEY
//  2) Cualquier TURN con usuario/clave fijos (ExpressTURN, coturn, etc.): CRIX_TURN_URL (varias separadas por coma) + CRIX_TURN_USER + CRIX_TURN_PASS
const STUN_SERVERS = [{ urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302'] }];
let iceCache = { at:0, servers:null, turn:false, source:'stun' };
const ICE_CACHE_MS = 6 * 60 * 60 * 1000;     // las credenciales se renuevan cada 6 h
async function fetchJson(url, opts = {}, ms = 6000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal:ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
// Normaliza lo que se haya puesto en CRIX_TURN_URL: acepta "turn:host:3478", "host:3478", solo "host" (se expande a UDP+TCP+TLS 443,
// que es lo que ExpressTURN publica) y separa por coma, espacio o salto de línea. Una URL mal formada hacía que
// RTCPeerConnection lanzara SyntaxError en el navegador y la llamada ni siquiera arrancaba.
// Conjunto completo que publica ExpressTURN: UDP 3478, TCP 3478, TCP 80 y TLS 443. Las redes que bloquean UDP o puertos
// raros solo pasan por 80/443, así que tenerlos todos es lo que evita que la llamada se quede sin ruta.
function standardTurnSet(host) {
  return ['turn:' + host + ':3478?transport=udp', 'turn:' + host + ':3478?transport=tcp', 'turn:' + host + ':80?transport=tcp', 'turns:' + host + ':443?transport=tcp'];
}
// Si CRIX_TURN_URL apunta a ExpressTURN con una sola URL (por ejemplo solo UDP 3478), se completan las demás.
function completeExpressTurn(urls) {
  const hosts = new Set();
  for (const u of urls) { const m = u.match(/^turns?:([^:?\/]+)/i); if (m && /(^|\.)expressturn\.com$/i.test(m[1])) hosts.add(m[1]); }
  // La URL "pelada" (turn:host:3478, sin transport) queda cubierta por el conjunto completo: no se repite.
  const out = urls.filter(u => { const m = u.match(/^turn:([^:?\/]+):3478$/i); return !(m && hosts.has(m[1])); });
  for (const h of hosts) for (const u of standardTurnSet(h)) if (!out.includes(u)) out.push(u);
  return out;
}
function normalizeTurnUrls(raw) {
  const out = [];
  const add = u => { if (u && !out.includes(u)) out.push(u); };
  for (let item of String(raw || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean)) {
    item = item.replace(/^["']+|["']+$/g, '');
    const m = item.match(/^(turns?|stuns?):/i);
    if (m) { add(item.replace(/^(turns?|stuns?):/i, x => x.toLowerCase()).replace(/^(turns?:)\/\//i, '$1')); continue; }
    const hp = item.replace(/^\/\//, '').replace(/\/+$/, '');
    if (!hp) continue;
    if (/:\d+$/.test(hp)) { add('turn:' + hp); continue; }             // host:puerto
    for (const u of standardTurnSet(hp)) add(u);                          // solo host → conjunto estándar
  }
  // Un turn: sin transport también se ofrece por TCP y los turns: siempre por TCP (si no, algunos navegadores los ignoran).
  return completeExpressTurn(out.map(u => (/^turns:/.test(u) && !/transport=/.test(u)) ? u + (u.includes('?') ? '&' : '?') + 'transport=tcp' : u));
}
function turnCreds() { return { user: String(process.env.CRIX_TURN_USER || '').trim(), pass: String(process.env.CRIX_TURN_PASS || '').trim() }; }
async function buildIceServers() {
  const out = [...STUN_SERVERS]; let turn = false, source = 'stun';
  try {
    if (process.env.CRIX_METERED_DOMAIN && process.env.CRIX_METERED_API_KEY) {
      const j = await fetchJson('https://' + String(process.env.CRIX_METERED_DOMAIN).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') + '/api/v1/turn/credentials?apiKey=' + encodeURIComponent(process.env.CRIX_METERED_API_KEY));
      if (Array.isArray(j)) for (const srv of j) { out.push(srv); if (srv.username) turn = true; }
      if (turn) source = 'metered';
    }
  } catch (err) { log('ICE', 'No se pudieron pedir credenciales TURN: ' + err.message); }
  if (process.env.CRIX_TURN_URL) {
    const urls = normalizeTurnUrls(process.env.CRIX_TURN_URL), { user, pass } = turnCreds();
    if (!urls.length) log('ICE', 'CRIX_TURN_URL está vacía o no se pudo interpretar: ' + process.env.CRIX_TURN_URL);
    else {
      if (!user || !pass) log('ICE', '⚠️ CRIX_TURN_USER / CRIX_TURN_PASS vacíos: ExpressTURN rechazará la conexión (401)');
      // Un STUN del mismo proveedor ayuda a descubrir la IP pública; cada URL de TURN va en su propia entrada
      // (si una falla por puerto bloqueado, las demás siguen sirviendo).
      for (const u of urls) if (/^stuns?:/.test(u)) out.push({ urls:[u] });
      if (urls.some(u => /expressturn\.com/i.test(u))) out.push({ urls:['stun:stun.expressturn.com:3478'] });
      const turnUrls = urls.filter(u => /^turns?:/.test(u));
      if (turnUrls.length) { out.push({ urls:turnUrls, username:user, credential:pass }); turn = true; if (source === 'stun') source = 'custom'; }
    }
  }
  return { servers:out, turn, source };
}
// Prueba REAL del TURN desde el servidor (Allocate con autenticación, RFC 5766): distingue "no responde" (puerto bloqueado,
// host mal escrito) de "responde pero rechaza usuario/clave" (401) y de "funciona". Se usa en el arranque y en /api/ice/test.
function turnProbe(urlStr, user, pass, timeoutMs = 4500) {
  const dgram = require('dgram'), net = require('net'), tls = require('tls');
  return new Promise(resolve => {
    const m = String(urlStr).match(/^(turns?):([^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i);
    if (!m) return resolve({ url:urlStr, ok:false, err:'URL no válida' });
    const secure = m[1].toLowerCase() === 'turns', host = m[2], port = +m[3] || (secure ? 5349 : 3478), proto = secure ? 'tcp' : (m[4] || 'udp').toLowerCase();
    const MAGIC = 0x2112A442, t0 = Date.now(); let done = false, sock = null, step = 0, realm = '', nonce = '', buf = Buffer.alloc(0);
    const finish = r => { if (done) return; done = true; clearTimeout(timer); try { sock && (sock.close ? sock.close() : sock.destroy()); } catch {} resolve({ url:urlStr, ms:Date.now() - t0, ...r }); };
    const timer = setTimeout(() => finish({ ok:false, err:'sin respuesta (timeout: host/puerto bloqueado o mal escrito)' }), timeoutMs);
    const attr = (type, val) => { const pad = (4 - val.length % 4) % 4, b = Buffer.alloc(4 + val.length + pad); b.writeUInt16BE(type, 0); b.writeUInt16BE(val.length, 2); val.copy(b, 4); return b; };
    const msg = (attrs, tid, withAuth) => {
      let body = Buffer.concat(attrs);
      if (withAuth) {
        const key = crypto.createHash('md5').update(user + ':' + realm + ':' + pass).digest();
        const h = Buffer.alloc(20); h.writeUInt16BE(0x0003, 0); h.writeUInt16BE(body.length + 24, 2); h.writeUInt32BE(MAGIC, 4); tid.copy(h, 8);
        const mi = crypto.createHmac('sha1', key).update(Buffer.concat([h, body])).digest();
        body = Buffer.concat([body, attr(0x0008, mi)]);
      }
      const h = Buffer.alloc(20); h.writeUInt16BE(0x0003, 0); h.writeUInt16BE(body.length, 2); h.writeUInt32BE(MAGIC, 4); tid.copy(h, 8);
      return Buffer.concat([h, body]);
    };
    const parse = b => {
      const type = b.readUInt16BE(0), len = b.readUInt16BE(2), attrs = {}; let o = 20;
      while (o + 4 <= 20 + len) { const t = b.readUInt16BE(o), l = b.readUInt16BE(o + 2); attrs[t] = b.slice(o + 4, o + 4 + l); o += 4 + l + ((4 - l % 4) % 4); }
      return { type, attrs };
    };
    const send = authed => {
      const tid = crypto.randomBytes(12), a = [attr(0x0019, Buffer.from([17, 0, 0, 0]))];     // REQUESTED-TRANSPORT: UDP
      if (authed) { a.push(attr(0x0006, Buffer.from(user)), attr(0x0014, Buffer.from(realm)), attr(0x0015, Buffer.from(nonce))); }
      const pkt = msg(a, tid, authed); if (proto === 'udp') sock.send(pkt); else sock.write(pkt);
    };
    const onMsg = b => {
      let r; try { r = parse(b); } catch { return finish({ ok:false, err:'respuesta ilegible' }); }
      if (step === 0 && r.type === 0x0113) {                                    // 401 con realm/nonce
        const code = r.attrs[0x0009] ? r.attrs[0x0009][2] * 100 + r.attrs[0x0009][3] : 0;
        if (r.attrs[0x0014] && r.attrs[0x0015]) { realm = r.attrs[0x0014].toString(); nonce = r.attrs[0x0015].toString(); step = 1; return send(true); }
        return finish({ ok:false, err:'el servidor rechazó la solicitud (' + code + ')' });
      }
      if (step === 0 && r.type === 0x0103) return finish({ ok:true, note:'responde (sin autenticación)' });
      if (r.type === 0x0103) return finish({ ok:true });                         // Allocate success
      if (r.type === 0x0113) {
        const c = r.attrs[0x0009] ? r.attrs[0x0009][2] * 100 + r.attrs[0x0009][3] : 0;
        if (c === 401) return finish({ ok:false, reachable:true, err:'usuario o contraseña incorrectos (401): revisá CRIX_TURN_USER y CRIX_TURN_PASS' });
        if (c === 438 && step === 1 && r.attrs[0x0015]) { nonce = r.attrs[0x0015].toString(); step = 2; return send(true); }
        if (c === 486 || c === 508) return finish({ ok:true, reachable:true, note:'autenticado (' + c + ': cuota/asignaciones agotadas ahora mismo)' });
        return finish({ ok:false, reachable:true, err:'error ' + c });
      }
      finish({ ok:false, err:'respuesta inesperada 0x' + r.type.toString(16) });
    };
    try {
      if (proto === 'udp') {
        sock = dgram.createSocket('udp4'); sock.on('error', e => finish({ ok:false, err:e.message })); sock.on('message', onMsg);
        sock.connect(port, host, () => send(false));
      } else {
        const onData = d => { buf = Buffer.concat([buf, d]); while (buf.length >= 20) { const L = 20 + buf.readUInt16BE(2); if (buf.length < L) break; const one = buf.slice(0, L); buf = buf.slice(L); onMsg(one); } };
        sock = secure ? tls.connect({ host, port, servername:host }, () => send(false)) : net.connect({ host, port }, () => send(false));
        sock.on('data', onData); sock.on('error', e => finish({ ok:false, err:e.message }));
      }
    } catch (e) { finish({ ok:false, err:e.message }); }
  });
}
async function testTurn() {
  const { user, pass } = turnCreds(), urls = normalizeTurnUrls(process.env.CRIX_TURN_URL).filter(u => /^turns?:/.test(u));
  if (!urls.length) return { configured:false, results:[] };
  return { configured:true, results: await Promise.all(urls.map(u => turnProbe(u, user, pass))) };
}
async function getIceServers() {
  if (iceCache.servers && Date.now() - iceCache.at < ICE_CACHE_MS) return iceCache;
  const built = await buildIceServers();
  // Si se configuró TURN y falló, se reintenta en 1 minuto en vez de quedarse 6 h solo con STUN.
  const wantsTurn = !!(process.env.CRIX_METERED_DOMAIN || process.env.CRIX_TURN_URL);
  iceCache = { at: (wantsTurn && !built.turn) ? Date.now() - ICE_CACHE_MS + 60000 : Date.now(), servers:built.servers, turn:built.turn, source:built.source };
  log('ICE', 'servidores listos · TURN: ' + (built.turn ? built.source : 'no configurado (solo STUN)'));
  if (process.env.CRIX_TURN_URL) testTurn().then(t => t.results.forEach(r => log('ICE', 'TURN ' + r.url + ' → ' + (r.ok ? 'OK' + (r.note ? ' · ' + r.note : '') + ' (' + r.ms + ' ms)' : '✖ ' + r.err)))).catch(() => {});
  return iceCache;
}
app.get('/api/ice', requireAuth, async (req, res) => {
  try {
    const ice = await getIceServers();
    res.json({ ok:true, iceServers:ice.servers, hasTurn:ice.turn, source:ice.source });
  } catch (err) {
    log('ICE', 'getIceServers falló: ' + err.message);
    res.json({ ok:true, iceServers:STUN_SERVERS, hasTurn:false, source:'stun' });   // al menos STUN: la llamada no se cae por esto
  }
});

// Diagnóstico del TURN: abrir https://TU-APP/api/ice/test estando con sesión iniciada.
app.get('/api/ice/test', requireAuth, async (req, res) => {
  const t = await testTurn(); const ice = await getIceServers();
  res.json({ ok:true, hasTurn:ice.turn, source:ice.source, urls:(ice.servers || []).flatMap(x => x.urls), ...t,
    note:'Esta prueba corre desde el SERVIDOR. Si tu hosting bloquea UDP/puertos de salida puede decir "sin respuesta" aunque los teléfonos sí lleguen al TURN. Si ni así conectan, la llamada sigue por el modo respaldo (a través del servidor).' });
});

// ── Gente en línea ahora (visible para todos) ──
app.get('/api/online', (req, res) => {
  const viewer = readSession(req);
  const list = [...new Set([...Object.keys(onlineUsers), ...(cluster.enabled ? cluster.remoteOnlineIds() : [])])].map(id => {
    const u = DB.users[id]; if (!u || u.banned) return null;
    return { id, username:u.username, color:u.color, avatar:u.avatar || '', ...presenceInfo(id, viewer) };
  }).filter(Boolean);
  res.json({ ok:true, users:list });
});

// ── Unirse al servidor de cualquier persona que esté jugando ──
app.post('/api/join-user/:id', requireAuth, (req, res) => {
  const target = DB.users[req.params.id];
  const presence = presenceOf(req.params.id);
  if (!target || !presence) return res.status(404).json({ ok:false, err:'Esa persona no está en línea.' });
  if (!presence.mapId || !presence.instanceId) return res.status(409).json({ ok:false, err:'Esa persona no está jugando ahora.' });
  const map = DB.maps[presence.mapId];
  if (!map || !canReadMap(map, req.user)) return res.status(403).json({ ok:false, err:'No tenés acceso al juego que está jugando.' });
  if (!canEnterAdult(map, req.user)) return ageRequired(res);
  const count = roomPlayerCount(presence.mapId, presence.instanceId);
  if (count >= maxPlayersFor(map)) return res.status(409).json({ ok:false, err:'Ese servidor está lleno.' });
  res.json({ ok:true, mapId:presence.mapId, instanceId:presence.instanceId, gameName:map.name || presence.mapId, players:count });
});

// ── GET mapas ──
// ── Catálogo liviano ──
// Antes /api/maps mandaba CADA juego completo (partes, scripts, HTML...): con miles de juegos la respuesta pesaba cientos de MB
// y en el celular la descarga fallaba, así que solo se veía lo propio. Ahora el catálogo manda solo lo que muestran las tarjetas
// (`partial:true`) y el juego completo se pide al abrirlo (GET /api/maps/:id). Los propios y los de colaboración van completos
// hasta un tope de tamaño. `?full=1` devuelve el catálogo completo como antes.
const MAP_LIST_FULL_BUDGET = 8 * 1024 * 1024;
const MAP_LIGHT_KEYS = ['classification', 'likedBy', 'collaborators', 'assignedPlayers', 'textureIds', 'textureNames', 'sounds', 'tags'];
function publicMapRecord(m0) { const { comments, ...m } = m0; m.commentCount = Array.isArray(comments) ? comments.length : 0;   // los comentarios se piden aparte (GET /api/maps/:id/comments)
  const lab = m.thumb ? thumbLabel(m) : {}; if (m.icon) { const { icon, ...rest } = m; return { ...rest, ...lab, hasIcon:true }; } return m.thumb ? { ...m, ...lab } : m; }
function summarizeMap(id, m) {
  const out = { partial:true };
  for (const [k, v] of Object.entries(m)) {
    if (k === 'icon' || k === 'thumb') continue;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') { if (v.length <= 4096) out[k] = v; }
    else if (MAP_LIGHT_KEYS.includes(k) && Array.isArray(v) && v.length <= 500) out[k] = v;
    else if (MAP_LIGHT_KEYS.includes(k) && v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 500) out[k] = v;
  }
  out.id = id;
  out.commentCount = Array.isArray(m.comments) ? m.comments.length : 0;
  if (m.thumb) Object.assign(out, thumbLabel(m));
  if (m.icon) out.hasIcon = true;
  if (typeof m.thumb === 'string' && m.thumb) {
    if (m.thumb.length <= 4096) out.thumb = m.thumb;
    else if (mapIsPublic(m) && /^data:image\/(jpeg|png|webp|gif);base64,/.test(m.thumb)) out.thumb = `/api/maps/${encodeURIComponent(id)}/thumb?v=${Number(m._u) || 0}`;
    else if (m.thumb.length <= 400000) out.thumb = m.thumb;   // no públicos: sin URL abierta, la miniatura va dentro
  }
  return out;
}
// Ficha de un juego +18 para quien todavía no verificó su edad: se ve la tarjeta y la insignia, pero no el contenido.
function lockedMapSummary(id, m) { const out = summarizeMap(id, m); delete out.htmlContent; out.locked = true; return out; }
// ── Clasificación por país ──
// config: preguntas y países (textos en es/en) · geo: país detectado por cabeceras del hosting o por APIs de geolocalización IP
// evaluate: calcula la clasificación (o rechaza si es ilegal) para mostrarla antes de subir. Las rutas de subida la vuelven a calcular.
app.get('/api/classification/config', (req, res) => res.json({ ok:true, ...classification.publicConfig(req.query.kind, req.query.lang) }));
app.get('/api/classification/geo', async (req, res) => {
  try { const g = await classification.detectCountry(req, fetchJson); res.json({ ok:true, country:g.country, source:g.source }); }
  catch { res.json({ ok:true, country:null, source:'none' }); }
});
app.post('/api/classification/evaluate', requireAuth, (req, res) => {
  const ev = classification.evaluate(req.body, req.query.lang || req.body?.lang);
  if (!ev.ok) return res.status(422).json({ ok:false, code:ev.code, err:ev.err, reasons:ev.reasons });
  res.json({ ok:true, result:ev.result });
});
// ── API de clasificación para usar FUERA de Crix ──
// Cada usuario puede conseguir claves propias (POST /api/classification/keys, con su sesión) y usarlas desde su sitio, juego o app:
//   GET  /api/v1/rating/config?kind=game&lang=es   preguntas y países del cuestionario
//   POST /api/v1/rating/evaluate                    { kind, country, answers, legal, declared } → insignia Crix del país (o 422 si es ilegal)
//   GET  /api/v1/rating/badge.svg?system=AR&age=12  dibujo de la insignia (público, sin clave, para usar en <img>)
// La clave va en la cabecera X-Crix-Key. Se guarda solo su hash, y se muestra una única vez al crearla.
const API_KEY_RATE = Number.isFinite(Number(process.env.CRIX_API_RATE)) && process.env.CRIX_API_RATE !== undefined && process.env.CRIX_API_RATE !== '' ? Number(process.env.CRIX_API_RATE) : 120;   // pedidos por minuto por clave (0 = sin límite)
const apiKeyHits = new Map();                // id de clave → { n, reset }
function publicKey(k) { return { id:k.id, name:k.name, prefix:k.prefix, createdAt:k.createdAt, lastUsed:k.lastUsed || null }; }
app.get('/api/classification/keys', requireAuth, (req, res) => {
  res.json({ ok:true, keys:Object.values(DB.apiKeys).filter(k => k.userId === req.user.id).sort((a, b) => b.createdAt - a.createdAt).map(publicKey) });
});
app.post('/api/classification/keys', requireAuth, (req, res) => {
  const key = 'crxc_' + crypto.randomBytes(24).toString('base64url');
  const id = crypto.randomBytes(6).toString('hex');
  DB.apiKeys[tokenHash(key)] = { id, userId:req.user.id, name:String(req.body?.name || 'Mi clave').trim().slice(0, 40) || 'Mi clave', prefix:key.slice(0, 9), createdAt:Date.now() };
  saveDB();
  res.json({ ok:true, key, info:publicKey(DB.apiKeys[tokenHash(key)]) });   // la clave completa solo se ve ahora
});
app.delete('/api/classification/keys/:id', requireAuth, (req, res) => {
  const h = Object.keys(DB.apiKeys).find(x => DB.apiKeys[x].id === req.params.id && DB.apiKeys[x].userId === req.user.id);
  if (!h) return res.status(404).json({ ok:false, err:'Clave no encontrada' });
  delete DB.apiKeys[h]; saveDB(); res.json({ ok:true });
});
// CORS abierto solo para /api/v1 (se llama desde otros sitios; la clave viaja en cabecera, no en cookies).
app.use('/api/v1', (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET, POST, OPTIONS', 'Access-Control-Allow-Headers':'Content-Type, X-Crix-Key', 'Access-Control-Max-Age':'86400' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.get('/api/v1/rating/badge.svg', (req, res) => {
  const svg = classification.badgeSvg(String(req.query.system || ''), Number(req.query.age), req.query.explicit === '1', req.query.size);
  if (!svg) return res.status(400).type('text/plain').send('system o age inválidos');
  res.set({ 'Content-Type':'image/svg+xml; charset=utf-8', 'Cache-Control':'public, max-age=86400' }).send(svg);
});
function requireApiKey(req, res, next) {
  const key = String(req.get('x-crix-key') || '');
  const rec = key.startsWith('crxc_') ? DB.apiKeys[tokenHash(key)] : null;
  const owner = rec && DB.users[rec.userId];
  if (!rec || !owner || owner.banned) return res.status(401).json({ ok:false, err:'Clave inválida. Mandala en la cabecera X-Crix-Key.' });
  const now = Date.now(), hit = apiKeyHits.get(rec.id);
  if (!hit || hit.reset <= now) apiKeyHits.set(rec.id, { n:1, reset:now + 60000 });
  else if (API_KEY_RATE > 0 && ++hit.n > API_KEY_RATE) return res.status(429).set('Retry-After', String(Math.ceil((hit.reset - now) / 1000))).json({ ok:false, err:'Demasiados pedidos. Probá en un minuto.' });
  if (apiKeyHits.size > 5000) for (const [k, v] of apiKeyHits) if (v.reset <= now) apiKeyHits.delete(k);
  if (!rec.lastUsed || now - rec.lastUsed > 3600000) { rec.lastUsed = now; saveDB(); }   // se guarda a lo sumo cada hora
  next();
}
app.get('/api/v1/rating/config', requireApiKey, (req, res) => res.json({ ok:true, ...classification.publicConfig(req.query.kind, req.query.lang) }));
app.post('/api/v1/rating/evaluate', requireApiKey, (req, res) => {
  const ev = classification.evaluate(req.body, req.query.lang || req.body?.lang);
  if (!ev.ok) return res.status(422).json({ ok:false, code:ev.code, err:ev.err, reasons:ev.reasons });
  const { system, age, icon } = ev.result, explicit = /-X$/.test(icon || '');
  const origin = (req.protocol + '://' + req.get('host'));
  res.json({ ok:true, result:{ country:ev.result.country, countryName:ev.result.countryName, systemId:system, system:ev.result.systemName, label:ev.result.label, age, adult:ev.result.adult,
    descriptors:ev.result.descriptors, descriptorLabels:ev.result.descriptorLabels, badgeUrl:`${origin}/api/v1/rating/badge.svg?system=${system}&age=${age}${explicit ? '&explicit=1' : ''}`,
    badge:classification.badgeSvg(system, age, explicit, 64), at:ev.result.at, note:'Insignia propia de Crix; no es una clasificación oficial.' } });
});
app.get('/api/maps', (req, res) => {
  const uObj = readSession(req);
  const out  = {};
  const wantFull = req.query.full === '1';
  let used = 0;
  for (const [id, m] of Object.entries(DB.maps)) {
    if (!canReadMap(m, uObj)) continue;
    const mine = uObj && (m.authorId === uObj.id || (Array.isArray(m.collaborators) && m.collaborators.includes(uObj.id)));
    if (wantFull) { out[id] = canEnterAdult(m, uObj) ? publicMapRecord(m) : lockedMapSummary(id, m); continue; }
    if (mine && used < MAP_LIST_FULL_BUDGET) {
      const rec = publicMapRecord(m);
      used += (typeof m.htmlContent === 'string' ? m.htmlContent.length : 0) + (Array.isArray(m.parts) ? m.parts.length * 400 : 0) + (typeof m.thumb === 'string' ? m.thumb.length : 0) + 2000;
      out[id] = rec;
    } else out[id] = summarizeMap(id, m);
  }
  res.json({ ok:true, maps: out });
});
// Un juego completo (lo pide el cliente al abrirlo, jugarlo o editarlo).
app.get('/api/maps/:id', (req, res) => {
  const m = DB.maps[req.params.id];
  const viewer = readSession(req);
  if (!m || !canReadMap(m, viewer)) return res.status(404).json({ ok:false, err:'Juego no encontrado' });
  if (!canEnterAdult(m, viewer)) return ageRequired(res);
  res.json({ ok:true, map: publicMapRecord(m) });
});
// ── Descarga para usar sin conexión (PWA) ──
// Solo se entrega si el creador la permitió (allowDownload). El creador, su equipo y los admins siempre pueden bajar el suyo.
// Devuelve el juego completo y la lista de archivos (texturas y sonidos) para que el cliente los guarde en el dispositivo.
function mayDownload(item, user) {
  if (!item) return false;
  if (user && (user.isAdmin || item.authorId === user.id || (Array.isArray(item.collaborators) && item.collaborators.includes(user.id)))) return true;
  return item.allowDownload === true;
}
// El cliente pregunta por lo que tiene descargado: 'ok' (sigue permitido), 'revoked' (el creador retiró el permiso) o 'gone' (se borró o dejó de ser visible).
// Así una copia se elimina del dispositivo cuando su creador lo decide, sin depender del catálogo local.
app.get('/api/offline/check', requireAuth, (req, res) => {
  const list = key => String(req.query[key] || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 100), status = {}, user = req.user;
  for (const id of list('maps')) { const m = DB.maps[id]; status['map:' + id] = (!m || !canReadMap(m, user)) ? 'gone' : (!mayDownload(m, user) ? 'revoked' : 'ok'); }
  for (const id of list('videos')) { const v = (DB.videos || []).find(x => x.id === id); status['video:' + id] = (!v || !canReadVideo(v, user)) ? 'gone' : (!mayDownload(v, user) ? 'revoked' : 'ok'); }
  for (const id of list('accessories')) { const a = ACC_ID_PARAM.test(id) && DB.accessories && DB.accessories[id]; status['accessory:' + id] = (!a || !(a.scope === 'public' || a.authorId === user.id || user.isAdmin)) ? 'gone' : (!mayDownload(a, user) ? 'revoked' : 'ok'); }
  res.json({ ok:true, status });
});
app.get('/api/maps/:id/offline-pack', (req, res) => {
  const m = DB.maps[req.params.id], viewer = readSession(req) || userFromToken(req.query.t);
  if (!m || !canReadMap(m, viewer)) return res.status(404).json({ ok:false, err:'Juego no encontrado' });
  if (!canEnterAdult(m, viewer)) return ageRequired(res);
  if (!mayDownload(m, viewer)) return res.status(403).json({ ok:false, code:'DOWNLOAD_NOT_ALLOWED', err:'Su creador no permitió descargar esta creación' });
  const id = encodeURIComponent(m.id);
  const textures = (m.textureIds || []).filter(t => TEX_ID_RE.test(t)).map(t => ({ id:t, url:`/api/maps/${id}/textures/${encodeURIComponent(t)}` }));
  const sounds = Object.entries(m.sounds || {}).filter(([sid]) => SND_ID_RE.test(sid)).map(([sid, meta]) => ({ id:sid, size:Number(meta && meta.size) || 0, url:`/api/maps/${id}/sounds/${encodeURIComponent(sid)}` }));
  res.json({ ok:true, map:publicMapRecord(m), textures, sounds });
});
// Miniatura como imagen real (solo juegos públicos): así el catálogo no lleva cientos de KB en base64 por juego.
app.get('/api/maps/:id/thumb', (req, res) => {
  const m = DB.maps[req.params.id];
  const match = m && mapIsPublic(m) && typeof m.thumb === 'string' ? /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(m.thumb) : null;
  if (!match) return res.status(404).end();
  res.set({ 'Content-Type': match[1], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=86400' });
  res.end(Buffer.from(match[2], 'base64'));
});

// ── PARTIDAS ACTIVAS (cada instancia es una sala separada) ──
app.get('/api/maps/:id/instances', (req, res) => {
  const user = readSession(req);
  const map = DB.maps[req.params.id];
  if (!map || !canReadMap(map, user)) return res.status(404).json({ ok:false, err:'Juego no encontrado' });
  const instances = Object.values(rooms)
    .filter(room => room.mapId === req.params.id && !room.playtest && Object.keys(room.players).length > 0)
    .map(room => ({
      id: room.instanceId,
      mapId: room.mapId,
      startedAt: room.createdAt,
      playerCount: Object.keys(room.players).length,
      players: Object.values(room.players).map(player => ({ id:player.userId, username:player.username })),
    }));
  if (cluster.enabled) for (const r of cluster.remoteRoomsList()) if (r.mapId === req.params.id && r.count > 0) instances.push({ id:r.instanceId, mapId:r.mapId, startedAt:r.startedAt, playerCount:r.count, players:r.players || [] });
  instances.sort((a,b) => b.playerCount-a.playerCount || a.startedAt-b.startedAt);
  res.json({ ok:true, instances });
});

// Reservar una sala nueva. Jugar en otra instancia nunca mezcla a sus jugadores.
app.post('/api/maps/:id/instances', requireAuth, (req, res) => {
  const map = DB.maps[req.params.id];
  if (!map || !canReadMap(map, req.user)) return res.status(404).json({ ok:false, err:'Juego no encontrado' });
  if (!canEnterAdult(map, req.user)) return ageRequired(res);
  const instanceId = cluster.nodeId + '-' + crypto.randomUUID();   // el prefijo dice qué instancia del servidor es dueña de la sala
  const room = getRoom(req.params.id, instanceId);
  // ▶ Probar del Studio: misma sala y mismo entorno de scripts que el juego real, pero invisible para el resto (solo quien edita el juego).
  if (req.body && req.body.playtest === true && canEditMap(map, req.user)) room.playtest = true;
  res.status(201).json({ ok:true, instance:{ id:room.instanceId, mapId:room.mapId, startedAt:room.createdAt } });
});

// ── Texturas de los juegos: archivos en disco (el mapa solo guarda la lista de ids) ──
const TEX_DIR = persist.TEX_DIR;
const TEX_ID_RE = /^tx_[a-z0-9]{3,40}$/, MAP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Si un juego cambió de id (ver migrate-id), sus texturas y sonidos siguen guardados bajo el id anterior.
function assetId(id) { const a = DB.maps[id] && DB.maps[id].assetsId; return (a && MAP_ID_RE.test(a)) ? a : id; }
const MAX_TEX_BYTES = LIM.tex;   // sin límite de cantidad de texturas por juego
function sniffImage(buf) {   // formato REAL por los primeros bytes
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { mime:'image/png', ext:'png' };
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime:'image/jpeg', ext:'jpg' };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { mime:'image/webp', ext:'webp' };
  if (buf.toString('latin1', 0, 4) === 'GIF8') return { mime:'image/gif', ext:'gif' };
  return null;
}
const TEX_MIME = { png:'image/png', jpg:'image/jpeg', webp:'image/webp', gif:'image/gif' };
function texDir(mapId) { return path.join(TEX_DIR, mapId); }
function texFile(mapId, tid) { try { const f = fs.readdirSync(texDir(mapId)).find(x => x.startsWith(tid + '.')); return f ? path.join(texDir(mapId), f) : null; } catch { return null; } }
app.post('/api/maps/:id/textures', requireAuth, async (req, res) => {
  const map = DB.maps[req.params.id];
  if (!map || !MAP_ID_RE.test(req.params.id)) return res.status(404).json({ ok:false, err:'Guardá el juego antes de subir texturas' });
  if (!canEditMap(map, req.user)) return res.status(403).json({ ok:false, err:'No podés editar este juego' });
  const incoming = req.body && req.body.textures;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ ok:false, err:'Faltan texturas' });
  const entries = Object.entries(incoming), ids = new Set(map.textureIds || []), staged = [];
  for (const [tid, value] of entries) {
    if (!TEX_ID_RE.test(tid)) return res.status(400).json({ ok:false, err:'Identificador de textura inválido' });
    const buf = dataUrlToBuffer(value);
    if (!buf) return res.status(400).json({ ok:false, err:'Imagen inválida' });
    if (buf.length > MAX_TEX_BYTES) return res.status(413).json({ ok:false, err:'La textura supera ' + Math.round(MAX_TEX_BYTES / 1048576) + ' MB' });
    const kind = sniffImage(buf);
    if (!kind) return res.status(400).json({ ok:false, err:'Formato de imagen no soportado (PNG, JPG, WEBP o GIF)' });
    staged.push({ tid, buf, kind });
  }
  fs.mkdirSync(texDir(assetId(req.params.id)), { recursive:true });
  const uploads = [];
  for (const { tid, buf, kind } of staged) {
    const name = `${tid}.${kind.ext}`;
    try { const old = texFile(assetId(req.params.id), tid); if (old) { fs.unlinkSync(old); if (path.basename(old) !== name) persist.delKey(`textures/${assetId(req.params.id)}/${path.basename(old)}`); } } catch {}
    fs.writeFileSync(path.join(texDir(assetId(req.params.id)), name), buf); ids.add(tid);
    uploads.push(persist.putFile(`textures/${assetId(req.params.id)}/${name}`, path.join(texDir(assetId(req.params.id)), name)));
  }
  await settleUpload(Promise.all(uploads));
  map.textureIds = [...ids]; saveDB();
  io.emit('map_updated', { mapId:map.id });   // el resto (y tus otros dispositivos) reciben las texturas nuevas al instante
  res.json({ ok:true, textureIds: map.textureIds });
});
app.get('/api/maps/:id/textures/:tid', async (req, res) => {
  const map = DB.maps[req.params.id], user = readSession(req) || userFromToken(req.query.t);
  if (!map || !MAP_ID_RE.test(req.params.id) || !TEX_ID_RE.test(req.params.tid) || !canReadMap(map, user)) return res.status(404).end();
  if (!canEnterAdult(map, user)) return res.status(403).end();
  const file = texFile(assetId(req.params.id), req.params.tid) || await persist.fetchTexture(assetId(req.params.id), req.params.tid); if (!file) return res.status(404).end();
  res.set({ 'Content-Type': TEX_MIME[path.extname(file).slice(1)] || 'application/octet-stream', 'X-Content-Type-Options':'nosniff', 'Cache-Control': mapIsPublic(map) ? 'public, no-cache' : 'private, no-cache' });   // no-cache = se revalida con ETag (304 si no cambió): una textura reemplazada se ve enseguida
  res.sendFile(file, { dotfiles:'allow' }, err => { if (err && !res.headersSent) res.status(err.status || 500).end(); });
});

// ── Sonidos de los juegos: archivos en disco + copia en el bucket (igual que las texturas) ──
const SOUND_DIR = persist.SOUND_DIR;
const SND_ID_RE = /^sn_[a-z0-9]{3,40}$/;
const SND_MIME = { mp3:'audio/mpeg', ogg:'audio/ogg', wav:'audio/wav', flac:'audio/flac', m4a:'audio/mp4', aac:'audio/aac', webm:'audio/webm', aiff:'audio/aiff' };
function sniffAudio(b) {   // formato REAL por los primeros bytes
  if (!b || b.length < 12) return null;
  const a4 = b.toString('latin1', 0, 4);
  if (a4 === 'OggS') return 'ogg';
  if (a4 === 'fLaC') return 'flac';
  if (a4 === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (a4 === 'FORM' && ['AIFF','AIFC'].includes(b.toString('latin1', 8, 12))) return 'aiff';
  if (b.toString('latin1', 0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'webm';
  if (b.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  if (b[0] === 0xFF && (b[1] & 0xF6) === 0xF0) return 'aac';          // AAC ADTS
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'mp3';          // MPEG audio sin etiqueta
  return null;
}
function soundDir(mapId) { return path.join(SOUND_DIR, mapId); }
function soundFile(mapId, sid) { try { const f = fs.readdirSync(soundDir(mapId)).find(x => x.startsWith(sid + '.') && !x.endsWith('.part')); return f ? path.join(soundDir(mapId), f) : null; } catch { return null; } }
// Subida binaria (sin base64): PUT /api/maps/:id/sounds/:sid?name=Explosión
app.put('/api/maps/:id/sounds/:sid', requireAuth, async (req, res) => {
  let tmp = null;
  try {
    const map = DB.maps[req.params.id];
    if (!map || !MAP_ID_RE.test(req.params.id)) return res.status(404).json({ ok:false, err:'Guardá el juego antes de subir sonidos' });
    if (!canEditMap(map, req.user)) return res.status(403).json({ ok:false, err:'No podés editar este juego' });
    if (!SND_ID_RE.test(req.params.sid)) return res.status(400).json({ ok:false, err:'Identificador de sonido inválido' });
    if (Number(req.headers['content-length']) > LIM.sound) return res.status(413).json({ ok:false, err:'El audio supera ' + Math.round(LIM.sound / 1048576) + ' MB' });
    fs.mkdirSync(soundDir(assetId(req.params.id)), { recursive:true });
    tmp = path.join(soundDir(assetId(req.params.id)), `${req.params.sid}.${Date.now()}.part`);
    const size = await streamToFile(req, tmp, LIM.sound);
    if (!size) { fs.rmSync(tmp, { force:true }); return res.status(400).json({ ok:false, err:'Archivo vacío' }); }
    const head = Buffer.alloc(16); const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
    const ext = sniffAudio(head);
    if (!ext) { fs.rmSync(tmp, { force:true }); return res.status(400).json({ ok:false, err:'Formato de audio no soportado (MP3, OGG, WAV, FLAC, M4A, AAC, WEBM o AIFF)' }); }
    const name = `${req.params.sid}.${ext}`, old = soundFile(assetId(req.params.id), req.params.sid);
    if (old && path.basename(old) !== name) { try { fs.unlinkSync(old); } catch {} persist.delKey(`sounds/${assetId(req.params.id)}/${path.basename(old)}`); }
    fs.renameSync(tmp, path.join(soundDir(assetId(req.params.id)), name)); tmp = null;
    await settleUpload(persist.putFile(`sounds/${assetId(req.params.id)}/${name}`, path.join(soundDir(assetId(req.params.id)), name)));
    map.sounds = map.sounds || {};
    map.sounds[req.params.sid] = { name: String(req.query.name || 'Sonido').slice(0, 60), ext, mime: SND_MIME[ext], size };
    saveDB();
    io.emit('map_updated', { mapId:map.id });
    res.json({ ok:true, sound: map.sounds[req.params.sid], sounds: map.sounds });
  } catch (e) {
    if (tmp) { try { fs.rmSync(tmp, { force:true }); } catch {} }
    if (!res.headersSent) res.status(e.code === 'TOO_BIG' ? 413 : 500).json({ ok:false, err:e.message });
  }
});
app.get('/api/maps/:id/sounds/:sid', async (req, res) => {
  const map = DB.maps[req.params.id], user = readSession(req) || userFromToken(req.query.t);
  if (!map || !MAP_ID_RE.test(req.params.id) || !SND_ID_RE.test(req.params.sid) || !canReadMap(map, user)) return res.status(404).end();
  if (!canEnterAdult(map, user)) return res.status(403).end();
  const file = soundFile(assetId(req.params.id), req.params.sid) || await persist.fetchSound(assetId(req.params.id), req.params.sid); if (!file) return res.status(404).end();
  res.set({ 'Content-Type': SND_MIME[path.extname(file).slice(1)] || 'application/octet-stream', 'X-Content-Type-Options':'nosniff', 'Cache-Control': mapIsPublic(map) ? 'public, max-age=86400' : 'private, max-age=600' });
  res.sendFile(file, { acceptRanges:true, dotfiles:'allow' }, err => { if (err && !res.headersSent) res.status(err.status || 500).end(); });
});
app.delete('/api/maps/:id/sounds/:sid', requireAuth, (req, res) => {
  const map = DB.maps[req.params.id];
  if (!map || !MAP_ID_RE.test(req.params.id) || !SND_ID_RE.test(req.params.sid)) return res.status(404).json({ ok:false });
  if (!canEditMap(map, req.user)) return res.status(403).json({ ok:false, err:'No podés editar este juego' });
  const f = soundFile(assetId(req.params.id), req.params.sid);
  if (f) { try { fs.unlinkSync(f); } catch {} persist.delKey(`sounds/${assetId(req.params.id)}/${path.basename(f)}`); }
  if (map.sounds) delete map.sounds[req.params.sid];
  saveDB(); io.emit('map_updated', { mapId:map.id }); res.json({ ok:true, sounds: map.sounds || {} });
});

// ── SAVE mapa ──
app.post('/api/maps', (req, res) => {
  try {
    const user = readSession(req);
    if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para guardar juegos' });
    const m = req.body;
    if (!m || !m.id) return res.json({ ok:false });
    if (m.partial) return res.status(400).json({ ok:false, err:'Juego incompleto (catálogo liviano): se descarga completo antes de guardarlo' });
    const old = DB.maps[m.id];
    if (!old && rejectIfDeleted(res, 'maps', m.id)) return;
    if (old && !canEditMap(old, user))
      return res.status(403).json({ ok:false, err:'No podés editar este juego' });
    const isOwner = !old || old.authorId === user.id || !!user.isAdmin;
    // Quien colabora no cambia la visibilidad ni el equipo; el equipo siempre lo decide el servidor.
    const body = isOwner ? m : { ...m, privacy:old.privacy, assignedPlayers:old.assignedPlayers };
    // Clasificación: la define solo quien es dueño (o admin); el servidor la recalcula desde las respuestas.
    const mapKind = (m.kind === 'app' || old?.kind === 'app') ? 'app' : 'game';
    let cls = old?.classification;
    if (isOwner && m.classification && typeof m.classification === 'object') {
      const ev = classification.evaluate({ ...m.classification, kind:mapKind }, 'es');
      if (ev.ok) cls = ev.result;
      else if (ev.code === 'ILLEGAL_CONTENT' || ev.code === 'KIDS_CONFLICT') return res.status(422).json({ ok:false, code:ev.code, err:ev.err, reasons:ev.reasons });
    }
    const next = { ...body, assetsId: old?.assetsId, likedBy:old?.likedBy || m.likedBy || [], plays:old?.plays ?? m.plays ?? 0, likes:old?.likes ?? m.likes ?? 0, authorId: old?.authorId || user.id, authorName: old?.authorName || user.username, textureIds: old?.textureIds || [], sounds: old?.sounds || {}, collaborators: old?.collaborators || [], comments: old?.comments || [] };
    // En una sesión de equipo activa, las partes/scripts/luces ya llegan por cambios en vivo: un guardado completo no las pisa.
    if (old && teamInSession(m.id, user.id)) for (const k of TEAM_PROTECTED) if (old[k] !== undefined) next[k] = old[k];
    next.allowDownload = isOwner && m.allowDownload !== undefined ? m.allowDownload === true : old?.allowDownload === true;   // permiso de descarga sin conexión: solo lo decide el dueño
    if (okIconData(m.icon)) next.icon = m.icon; else if (okIconData(old?.icon)) next.icon = old.icon; else delete next.icon;
    delete next.hasIcon;
    if (old?.modHidden) next.modHidden = true; else delete next.modHidden;   // solo lo cambia la moderación
    delete next.unrated; delete next.classification;
    if (cls) next.classification = cls;
    // Qué muestra la miniatura (0-3): lo declara el dueño; quien colabora no lo cambia. Una miniatura sensible exige clasificación acorde.
    next.thumbLevel = isOwner && m.thumbLevel !== undefined ? thumbLevelOf(m) : thumbLevelOf(old);
    if (!next.thumb) next.thumbLevel = 0;
    if (next.thumb && Number(cls?.age ?? 0) < THUMB_MIN_AGE[next.thumbLevel])
      return res.status(422).json({ ok:false, code:'THUMB_CONFLICT', err:`Una miniatura con ese contenido solo puede acompañar a juegos clasificados ${THUMB_MIN_AGE[next.thumbLevel]}+. Cambiá la miniatura o la clasificación.` });
    // Sin clasificación válida, un juego/app NUEVO queda como borrador oculto (solo lo ve su autor). Los anteriores a esta función siguen visibles.
    if (!cls && (!old || old.unrated)) next.unrated = true;
    DB.maps[m.id] = next;
    delete DB.maps[m.id].textures;
    saveDB();
    io.emit('map_updated', { mapId: m.id });
    if ((!old || old.unrated) && mapIsPublic(DB.maps[m.id])) {
      io.emit('map_new', { mapId:m.id, name:DB.maps[m.id].name, authorName:DB.maps[m.id].authorName });
      const nm = DB.maps[m.id];
      announceNew('game', nm, nm.authorId, nm.authorName, '🎮 ' + nm.authorName + ' publicó un ' + kindWord(nm) + ' nuevo', nm.name);
    }
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, err:e.message }); }
});

// ── Migrar el id de un juego propio (los ids viejos eran un contador por navegador y se repetían entre cuentas) ──
app.post('/api/maps/:id/migrate-id', requireAuth, (req, res) => {
  const oldId = req.params.id, old = DB.maps[oldId];
  if (!old) return res.status(404).json({ ok:false, err:'No existe en el servidor' });
  if (old.authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ ok:false, err:'No podés migrar este juego' });
  const newId = String((req.body && req.body.newId) || '');
  if (!MAP_ID_RE.test(newId) || newId === oldId || DB.maps[newId]) return res.status(400).json({ ok:false, err:'Id nuevo inválido o en uso' });
  DB.maps[newId] = { ...old, id:newId, assetsId: old.assetsId || oldId };   // texturas y sonidos se quedan donde están
  delete DB.maps[oldId];
  for (const k of ['appData', 'appScores', 'datastores']) if (DB[k] && DB[k][oldId]) { DB[k][newId] = DB[k][oldId]; delete DB[k][oldId]; }
  saveDB();
  io.emit('map_deleted', { mapId: oldId });
  io.emit('map_updated', { mapId: newId });
  res.json({ ok:true, id:newId });
});

// ── DELETE mapa ──
app.delete('/api/maps/:id', async (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para borrar juegos' });
  const existing = DB.maps[req.params.id];
  if (!existing) { try { await persist.flush(5000); } catch (_) {} return res.json({ ok:true }); }   // ya no está: se asegura que lo pendiente llegue al bucket
  if (existing.authorId !== user.id && !user.isAdmin)
    return res.status(403).json({ ok:false, err:'No podés borrar este juego' });
  const aid = assetId(req.params.id);
  delete DB.maps[req.params.id];
  dbSync.tombstone('maps', req.params.id);
  if (DB.appData) delete DB.appData[req.params.id];
  if (DB.appScores) delete DB.appScores[req.params.id];
  scriptDataStore.removeMap(req.params.id);
  if (MAP_ID_RE.test(aid)) { try { fs.rmSync(texDir(aid), { recursive:true, force:true }); } catch {} persist.delPrefix(`textures/${aid}/`); try { fs.rmSync(soundDir(aid), { recursive:true, force:true }); } catch {} persist.delPrefix(`sounds/${aid}/`); }
  // Borrar es definitivo: se guarda YA (no «en unos segundos») y se espera a que la base nueva llegue al bucket antes de confirmar.
  // Antes se confirmaba enseguida y el guardado quedaba agendado; si el servidor se reiniciaba antes, arrancaba con la base vieja del
  // bucket y el juego «se restauraba solo».
  saveDBNow();
  io.emit('map_deleted', { mapId: req.params.id });
  try { await persist.flush(10000); } catch (_) {}
  res.json({ ok:true });
});

app.post('/api/maps/:id/like', requireAuth, (req, res) => {
  const map = DB.maps[req.params.id];
  if (!map || !canReadMap(map, req.user)) return res.status(404).json({ ok:false });
  map.likedBy = map.likedBy || [];
  const index = map.likedBy.indexOf(req.user.id);
  const liked = index < 0;
  if (liked) map.likedBy.push(req.user.id); else map.likedBy.splice(index, 1);
  map.likes = map.likedBy.length;
  req.user.liked = req.user.liked || [];
  req.user.liked = liked ? [...new Set([...req.user.liked, map.id])] : req.user.liked.filter(id => id !== map.id);
  saveDB();
  io.emit('map_stats', { mapId:map.id, likes:map.likes, plays:map.plays || 0 });   // liviano: nadie vuelve a bajar el catálogo por un like
  if (liked) notifyActivity(map.authorId, { kind:'game', id:map.id, from:req.user.id, fromName:req.user.username, title:'❤️ A ' + req.user.username + ' le gustó tu ' + kindWord(map), body:map.name, tag:'like-' + map.id });
  toUser(req.user.id).emit('user_updated', { userId:req.user.id });               // tus otros dispositivos actualizan tus favoritos
  res.json({ ok:true, liked, likes:map.likes });
});

// Hilos de comentarios: lista plana con parentId (null = comentario raíz). Sin límite de profundidad.
function cmtDescendants(list, id) {
  const ids = new Set([id]); let grew = true;
  while (grew) { grew = false; for (const x of list) if (x.parentId && ids.has(x.parentId) && !ids.has(x.id)) { ids.add(x.id); grew = true; } }
  return ids;
}
// ── Comentarios de juegos y apps ──
// Se guardan en el propio juego (map.comments). Para leerlos o comentar hay que poder abrir el juego (privacidad y +18).
const commentHits = new Map();   // userId → última hora de comentario (anti-spam)
function commentable(req, res) {
  const map = DB.maps[req.params.id];
  if (!map || !canReadMap(map, req.user || null)) { res.status(404).json({ ok:false, err:'Juego no encontrado' }); return null; }
  if (!canEnterAdult(map, req.user || null)) { ageRequired(res); return null; }
  return map;
}
app.get('/api/maps/:id/comments', (req, res) => {
  req.user = readSession(req);
  const map = commentable(req, res); if (!map) return;
  res.json({ ok:true, comments: Array.isArray(map.comments) ? map.comments : [] });
});
app.post('/api/maps/:id/comments', requireAuth, (req, res) => {
  const map = commentable(req, res); if (!map) return;
  const text = String(req.body?.text ?? req.body?.comment ?? '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ ok:false, err:'El comentario está vacío' });
  const now = Date.now();
  if (now - (commentHits.get(req.user.id) || 0) < 1500) return res.status(429).json({ ok:false, err:'Esperá un momento antes de comentar de nuevo' });
  commentHits.set(req.user.id, now);
  map.comments = Array.isArray(map.comments) ? map.comments : [];
  const parentId = String(req.body?.parentId || '') || null;
  const parent = parentId ? map.comments.find(x => x.id === parentId) : null;
  if (parentId && !parent) return res.status(404).json({ ok:false, err:'El comentario que querés responder ya no existe' });
  const comment = { id:`c${crypto.randomUUID()}`, parentId, authorId:req.user.id, authorName:req.user.username, text, created:new Date().toISOString() };
  map.comments.push(comment);
  saveDB();
  io.emit('map_comment', { mapId:map.id, comment });
  if (parent && parent.authorId !== req.user.id) notifyActivity(parent.authorId, { kind:'game', id:map.id, from:req.user.id, fromName:req.user.username, title:'↩️ ' + req.user.username + ' respondió tu comentario en ' + map.name, body:text, tag:'cmt-' + map.id });
  if (map.authorId !== req.user.id && (!parent || parent.authorId !== map.authorId)) notifyActivity(map.authorId, { kind:'game', id:map.id, from:req.user.id, fromName:req.user.username, title:'💬 ' + req.user.username + ' comentó en ' + map.name, body:text, tag:'cmt-' + map.id });
  res.json({ ok:true, comment });
});
app.delete('/api/maps/:id/comments/:cid', requireAuth, (req, res) => {
  const map = DB.maps[req.params.id];
  if (!map) return res.status(404).json({ ok:false });
  const c = (map.comments || []).find(x => x.id === req.params.cid);
  if (!c) return res.json({ ok:true });
  if (c.authorId !== req.user.id && map.authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ ok:false, err:'No podés borrar este comentario' });
  const gone = cmtDescendants(map.comments, c.id);   // borrar un comentario borra todo su hilo de respuestas
  map.comments = map.comments.filter(x => !gone.has(x.id));
  saveDB();
  io.emit('map_comment', { mapId:map.id, removed:c.id, removedIds:[...gone] });
  res.json({ ok:true });
});

app.post('/api/maps/:id/play', (req, res) => {
  const map = DB.maps[req.params.id], viewer = readSession(req);
  if (!map || !canReadMap(map, viewer)) return res.status(404).json({ ok:false });
  if (!canEnterAdult(map, viewer)) return ageRequired(res);
  map.plays = (map.plays || 0) + 1;
  saveDB();
  io.emit('map_stats', { mapId:map.id, likes:map.likes || 0, plays:map.plays });
  res.json({ ok:true, plays:map.plays });
});

// ── Claves públicas y bóveda privada cifrada del chat E2EE ──
app.get('/api/e2ee/keys/:id', (req, res) => {
  const target = DB.users[req.params.id];
  if (!target) return res.status(404).json({ ok:false, err:'Usuario no encontrado' });
  const viewer = readSession(req);
  res.json({
    ok:true,
    publicKey:target.e2eePublicKey || null,
    vault:viewer?.id === target.id ? (target.e2eeVault || null) : undefined
  });
});

app.post('/api/e2ee/keys', requireAuth, (req, res) => {
  const { publicKey, vault } = req.body || {};
  const isBase64 = value => typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
  if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(publicKey.x || '') || !/^[A-Za-z0-9_-]{43}$/.test(publicKey.y || '') ||
      !vault || vault.v !== 1 || !isBase64(vault.salt) ||
      !isBase64(vault.iv) || !isBase64(vault.ciphertext) ||
      !Number.isInteger(vault.iterations) || vault.iterations < 100000 || vault.iterations > 1000000 ||
      Buffer.from(vault.salt, 'base64').length !== 16 || Buffer.from(vault.iv, 'base64').length !== 12 ||
      vault.ciphertext.length > 8192)
    return res.status(400).json({ ok:false, err:'Formato de clave cifrada inválido' });
  if (req.user.e2eePublicKey || req.user.e2eeVault)
    return res.status(409).json({ ok:false, err:'Esta cuenta ya tiene claves cifradas configuradas' });
  req.user.e2eePublicKey = { kty:'EC', crv:'P-256', x:publicKey.x, y:publicKey.y, ext:true, key_ops:[] };
  req.user.e2eeVault = { v:1, salt:vault.salt, iv:vault.iv, ciphertext:vault.ciphertext, iterations:vault.iterations };
  saveDB();
  res.json({ ok:true, publicKey:req.user.e2eePublicKey });
});

// ── GET una conversación cifrada de la cuenta autenticada ──
app.get('/api/convs/:userId/:convId', (req, res) => {
  const uid = req.params.userId;
  const convId = req.params.convId;
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
  const members = convId.split('_');
  if (user.id !== uid || members.length !== 2 || !members.includes(uid))
    return res.status(403).json({ ok:false, err:'No podés leer esta conversación' });
  const messages = Array.isArray(DB.convs[convId]) ? DB.convs[convId].filter(message => message?.e2ee?.v === 1) : [];
  res.json({ ok:true, messages });
});

// ── POST mensaje ──
app.post('/api/convs/:convId', (req, res) => {
  try {
    const { convId } = req.params;
    const user = readSession(req);
    const members = convId.split('_');
    if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
    if (members.length !== 2 || new Set(members).size !== 2 || convId !== [...members].sort().join('_') || !members.includes(user.id))
      return res.status(403).json({ ok:false, err:'No pertenecés a esta conversación' });
    const { msg } = req.body;
    if (!msg || typeof msg.id !== 'string' || msg.id.length > 100 || msg.from !== user.id ||
        msg.e2ee?.v !== 1 || typeof msg.e2ee.salt !== 'string' ||
        typeof msg.e2ee.peer?.iv !== 'string' || typeof msg.e2ee.peer?.ciphertext !== 'string' ||
        typeof msg.e2ee.self?.iv !== 'string' || typeof msg.e2ee.self?.ciphertext !== 'string')
      return res.status(400).json({ ok:false, err:'El chat solo acepta mensajes E2EE' });
    const isBase64 = value => typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
    if (!isBase64(msg.e2ee.salt) || Buffer.from(msg.e2ee.salt,'base64').length !== 16 ||
        !isBase64(msg.e2ee.peer.iv) || Buffer.from(msg.e2ee.peer.iv,'base64').length !== 12 ||
        !isBase64(msg.e2ee.self.iv) || Buffer.from(msg.e2ee.self.iv,'base64').length !== 12 ||
        !isBase64(msg.e2ee.peer.ciphertext) || !isBase64(msg.e2ee.self.ciphertext))
      return res.status(400).json({ ok:false, err:'Sobre E2EE incompleto o inválido' });
    if (JSON.stringify(msg.e2ee).length > 45 * 1024 * 1024)
      return res.status(413).json({ ok:false, err:'El adjunto cifrado supera el límite del chat' });
    if (!areFriends(members[0], members[1]))
      return res.status(403).json({ ok:false, err:'Solo podés escribirle a tus amigos' });
    if (!DB.users[members[0]]?.e2eePublicKey || !DB.users[members[1]]?.e2eePublicKey)
      return res.status(409).json({ ok:false, err:'Ambas cuentas deben activar el chat cifrado iniciando sesión' });
    const encryptedMessage = {
      id:msg.id,
      from:user.id,
      t:Number.isFinite(msg.t) ? msg.t : Date.now(),
      e2ee:{ v:1, salt:msg.e2ee.salt, peer:msg.e2ee.peer, self:msg.e2ee.self }
    };
    DB.convs[convId] = DB.convs[convId] || [];
    if (!DB.convs[convId].some(existing => existing.id === encryptedMessage.id))
      DB.convs[convId].push(encryptedMessage);
    saveDB();
    // Notificar en tiempo real
    emitMembers(convId, 'new_private_msg', { convId, msg:encryptedMessage });
    convId.split('_').forEach(uid => {
      // El contenido va cifrado de punta a punta: el aviso no puede incluir el texto.
      if (uid !== user.id) notifyPush(uid, {
        type:'message', from:user.id, fromName:user.username, convId,
        tag:'msg-' + convId, url:'/?n=message&u=' + encodeURIComponent(user.id)
      }, { ttl:24 * 3600, urgency:'high', topic:'msg' + String(user.id).slice(0,24) });
    });
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, err:e.message }); }
});

// ── SOLICITUDES DE AMISTAD ──
app.post('/api/friend-request', (req, res) => {
  try {
    const user = readSession(req);
    if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
    const fromId = user.id;
    const { toId } = req.body;
    if (!fromId || !toId || fromId === toId) return res.json({ok:false,err:'IDs inválidos'});
    const from = DB.users[fromId]; const to = DB.users[toId];
    if (!from || !to) return res.json({ok:false,err:'Usuario no encontrado'});
    if ((from.friends || []).includes(toId)) return res.status(409).json({ok:false,err:'Ya son amigos'});
    // No duplicar solicitudes
    to.friendRequests_recv = to.friendRequests_recv || [];
    from.friendRequests_sent = from.friendRequests_sent || [];
    if (!to.friendRequests_recv.includes(fromId)) to.friendRequests_recv.push(fromId);
    if (!from.friendRequests_sent.includes(toId)) from.friendRequests_sent.push(toId);
    DB.users[fromId] = from; DB.users[toId] = to; saveDB();
    // Notificar en tiempo real si está online
    toUser(toId).emit('friend_request', { from:from.id, fromName:from.username });
    toUser(fromId).emit('user_updated', { userId:fromId });   // tus otros dispositivos ven la solicitud enviada
    notifyPush(toId, { type:'friend_request', from:from.id, fromName:from.username, tag:'friend-' + from.id, url:'/?n=friend_request' }, { ttl:7 * 24 * 3600 });
    res.json({ok:true});
  } catch(e) { res.json({ok:false,err:e.message}); }
});

app.post('/api/friend-accept', (req, res) => {
  try {
    const user = readSession(req);
    if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
    const { fromId } = req.body; // from=quien mandó; el usuario autenticado acepta.
    const toId = user.id;
    if (!fromId) return res.json({ok:false,err:'IDs inválidos'});
    const from = DB.users[fromId]; const to = DB.users[toId];
    if (!from || !to) return res.json({ok:false,err:'Usuario no encontrado'});
    if (!(to.friendRequests_recv || []).includes(fromId)) return res.status(403).json({ok:false,err:'No hay una solicitud pendiente'});
    // Agregar como amigos mutuamente
    from.friends = from.friends||[]; to.friends = to.friends||[];
    if (!from.friends.includes(toId)) from.friends.push(toId);
    if (!to.friends.includes(fromId)) to.friends.push(fromId);
    // Limpiar solicitudes
    to.friendRequests_recv = (to.friendRequests_recv||[]).filter(id=>id!==fromId);
    from.friendRequests_sent = (from.friendRequests_sent||[]).filter(id=>id!==toId);
    DB.users[fromId]=from; DB.users[toId]=to; saveDB();
    // Notificar a ambos
    toUser(fromId).emit('friend_accepted', { from:to.id, fromName:to.username });
    notifyPush(fromId, { type:'friend_accepted', from:to.id, fromName:to.username, tag:'friend-ok-' + to.id, url:'/?n=friend_accepted&u=' + encodeURIComponent(to.id) }, { ttl:7 * 24 * 3600 });
    io.emit('user_updated', {userId:fromId}); io.emit('user_updated', {userId:toId});
    res.json({ok:true});
  } catch(e) { res.json({ok:false,err:e.message}); }
});

app.post('/api/friend-reject', (req, res) => {
  try {
    const user = readSession(req);
    if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
    const { fromId } = req.body;
    const toId = user.id;
    if (!(DB.users[toId]?.friendRequests_recv || []).includes(fromId))
      return res.status(403).json({ok:false,err:'No hay una solicitud pendiente'});
    const from = DB.users[fromId]; const to = DB.users[toId];
    if (from) { from.friendRequests_sent=(from.friendRequests_sent||[]).filter(id=>id!==toId); DB.users[fromId]=from; }
    if (to)   { to.friendRequests_recv=(to.friendRequests_recv||[]).filter(id=>id!==fromId);   DB.users[toId]=to;   }
    saveDB();
    // Ambas cuentas (en todos sus dispositivos) actualizan sus solicitudes pendientes.
    toUser(toId).emit('user_updated', { userId:toId }); toUser(fromId).emit('user_updated', { userId:fromId });
    res.json({ok:true});
  } catch(e) { res.json({ok:false,err:e.message}); }
});

// ── VIDEOS ──
app.get('/api/videos', (req, res) => {
  const user = readSession(req);
  const vids = (DB.videos || []).filter(v => canReadVideo(v, user) && (v.ready !== false || (user && v.authorId === user.id)));
  res.json({ ok: true, videos: vids.map(publicVideo) });
});

// Compatibilidad con clientes viejos: devuelve el archivo como data URL (solo videos chicos).
app.get('/api/videos/:id/data', async (req, res) => {
  const v = await findVideoReady(req.params.id), viewer = readSession(req);
  if (!v || !canReadVideo(v, viewer)) return res.status(404).json({ ok: false });
  if (!canEnterAdult(v, viewer)) return ageRequired(res);
  const file = await videoLocalFile(v);
  if (!file) return res.status(404).json({ ok:false, err:'El archivo del video no está disponible' });
  if (v.size > 25 * 1024 * 1024) return res.status(413).json({ ok:false, err:'Usá /stream para videos grandes', stream:`/api/videos/${v.id}/stream` });
  res.json({ ok: true, data: `data:${v.mime};base64,${fs.readFileSync(file).toString('base64')}`, thumb: v.thumb, ...thumbLabel(v) });
});

// Reproducción por streaming (con soporte de rangos para adelantar/retroceder).
// El <video> no puede enviar encabezados, por eso el token de sesión también se acepta por ?t= (solo aquí).
app.get('/api/videos/:id/stream', async (req, res) => {
  const v = await findVideoReady(req.params.id);
  const user = readSession(req) || userFromToken(req.query.t);
  if (!v || !canReadVideo(v, user)) return res.status(404).end();
  if (!canEnterAdult(v, user)) return res.status(403).end();
  const file = await videoLocalFile(v);
  if (!file) return res.status(404).end();
  res.set({ 'Content-Type': v.mime || 'video/mp4', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': (v.privacy || 'public') === 'public' ? 'public, max-age=3600' : 'private, max-age=600' });
  res.sendFile(file, { acceptRanges: true, dotfiles: 'allow' }, err => { if (err && !res.headersSent) res.status(err.status || 500).end(); });
});

// Permiso de descarga de un video para verlo sin conexión (el archivo se baja luego por /stream).
app.get('/api/videos/:id/offline-pack', async (req, res) => {
  const v = await findVideoReady(req.params.id), viewer = readSession(req) || userFromToken(req.query.t);
  if (!v || !canReadVideo(v, viewer)) return res.status(404).json({ ok:false, err:'Video no encontrado' });
  if (!canEnterAdult(v, viewer)) return ageRequired(res);
  if (!mayDownload(v, viewer)) return res.status(403).json({ ok:false, code:'DOWNLOAD_NOT_ALLOWED', err:'Su creador no permitió descargar esta creación' });
  res.json({ ok:true, video:publicVideo(v), url:`/api/videos/${encodeURIComponent(v.id)}/stream`, size:Number(v.size) || 0 });
});
// Un admin corrige el nivel de la miniatura de un juego.
app.post('/api/admin/maps/:id/thumb-level', requireAuth, requireAdmin, (req, res) => {
  const m = DB.maps[req.params.id];
  if (!m) return res.status(404).json({ ok:false, err:'Juego no encontrado' });
  const n = Number(req.body && req.body.level);
  if (!Number.isInteger(n) || n < 0 || n > 3) return res.status(400).json({ ok:false, err:'Nivel inválido (0 a 3)' });
  m.thumbLevel = n; saveDB();
  io.emit('map_updated', { mapId:m.id });
  console.log(`[THUMB] ${req.user.username} puso la miniatura del juego ${m.id} en nivel ${n}`);
  res.json({ ok:true, level:n });
});
// Un admin corrige el nivel de una miniatura (p. ej. tras una denuncia o si el creador declaró de menos).
app.post('/api/admin/videos/:id/thumb-level', requireAuth, requireAdmin, (req, res) => {
  const v = (DB.videos || []).find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ ok:false, err:'Video no encontrado' });
  const n = Number(req.body && req.body.level);
  if (!Number.isInteger(n) || n < 0 || n > 3) return res.status(400).json({ ok:false, err:'Nivel inválido (0 a 3)' });
  v.thumbLevel = n; saveDB();
  io.emit('video_updated', { id:v.id, refetch:true });
  console.log(`[THUMB] ${req.user.username} puso la miniatura de ${v.id} en nivel ${n}`);
  res.json({ ok:true, level:n });
});

app.post('/api/videos', async (req, res) => {
  try {
    const user = readSession(req);
    if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para publicar' });
    const v = req.body;
    if (!v || !v.id || !v.title) return res.json({ ok: false, err: 'Faltan campos' });
    if (!VIDEO_ID_RE.test(String(v.id))) return res.status(400).json({ ok:false, err:'Identificador de video inválido' });
    DB.videos = DB.videos || [];
    const idx = DB.videos.findIndex(x => x.id === v.id);
    if (idx < 0 && rejectIfDeleted(res, 'videos', v.id)) return;
    if (idx >= 0 && DB.videos[idx].authorId !== user.id && !user.isAdmin)
      return res.status(403).json({ ok:false, err:'No podés editar este contenido' });
    const old = idx >= 0 ? DB.videos[idx] : null;
    // Clasificación del video ENTERO: obligatoria para subir uno nuevo. Si el contenido es ilegal, no se sube.
    let cls = old?.classification;
    if (!old || (v.classification && typeof v.classification === 'object')) {
      const ev = classification.evaluate({ ...(v.classification || {}), kind:'video' }, 'es');
      if (ev.ok) cls = ev.result;
      else if (!old || ev.code === 'ILLEGAL_CONTENT' || ev.code === 'KIDS_CONFLICT') return res.status(422).json({ ok:false, code:v.classification ? ev.code : 'CLASSIFICATION_REQUIRED', err:v.classification ? ev.err : 'Antes de subir un video tenés que completar el cuestionario de clasificación.', reasons:ev.reasons });
    }
    const privacy = ['public','private'].includes(v.privacy) ? v.privacy : 'public';
    const thumb = typeof v.thumb === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(v.thumb) && v.thumb.length <= 2000000 ? v.thumb : (old?.thumb || null);
    // Nivel de la miniatura: lo declara el creador; si no viene, se conserva el anterior (o 0).
    const thumbLevel = v.thumbLevel === undefined ? thumbLevelOf(old) : thumbLevelOf(v);
    if (thumb && Number(cls?.age ?? 0) < THUMB_MIN_AGE[thumbLevel])
      return res.status(422).json({ ok:false, code:'THUMB_CONFLICT', err:`Una miniatura con ese contenido solo puede acompañar a videos clasificados ${THUMB_MIN_AGE[thumbLevel]}+. Cambiá la miniatura o la clasificación del video.` });
    const saved = {
      ...(old || {}), thumbLevel, id:String(v.id), title:String(v.title).slice(0,120), desc:String(v.desc || '').slice(0,2000), cat:String(v.cat || 'otros').slice(0,30),
      authorId: old?.authorId || user.id, authorName: old?.authorName || user.username, privacy, thumb, allowDownload: v.allowDownload === undefined ? old?.allowDownload === true : v.allowDownload === true, ...(cls ? { classification: cls } : {}),
      views: old?.views || 0, likes: old?.likes || [], comments: old?.comments || [], created: old?.created || v.created || new Date().toISOString()
    };
    const wasReady = !!old?.ready;
    if (typeof v.data === 'string' && v.data !== '[data]') {   // compatibilidad: archivo embebido en base64
      const buf = dataUrlToBuffer(v.data);
      if (!buf) return res.status(400).json({ ok:false, err:'Archivo de video inválido' });
      let upload; try { upload = storeVideoBuffer(saved, buf); } catch (err) { return res.status(400).json({ ok:false, err:err.message }); }
      await settleUpload(upload);
    } else if (!old) saved.ready = false;                       // el archivo llega después con PUT /file
    if (idx >= 0) DB.videos[idx] = saved; else DB.videos.push(saved);
    saveDB();
    if (!old && persist.enabled) { try { await persist.flush(8000); } catch {} }   // que otra instancia ya pueda ver el video cuando llegue el PUT del archivo
    const becamePublic = !!old && (old.privacy !== 'public' || !old.classification) && saved.privacy === 'public' && !!saved.classification;
    if (saved.ready && (!wasReady || becamePublic) && videoIsPublic(saved)) announceNew('video', saved, saved.authorId, saved.authorName, '🎬 ' + saved.authorName + ' subió un video', saved.title);
    if (saved.ready && (!wasReady || becamePublic) && videoIsPublic(saved)) io.emit('video_new', { id: saved.id, title: saved.title, authorId: saved.authorId, authorName: saved.authorName, cat: saved.cat, thumb: saved.thumb, ...thumbLabel(saved), created: saved.created, privacy: saved.privacy });
    else if (old) io.emit('video_updated', { id: saved.id, refetch:true });   // título, descripción, miniatura o privacidad (si pasó a privado, el resto lo deja de ver)
    else toUser(saved.authorId).emit('video_updated', { id: saved.id, refetch:true });   // borrador: sus otros dispositivos lo ven mientras sube
    res.json({ ok: true, ready: !!saved.ready });
  } catch(e) { res.json({ ok: false, err: e.message }); }
});

// Subida binaria del archivo (sin base64: más rápido y sin inflar 33 %).
app.put('/api/videos/:id/file', async (req, res) => {
  let tmp = null;
  try {
    const user = readSession(req);
    if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para publicar' });
    const video = await findVideoFresh(req.params.id);
    if (!video) return res.status(404).json({ ok:false, err:'Primero creá el video' });
    if (video.authorId !== user.id && !user.isAdmin) return res.status(403).json({ ok:false, err:'No podés editar este contenido' });
    if (!VIDEO_ID_RE.test(String(video.id))) return res.status(400).json({ ok:false, err:'Identificador de video inválido' });
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_VIDEO_BYTES) return res.status(413).json({ ok:false, err:'El video supera el máximo de ' + Math.round(MAX_VIDEO_BYTES / 1048576) + ' MB' });
    fs.mkdirSync(VIDEO_DIR, { recursive:true });
    tmp = path.join(VIDEO_DIR, `${video.id}.${Date.now()}.part`);
    const size = await streamToFile(req, tmp, MAX_VIDEO_BYTES);
    const tmpToClean = tmp; tmp = null;   // finalizeVideoUpload se encarga del archivo temporal desde acá
    res.json(await finalizeVideoUpload(video, tmpToClean, size));
  } catch (e) {
    if (tmp) { try { fs.rmSync(tmp, { force:true }); } catch {} }
    if (!res.headersSent) res.status(e.status || (e.code === 'TOO_BIG' ? 413 : 500)).json({ ok:false, err:e.message });
  }
});

// Valida el archivo temporal ya completo, lo deja como definitivo, lo copia al bucket y avisa a los clientes.
async function finalizeVideoUpload(video, tmp, size) {
  const bad = (status, msg) => { try { fs.rmSync(tmp, { force:true }); } catch {} const e = new Error(msg); e.status = status; return e; };
  try {
    if (!size) throw bad(400, 'Archivo vacío');
    const head = Buffer.alloc(16); const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
    const mime = sniffVideo(head);
    if (!mime) throw bad(400, 'Formato no soportado. Usá MP4, WebM u OGG.');
    const wasReady = !!video.ready, oldPath = videoFilePath(video), file = `${video.id}.${VIDEO_EXT[mime]}`;
    fs.renameSync(tmp, path.join(VIDEO_DIR, file));
    if (oldPath && path.basename(oldPath) !== file) { try { fs.unlinkSync(oldPath); } catch {} persist.delKey('videos/' + path.basename(oldPath)); }
    if (!(DB.videos || []).includes(video)) {   // lo borraron mientras se subía el archivo: no se deja huérfano ni se avisa
      try { fs.unlinkSync(path.join(VIDEO_DIR, file)); } catch {}
      return { ok:false, err:'El video fue eliminado' };
    }
    video.file = file; video.mime = mime; video.size = size; video.ready = true; delete video.data;
    await settleUpload(persist.putFile('videos/' + file, path.join(VIDEO_DIR, file)));
    saveDB();
    if (!wasReady && videoIsPublic(video)) announceNew('video', video, video.authorId, video.authorName, '🎬 ' + video.authorName + ' subió un video', video.title);
    if (!wasReady && videoIsPublic(video)) io.emit('video_new', { id: video.id, title: video.title, authorId: video.authorId, authorName: video.authorName, cat: video.cat, thumb: video.thumb, ...thumbLabel(video), created: video.created, privacy: video.privacy });
    else emitVideoEvent(video, 'video_updated', { id: video.id, refetch:true });   // privado: aparece en los dispositivos del autor; archivo reemplazado: todos
    return { ok:true, size:video.size, mime:video.mime };
  } catch (e) { try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force:true }); } catch {} throw e; }
}

// Subida por partes: el cliente manda trozos chicos (cada PUT dura segundos, así ningún proxy los corta) y al final pide ensamblar.
// Cada parte se escribe en su posición (offset), por eso reintentar una parte es seguro.
const CHUNK_MAX = 32 * 1024 * 1024;
const UPLOAD_ID_RE = /^[A-Za-z0-9]{6,40}$/;
async function chunkContext(req, res) {
  const user = readSession(req);
  if (!user) { res.status(401).json({ ok:false, err:'Iniciá sesión para publicar' }); return null; }
  const video = await findVideoFresh(req.params.id);
  if (!video) { res.status(404).json({ ok:false, err:'Primero creá el video' }); return null; }
  if (video.authorId !== user.id && !user.isAdmin) { res.status(403).json({ ok:false, err:'No podés editar este contenido' }); return null; }
  if (!VIDEO_ID_RE.test(String(video.id)) || !UPLOAD_ID_RE.test(String(req.query.u || ''))) { res.status(400).json({ ok:false, err:'Parámetros inválidos' }); return null; }
  fs.mkdirSync(VIDEO_DIR, { recursive:true });
  return { video, tmp: path.join(VIDEO_DIR, `${video.id}.${req.query.u}.part`) };
}
app.put('/api/videos/:id/chunk', async (req, res) => {
  try {
    const ctx = await chunkContext(req, res); if (!ctx) return;
    const offset = Number(req.query.o);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= MAX_VIDEO_BYTES) return res.status(400).json({ ok:false, err:'Posición inválida' });
    if (Number(req.headers['content-length']) > CHUNK_MAX) return res.status(413).json({ ok:false, err:'Parte demasiado grande' });
    if (offset === 0) fs.rmSync(ctx.tmp, { force:true });
    else if (!fs.existsSync(ctx.tmp)) return res.status(409).json({ ok:false, err:'Falta el inicio de la subida (¿otra instancia del servidor?)', restart:true });
    const n = await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(ctx.tmp, { flags: fs.existsSync(ctx.tmp) ? 'r+' : 'w', start: offset });
      let bytes = 0, done = false;
      const fail = err => { if (done) return; done = true; try { req.unpipe(ws); } catch {} ws.destroy(); reject(err); };
      req.on('data', c => { bytes += c.length; if (bytes > CHUNK_MAX || offset + bytes > MAX_VIDEO_BYTES) { const e = new Error('El archivo supera el máximo permitido'); e.status = 413; fail(e); } });
      req.on('error', fail); req.on('aborted', () => fail(new Error('Subida cancelada')));
      ws.on('error', fail); ws.on('finish', () => { if (!done) { done = true; resolve(bytes); } });
      req.pipe(ws);
    });
    res.json({ ok:true, received:n });
  } catch (e) { if (!res.headersSent) res.status(e.status || 500).json({ ok:false, err:e.message }); }
});
app.post('/api/videos/:id/finish', async (req, res) => {
  try {
    const ctx = await chunkContext(req, res); if (!ctx) return;
    if (!fs.existsSync(ctx.tmp)) return res.status(409).json({ ok:false, err:'No llegaron las partes del video (¿otra instancia del servidor?)', restart:true });
    const size = fs.statSync(ctx.tmp).size, expected = Number(req.query.size);
    if (expected !== size) return res.status(409).json({ ok:false, err:`Subida incompleta: llegaron ${size} de ${expected} bytes`, restart:true });
    res.json(await finalizeVideoUpload(ctx.video, ctx.tmp, size));
  } catch (e) { if (!res.headersSent) res.status(e.status || 500).json({ ok:false, err:e.message }); }
});
// Limpieza de subidas abandonadas (partes sueltas de más de 6 h).
setInterval(() => { try { for (const f of fs.readdirSync(VIDEO_DIR)) if (f.endsWith('.part')) { const p = path.join(VIDEO_DIR, f); if (Date.now() - fs.statSync(p).mtimeMs > 6 * 3600 * 1000) fs.rmSync(p, { force:true }); } } catch {} }, 3600 * 1000).unref();

app.post('/api/videos/:id/like', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
  const v = (DB.videos || []).find(x => x.id === req.params.id);
  if (!v || !canReadVideo(v, user)) return res.status(404).json({ ok: false });
  v.likes = v.likes || [];
  const idx = v.likes.indexOf(user.id);
  const liked = idx === -1;
  if (liked) v.likes.push(user.id); else v.likes.splice(idx, 1);
  saveDB();
  emitVideoEvent(v, 'video_updated', { id:v.id, likes:v.likes });
  if (liked) notifyActivity(v.authorId, { kind:'video', id:v.id, from:user.id, fromName:user.username, title:'❤️ A ' + user.username + ' le gustó tu video', body:v.title, tag:'like-' + v.id });
  res.json({ ok: true, liked, likes: v.likes.length });
});

app.post('/api/videos/:id/view', (req, res) => {
  const video = (DB.videos || []).find(x => x.id === req.params.id);
  if (!video || !canReadVideo(video, readSession(req))) return res.status(404).json({ ok:false });
  video.views = (video.views || 0) + 1;
  saveDB();
  emitVideoEvent(video, 'video_updated', { id:video.id, views:video.views });
  res.json({ ok:true, views:video.views });
});

app.post('/api/videos/:id/comment', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
  const v = (DB.videos || []).find(x => x.id === req.params.id);
  if (!v || !canReadVideo(v, user)) return res.status(404).json({ ok: false });
  v.comments = v.comments || [];
  const text = String(req.body.comment?.text || req.body.comment || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ ok:false, err:'El comentario está vacío' });
  const parentId = String(req.body.parentId || '') || null;
  const parent = parentId ? v.comments.find(x => x.id === parentId) : null;
  if (parentId && !parent) return res.status(404).json({ ok:false, err:'El comentario que querés responder ya no existe' });
  const comment = { id:`c${crypto.randomUUID()}`, parentId, authorId:user.id, authorName:user.username, text, created:new Date().toISOString() };
  v.comments.push(comment);
  saveDB();
  emitVideoEvent(v, 'video_updated', { id:v.id, comment });
  if (parent && parent.authorId !== user.id) notifyActivity(parent.authorId, { kind:'video', id:v.id, from:user.id, fromName:user.username, title:'↩️ ' + user.username + ' respondió tu comentario', body:text, tag:'cmt-' + v.id });
  if (v.authorId !== user.id && (!parent || parent.authorId !== v.authorId)) notifyActivity(v.authorId, { kind:'video', id:v.id, from:user.id, fromName:user.username, title:'💬 ' + user.username + ' comentó tu video', body:text, tag:'cmt-' + v.id });
  res.json({ ok: true, comment });
});
app.delete('/api/videos/:id/comments/:cid', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
  const v = (DB.videos || []).find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ ok:false });
  const c = (v.comments || []).find(x => x.id === req.params.cid);
  if (!c) return res.json({ ok:true });
  if (c.authorId !== user.id && v.authorId !== user.id && !user.isAdmin) return res.status(403).json({ ok:false, err:'No podés borrar este comentario' });
  const gone = cmtDescendants(v.comments, c.id);   // borra también todas las respuestas
  v.comments = v.comments.filter(x => !gone.has(x.id));
  saveDB();
  emitVideoEvent(v, 'video_updated', { id:v.id, refetch:true });
  res.json({ ok:true });
});

app.delete('/api/videos/:id', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
  const video = (DB.videos || []).find(v => v.id === req.params.id);
  if (!video) return res.json({ ok:true });
  if (video.authorId !== user.id && !user.isAdmin)
    return res.status(403).json({ ok:false, err:'No podés borrar este video' });
  DB.videos = DB.videos.filter(v => v.id !== req.params.id);
  dbSync.tombstone('videos', req.params.id);
  { const f = videoFilePath(video); if (f) { try { fs.unlinkSync(f); } catch {} persist.delKey('videos/' + path.basename(f)); } }
  saveDB();
  emitVideoEvent(video, 'video_deleted', { id:req.params.id });
  res.json({ ok:true });
});

// ── POSTS (Foros) ──
app.get('/api/posts', (req, res) => {
  const viewer = readSession(req);
  res.json({ ok: true, posts:(DB.posts || []).filter(p => !p.modHidden || (viewer && (viewer.isAdmin || p.authorId === viewer.id))) });
});

app.post('/api/posts', (req, res) => {
  try {
    const user = readSession(req);
    if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para publicar' });
    const p = req.body;
    if (!p || !p.id) return res.json({ ok: false });
    DB.posts = DB.posts || [];
    const index = DB.posts.findIndex(existing => existing.id === p.id);
    const previous = index >= 0 ? DB.posts[index] : null;
    if (!previous && rejectIfDeleted(res, 'posts', p.id)) return;
    if (previous && previous.authorId !== user.id && !user.isAdmin)
      return res.status(403).json({ ok:false, err:'No podés editar esta publicación' });
    const savedPost = { ...(previous || {}), ...p, authorId:previous?.authorId || user.id, authorName:previous?.authorName || user.username, privacy:'public' };
    if (previous?.modHidden) savedPost.modHidden = true; else delete savedPost.modHidden;
    if (index >= 0) DB.posts[index] = savedPost; else DB.posts.unshift(savedPost);
    saveDB();
    if (previous) io.emit('post_updated', { id: savedPost.id, refetch:true });   // edición: sin aviso de "nuevo post"
    else {
      io.emit('new_post', { id: savedPost.id, authorId: savedPost.authorId, authorName: savedPost.authorName, text: (savedPost.text||'').substring(0,100) });
      for (const u of audienceOf(savedPost.authorId)) notifyActivity(u.id, { kind:'post', id:savedPost.id, from:savedPost.authorId, fromName:savedPost.authorName, title:'📝 ' + savedPost.authorName + ' publicó en el foro', body:savedPost.text || savedPost.title }, { noSocket:true });
    }
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, err: e.message }); }
});

app.delete('/api/posts/:id', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
  const post = (DB.posts || []).find(p => p.id === req.params.id);
  if (post && post.authorId !== user.id && !user.isAdmin)
    return res.status(403).json({ ok:false, err:'No podés borrar esta publicación' });
  DB.posts = (DB.posts || []).filter(p => p.id !== req.params.id);
  if (post) dbSync.tombstone('posts', req.params.id);
  saveDB();
  io.emit('post_deleted', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/posts/:id/like', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
  const p = (DB.posts || []).find(x => x.id === req.params.id);
  if (!p) return res.json({ ok: false });
  p.likes = p.likes || [];
  const idx = p.likes.indexOf(user.id);
  const liked = idx === -1;
  if (liked) p.likes.push(user.id); else p.likes.splice(idx, 1);
  saveDB();
  io.emit('post_updated', { id:p.id, likes:p.likes });
  if (liked) notifyActivity(p.authorId, { kind:'post', id:p.id, from:user.id, fromName:user.username, title:'❤️ A ' + user.username + ' le gustó tu publicación', body:p.text || p.title, tag:'like-' + p.id });
  res.json({ ok: true, liked, likes: p.likes.length });
});

app.post('/api/posts/:id/reply', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
  const p = (DB.posts || []).find(x => x.id === req.params.id);
  if (!p) return res.json({ ok: false });
  p.replies = p.replies || [];
  const text = String(req.body.reply?.text || req.body.reply || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ ok:false, err:'La respuesta está vacía' });
  const reply = { id:`r${crypto.randomUUID()}`, authorId:user.id, authorName:user.username, text, created:new Date().toISOString() };
  p.replies.push(reply);
  saveDB();
  io.emit('post_updated', { id:p.id, reply });
  // Avisa a quien publicó y a quienes ya habían respondido en el hilo.
  const people = new Set([p.authorId, ...p.replies.map(r => r.authorId)]);
  for (const uid of people) notifyActivity(uid, { kind:'post', id:p.id, from:user.id, fromName:user.username, title:'💬 ' + user.username + (uid === p.authorId ? ' respondió tu publicación' : ' también respondió en una publicación'), body:text, tag:'cmt-' + p.id });
  res.json({ ok: true, reply });
});
app.delete('/api/posts/:id/replies/:rid', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
  const p = (DB.posts || []).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ ok:false });
  const r = (p.replies || []).find(x => x.id === req.params.rid);
  if (!r) return res.json({ ok:true });
  if (r.authorId !== user.id && p.authorId !== user.id && !user.isAdmin) return res.status(403).json({ ok:false, err:'No podés borrar esta respuesta' });
  p.replies = p.replies.filter(x => x.id !== r.id);
  saveDB();
  io.emit('post_updated', { id:p.id, refetch:true });
  res.json({ ok:true });
});

// ── MAIL VINCULADO ──
// Para denunciar o apelar hace falta un mail verificado en la cuenta (user.mail = { address, verified, at }). Las respuestas del equipo
// a denuncias y apelaciones se mandan a esa dirección. Nunca sale en perfiles públicos ni en la lista de usuarios.
const { sendReportMail: sendMailRaw, configured: mailConfigured } = require('./report-mail');
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const hasMail = u => !!(u && u.mail && u.mail.verified && u.mail.address);
function maskEmail(a) { const [n, d] = String(a || '').split('@'); return n && d ? n[0] + '***@' + d : ''; }
// Quién es: sesión normal, token de apelación (cuenta baneada) o usuario + contraseña.
function resolveMailUser(req) {
  const b = req.body || {};
  if (b.appealToken) {
    const rec = (DB.appealTokens || {})[tokenHash(String(b.appealToken))];
    return rec && rec.expiresAt > Date.now() ? (DB.users[rec.userId] || null) : null;
  }
  if (b.username && b.pw) {
    const u = Object.values(DB.users).find(x => x.username.toLowerCase() === String(b.username).toLowerCase());
    return u && String(b.pw).length <= 128 && verifyPassword(String(b.pw), u.pw) ? u : null;
  }
  return readSession(req);
}
app.post('/api/email/request', async (req, res) => {
  if (authLimited(req, res)) return;
  try {
    const user = resolveMailUser(req);
    if (!user) return res.status(401).json({ ok:false, err:'No pudimos identificar tu cuenta. Iniciá sesión de nuevo.' });
    const email = String((req.body || {}).email || '').trim().toLowerCase().slice(0, 200);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ ok:false, err:'Ese mail no es válido.' });
    if (!mailConfigured()) return res.status(503).json({ ok:false, err:'El envío de mails no está disponible ahora. Probá más tarde.' });
    const codes = DB.mailCodes || (DB.mailCodes = {}), now = Date.now(), prev = codes[user.id];
    if (prev && now - prev.sentAt < 60 * 1000) return res.status(429).json({ ok:false, err:'Esperá un minuto para pedir otro código.' });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    codes[user.id] = { email, hash:tokenHash(code), expiresAt:now + 15 * 60 * 1000, sentAt:now, tries:0 };
    saveDB();
    try {
      await sendMailRaw({ to:email, subject:'Tu código de verificación de Crix', text:`Hola ${user.username},\n\nTu código para vincular este mail a tu cuenta de Crix es: ${code}\n\nVence en 15 minutos. Si no lo pediste vos, ignorá este mensaje.` });
    } catch (e) {
      delete codes[user.id]; saveDB();
      console.error('[MAIL] no se pudo mandar el código a ' + user.username + ': ' + e.message);
      return res.status(502).json({ ok:false, err:'No pudimos mandar el mail. Revisá que la dirección esté bien.' });
    }
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, err:'No se pudo enviar el código.' }); }
});
app.post('/api/email/verify', (req, res) => {
  if (authLimited(req, res)) return;
  try {
    const user = resolveMailUser(req);
    if (!user) return res.status(401).json({ ok:false, err:'No pudimos identificar tu cuenta. Iniciá sesión de nuevo.' });
    const rec = (DB.mailCodes || {})[user.id], code = String((req.body || {}).code || '').trim();
    if (!rec || rec.expiresAt <= Date.now()) return res.status(400).json({ ok:false, err:'El código venció. Pedí uno nuevo.' });
    if (++rec.tries > 5) { delete DB.mailCodes[user.id]; saveDB(); return res.status(429).json({ ok:false, err:'Demasiados intentos. Pedí un código nuevo.' }); }
    if (rec.hash !== tokenHash(code)) { saveDB(); return res.status(400).json({ ok:false, err:'El código no es correcto.' }); }
    user.mail = { address:rec.email, verified:true, at:new Date().toISOString() };
    delete DB.mailCodes[user.id];
    saveDB();
    log('MAIL', user.username);
    res.json({ ok:true, mail:{ address:user.mail.address, verified:true }, masked:maskEmail(user.mail.address) });
  } catch (e) { res.status(500).json({ ok:false, err:'No se pudo verificar el código.' }); }
});
// ── Idioma de los mails al usuario ──
// Se usa el idioma de Crix de la cuenta (user.prefs.crix_lang); si no hay, el que mande el cliente al apelar; si no, español.
const MAIL_LANGS = ['es','en','pt','fr','de','it'];
const userLang = (u, fallback) => { const l = u && u.prefs && u.prefs.crix_lang; return MAIL_LANGS.includes(l) ? l : (MAIL_LANGS.includes(fallback) ? fallback : 'es'); };
const MAIL_I18N = {
  appealAccepted: {
    es:['Respuesta a tu apelación en Crix · aprobada', n => `Hola ${n},`, 'Revisamos tu apelación y levantamos la suspensión de tu cuenta. Ya podés volver a entrar a Crix.', 'Mensaje del equipo de Crix:', 'Equipo de Crix'],
    en:['Reply to your Crix appeal · approved', n => `Hi ${n},`, 'We reviewed your appeal and lifted your account suspension. You can use Crix again.', 'Message from the Crix team:', 'The Crix team'],
    pt:['Resposta à sua apelação no Crix · aprovada', n => `Olá ${n},`, 'Analisamos sua apelação e levantamos a suspensão da sua conta. Você já pode voltar a usar o Crix.', 'Mensagem da equipe do Crix:', 'Equipe do Crix'],
    fr:['Réponse à ton appel sur Crix · accepté', n => `Salut ${n},`, 'Nous avons examiné ton appel et levé la suspension de ton compte. Tu peux de nouveau utiliser Crix.', 'Message de l’équipe Crix :', 'L’équipe Crix'],
    de:['Antwort auf deinen Crix-Einspruch · angenommen', n => `Hallo ${n},`, 'Wir haben deinen Einspruch geprüft und die Sperre deines Kontos aufgehoben. Du kannst Crix wieder verwenden.', 'Nachricht vom Crix-Team:', 'Das Crix-Team'],
    it:['Risposta al tuo ricorso su Crix · accolto', n => `Ciao ${n},`, 'Abbiamo esaminato il tuo ricorso e revocato la sospensione del tuo account. Puoi tornare a usare Crix.', 'Messaggio del team di Crix:', 'Il team di Crix'],
  },
  appealRejected: {
    es:['Respuesta a tu apelación en Crix · rechazada', n => `Hola ${n},`, 'Revisamos tu apelación y por ahora mantenemos la suspensión de tu cuenta.', 'Mensaje del equipo de Crix:', 'Equipo de Crix'],
    en:['Reply to your Crix appeal · rejected', n => `Hi ${n},`, 'We reviewed your appeal and, for now, your account suspension stays in place.', 'Message from the Crix team:', 'The Crix team'],
    pt:['Resposta à sua apelação no Crix · rejeitada', n => `Olá ${n},`, 'Analisamos sua apelação e, por enquanto, mantemos a suspensão da sua conta.', 'Mensagem da equipe do Crix:', 'Equipe do Crix'],
    fr:['Réponse à ton appel sur Crix · refusé', n => `Salut ${n},`, 'Nous avons examiné ton appel et, pour l’instant, la suspension de ton compte est maintenue.', 'Message de l’équipe Crix :', 'L’équipe Crix'],
    de:['Antwort auf deinen Crix-Einspruch · abgelehnt', n => `Hallo ${n},`, 'Wir haben deinen Einspruch geprüft; die Sperre deines Kontos bleibt vorerst bestehen.', 'Nachricht vom Crix-Team:', 'Das Crix-Team'],
    it:['Risposta al tuo ricorso su Crix · respinto', n => `Ciao ${n},`, 'Abbiamo esaminato il tuo ricorso e, per ora, la sospensione del tuo account resta in vigore.', 'Messaggio del team di Crix:', 'Il team di Crix'],
  },
};
function appealReplyMail(accepted, username, reply, lang) {
  const t = MAIL_I18N[accepted ? 'appealAccepted' : 'appealRejected'][MAIL_LANGS.includes(lang) ? lang : 'es'];
  return { subject:t[0], text:[t[1](username), '', t[2], reply ? '\n' + t[3] + '\n' + reply : '', '', t[4]].join('\n') };
}
// Respuesta del equipo al usuario (denuncias y apelaciones). Devuelve true si salió el mail.
async function mailUser(to, subject, text) {
  if (!to || !mailConfigured()) return false;
  try { await sendMailRaw({ to, subject: String(subject).slice(0, 200), text }); return true; }
  catch (e) { console.error('[MAIL] no se pudo responder a ' + maskEmail(to) + ': ' + e.message); return false; }
}

// ── APELACIONES DE BANEO ──
app.post('/api/appeals', async (req, res) => {
  if (authLimited(req, res)) return;
  try {
    const b = req.body || {};
    const message = String(b.message || '').trim().slice(0, 2000);
    if (message.length < 10) return res.status(400).json({ ok:false, err:'Explicá por qué creés que el ban es un error (mínimo 10 caracteres).' });
    let user = null;
    if (b.appealToken) {
      const rec = (DB.appealTokens || {})[tokenHash(String(b.appealToken))];
      if (rec && rec.expiresAt > Date.now()) user = DB.users[rec.userId] || null;
      if (!user) return res.status(401).json({ ok:false, err:'La sesión de apelación venció. Intentá iniciar sesión de nuevo para apelar.' });
    } else {
      const username = String(b.username || ''), pw = String(b.pw || '');
      if (!username || !pw || pw.length > 128) return res.status(400).json({ ok:false, err:'Completá usuario y contraseña.' });
      user = Object.values(DB.users).find(u => u.username.toLowerCase() === username.toLowerCase()) || null;
      if (!user || !verifyPassword(pw, user.pw)) return res.status(401).json({ ok:false, err:'Usuario o contraseña incorrectos.' });
    }
    if (!banActive(user)) return res.status(400).json({ ok:false, err:'Esta cuenta no está suspendida.' });
    if (!hasMail(user)) return res.status(403).json({ ok:false, code:'EMAIL_REQUIRED', err:'Para apelar tenés que vincular un mail verificado: ahí te mandamos la respuesta.' });
    const appeals = DB.appeals || (DB.appeals = {});
    const last = Object.values(appeals).filter(a => a.userId === user.id).sort((x, y) => String(y.created).localeCompare(String(x.created)))[0];
    if (last && Date.now() - new Date(last.created).getTime() < APPEAL_COOLDOWN_MS) return res.status(429).json({ ok:false, err:'Ya mandaste una apelación hace poco. Esperá 24 horas para mandar otra.' });
    const id = 'apl_' + crypto.randomUUID();
    const ban = user.banned || {};
    appeals[id] = { id, userId:user.id, username:user.username, message, email:user.mail.address, lang:userLang(user, String(b.lang || '')), status:'open', created:new Date().toISOString(),
      ban:{ reason:ban.reason || '', notes:ban.notes || '', permanent:!!ban.permanent, until:ban.until || null, bannedBy:ban.bannedBy || '', bannedAt:ban.bannedAt || '' }, emailed:false };
    saveDB();
    log('APPEAL', user.username);
    res.json({ ok:true, email:maskEmail(user.mail.address) });
    if (!mailConfigured()) { console.warn('[APELACION] CRIX_RESEND_KEY sin configurar: no se mandó el mail de ' + id); return; }
    const a = appeals[id];
    const text = [
      `Apelación de baneo de ${a.username}`,
      '',
      'Mensaje del usuario:', a.message, '',
      `Mail verificado del usuario: ${a.email} (respondiéndole a este mensaje le llega a esa dirección)`,
      `Idioma de Crix de la persona: ${a.lang} → respondele en ese idioma (el mail de respuesta del panel de admin sale automáticamente en ese idioma).`,
      '',
      `Motivo del ban: ${a.ban.reason || 'Sin motivo especificado'}`,
      a.ban.notes ? `Notas: ${a.ban.notes}` : '',
      `Duración: ${a.ban.permanent ? 'permanente' : 'hasta ' + a.ban.until}`,
      a.ban.bannedBy ? `Baneado por: ${a.ban.bannedBy}` : '',
      '',
      `ID de usuario: ${a.userId}`,
      `ID de apelación: ${a.id}`,
      `Fecha: ${a.created}`,
      'También se puede responder desde el panel de admin (Apelaciones).',
    ].filter((x, i, arr) => x !== '' || arr[i - 1] !== '').join('\n');
    try {
      await sendMailRaw({ subject: `[Crix] Apelación de baneo · ${a.username}`.slice(0, 200), text, replyTo: a.email });
      a.emailed = true; saveDB();
    } catch (e) { console.error('[APELACION] no se pudo mandar el mail de ' + id + ': ' + e.message); }
  } catch (e) { res.status(500).json({ ok:false, err:'No se pudo enviar la apelación.' }); }
});
app.get('/api/admin/appeals', requireAuth, requireAdmin, (req, res) => {
  const list = Object.values(DB.appeals || {})
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || String(b.created).localeCompare(String(a.created)))
    .slice(0, 200)
    .map(a => ({ ...a, email:maskEmail(a.email), stillBanned: !!(DB.users[a.userId] && banActive(DB.users[a.userId])) }));
  res.json({ ok:true, appeals:list });
});
// action: accept (levanta el ban) · reject. La respuesta (reply) le llega al mail verificado del usuario.
app.post('/api/admin/appeals/:id', requireAuth, requireAdmin, async (req, res) => {
  const a = Object.prototype.hasOwnProperty.call(DB.appeals || {}, req.params.id) ? DB.appeals[req.params.id] : null;
  const action = String(req.body?.action || ''), reply = String(req.body?.reply || '').trim().slice(0, 2000);
  if (!a) return res.status(404).json({ ok:false, err:'Apelación no encontrada' });
  if (!['accept', 'reject'].includes(action)) return res.status(400).json({ ok:false, err:'Acción inválida' });
  if (a.status !== 'open') return res.status(400).json({ ok:false, err:'Esa apelación ya fue respondida' });
  if (action === 'reject' && reply.length < 3) return res.status(400).json({ ok:false, err:'Escribí una respuesta para explicarle por qué se rechaza.' });
  const u = DB.users[a.userId];
  if (action === 'accept' && u && u.banned) {
    delete u.banned;
    notifyActivity(u.id, { kind:'home', id:'unban', title:'✅ Tu cuenta fue reactivada', body:'Ya podés volver a usar Crix.', tag:'ban' });
    log('UNBAN', u.id); const t = onlineUsers[u.id]; if (t) io.to(t.socketId).emit('you_are_unbanned');
    io.emit('user_updated', { userId:u.id });
  }
  Object.assign(a, { status: action === 'accept' ? 'accepted' : 'rejected', reply, reviewedBy:req.user.id, reviewedAt:new Date().toISOString() });
  saveDB();
  const lang = a.lang || userLang(u);
  const mail = appealReplyMail(action === 'accept', a.username, reply, lang);
  const emailed = await mailUser(a.email, mail.subject, mail.text);
  a.replyEmailed = emailed; saveDB();
  res.json({ ok:true, emailed });
});

// ── DENUNCIAS ──
require('./reports')(app, { getDB: () => DB, saveDB, requireAuth, requireAdmin, hasMail, maskEmail, mailUser, onVisibility(type, id, hidden) {
  io.emit(type + (hidden ? '_deleted' : '_updated'), type === 'map' ? { mapId:id } : { id, refetch:true });
} });

// ── STATUS ──
// Asistente de IA del Crix Hub (proxy hacia un modelo compatible con la API de OpenAI)
require('./ai-assistant')(app, { requireAuth, log });

app.get('/status', (req, res) => res.json({
  ok:true, online: new Set([...Object.keys(onlineUsers), ...(cluster.enabled ? cluster.remoteOnlineIds() : [])]).size,
  users: Object.keys(DB.users).length,
  maps:  Object.keys(DB.maps).length,
  uptime: Math.floor((Date.now()-stats.start)/1000),
}));

// ── PING (mantiene despierto el servidor en hosts gratis que duermen por inactividad) ──
app.get('/ping', (req, res) => res.send('pong'));

// Auto-ping cada 13 minutos. Solo si definís CRIX_SELF_URL (ej. https://usuario-crix.hf.space).
const SELF_URL = String(process.env.CRIX_SELF_URL || '').trim().replace(/\/+$/, '');
if (SELF_URL) {
  setInterval(() => {
    try {
      (SELF_URL.startsWith('http://') ? require('http') : https).get(SELF_URL + '/ping', r => {
        r.resume(); log('AUTOPing', r.statusCode);
      }).on('error', () => {});
    } catch (e) {}
  }, 13 * 60 * 1000);
}

// ══════════════════════════════════════════════
// SOCKET.IO
// ══════════════════════════════════════════════
// ══════════════════════════════════════════════
// INSTANCIAS COMPARTIDAS (ver cluster.js)
// Cada sala vive en la instancia dueña (prefijo del instanceId). Quien entra desde otra instancia juega igual: sus eventos
// viajan por Redis hasta la sala y las respuestas vuelven directo a su socket.
// ══════════════════════════════════════════════
const remoteSockets = new Map();   // socketId → proxy de alguien conectado a OTRA instancia que juega en una sala de ESTA
const pendingAcks = new Map();     // ackId → { cb, t } (respuestas que esperan al dueño de la sala)
function ownerOfInstance(instanceId) {
  const m = /^([0-9a-f]{8})-/.exec(String(instanceId || ''));
  return cluster.enabled && m ? m[1] : cluster.nodeId;
}
const userBrief = u => u ? { id:u.id, username:u.username, color:u.color, isAdmin:!!u.isAdmin, look:u.look && typeof u.look === 'object' ? CrixAvatar.profileLook(u.look) : u.look, friends:Array.isArray(u.friends) ? u.friends.slice(0, 2000) : [] } : null;
// Socket "de mentira" que usa la sala para hablar con alguien conectado a otra instancia.
function makeProxy(sid, homeNode, user) {
  let p = remoteSockets.get(sid);
  if (!p) {
    p = { id:sid, isProxy:true, homeNode, data:{},
      emit:(ev, ...a) => { io.to(sid).emit(ev, ...a); return true; },
      join:ch => { io.in(sid).socketsJoin(ch); },
      leave:ch => { io.in(sid).socketsLeave(ch); },
      to:ch => ({ emit:(ev, ...a) => io.to(ch).except(sid).emit(ev, ...a) }),
    };
    p.volatile = { emit:p.emit };
    remoteSockets.set(sid, p);
  }
  p.homeNode = homeNode;
  if (user) p.data.user = user;
  return p;
}
// Esta persona deja la sala en la que esté (local o en otra instancia) y su presencia se actualiza.
function finishRemoteLeave(socket) {
  socket.data.gameOwner = null;
  const meta = connSockets[socket.id]; if (meta) { meta.mapId = null; meta.instanceId = null; }
  const uid = meta?.userId;
  if (uid && onlineUsers[uid]?.socketId === socket.id) {
    delete onlineUsers[uid].mapId; delete onlineUsers[uid].instanceId;
    io.emit('online_update', { userId:uid, online:true }); emitPresence(uid);
  }
}
function leaveAnyRoom(socket) {
  const owner = socket.data.gameOwner;
  if (owner && owner !== cluster.nodeId) {
    cluster.sendTo(owner, { type:'fwd', sid:socket.id, ev:'leave_game', args:[] });
    finishRemoteLeave(socket);
    return;
  }
  const meta = connSockets[socket.id]; if (meta?.mapId) leaveRoom(socket, meta.mapId, meta.instanceId);
}
function routeJoin(socket, data) {
  const mapId = String(data?.mapId || '').slice(0, 120), instanceId = String(data?.instanceId || '').slice(0, 80);
  const owner = ownerOfInstance(instanceId);
  leaveAnyRoom(socket);
  if (owner === cluster.nodeId) { socket.data.gameOwner = null; return gameHandlers.join_game(socket, data); }
  if (!cluster.alive(owner)) {
    // El servidor que creó esta partida ya no está (se reinició o cayó) y la sala murió con él. Antes se rechazaba con
    // «Esa partida ya no está activa» y había que abrir una nueva a mano. Ahora esta instancia la recrea con el mismo id:
    // quien se reconecta vuelve a entrar y los demás que lleguen con el mismo enlace caen en la misma sala.
    console.log(`[CLUSTER] La instancia ${owner} ya no responde: se recrea su partida en este servidor (${cluster.nodeId}).`);
    socket.data.gameOwner = null; return gameHandlers.join_game(socket, data);
  }
  cluster.sendTo(owner, { type:'fwd', sid:socket.id, ev:'join_game', args:[{ mapId, instanceId, username:data?.username, look:data?.look }], user:userBrief(socket.data.user) });
}
function routeGame(socket, ev, args) {
  if (!cluster.enabled) return gameHandlers[ev](socket, ...args);
  if (ev === 'join_game') return routeJoin(socket, args[0]);
  const owner = socket.data.gameOwner;
  if (!owner || owner === cluster.nodeId) return gameHandlers[ev](socket, ...args);
  if (ev === 'leave_game') return leaveAnyRoom(socket);
  const last = args[args.length - 1], cb = typeof last === 'function' ? last : null, params = cb ? args.slice(0, -1) : args;
  let ackId;
  if (cb) {
    ackId = crypto.randomUUID();
    const t = setTimeout(() => { if (pendingAcks.delete(ackId)) cb({ ok:false, err:'La partida no respondió' }); }, 10000);
    pendingAcks.set(ackId, { cb, t });
  }
  cluster.sendTo(owner, { type:'fwd', sid:socket.id, ev, args:params, ackId });
}
// ── Lado de la sala: ejecuta el evento de alguien que juega desde otra instancia ──
cluster.on('fwd', async msg => {
  const { sid, ev, ackId, from } = msg, args = Array.isArray(msg.args) ? msg.args : [];
  if (!gameHandlers[ev] || typeof sid !== 'string' || sid.length > 60) return;
  let proxy = remoteSockets.get(sid);
  if (ev === 'join_game') {
    const d = args[0] || {};
    if (!DB.maps[String(d.mapId || '')]) { try { await persist.pullFresh(0, 3000); } catch {} }   // juego recién publicado en otra instancia
    proxy = makeProxy(sid, from, msg.user);
  } else if (proxy) proxy.homeNode = from;
  if (!proxy) return;
  const cb = ackId ? (...a) => cluster.sendTo(from, { type:'ack', ackId, args:a }) : null;
  try { gameHandlers[ev](proxy, ...args, ...(cb ? [cb] : [])); } catch (e) { console.error('[CLUSTER] evento', ev, e.message); }
  if (ev === 'join_game') {
    const meta = connSockets[sid], ok = !!(meta?.mapId && rooms[roomKey(meta.mapId, meta.instanceId)]?.players[sid]);
    cluster.sendTo(from, { type:'joined', sid, ok, mapId:meta?.mapId, instanceId:meta?.instanceId });
    if (!ok) { remoteSockets.delete(sid); delete connSockets[sid]; }
  }
});
cluster.on('ack', msg => {
  const p = pendingAcks.get(msg.ackId); if (!p) return;
  pendingAcks.delete(msg.ackId); clearTimeout(p.t);
  try { p.cb(...(Array.isArray(msg.args) ? msg.args : [])); } catch {}
});
// ── Lado de origen: la sala confirmó (o rechazó) la entrada ──
cluster.on('joined', msg => {
  const s = io.sockets.sockets.get(msg.sid);
  if (!s) { if (msg.ok) cluster.sendTo(msg.from, { type:'fwd', sid:msg.sid, ev:'leave_game', args:[] }); return; }
  if (!msg.ok) { s.data.gameOwner = null; return; }
  s.data.gameOwner = msg.from;
  const meta = connSockets[s.id] || (connSockets[s.id] = {});
  meta.mapId = msg.mapId; meta.instanceId = msg.instanceId;
  const user = s.data.user;
  if (user) {
    onlineUsers[user.id] = { ...(onlineUsers[user.id] || {}), socketId:s.id, username:user.username, color:user.color, mapId:msg.mapId, instanceId:msg.instanceId };
    io.emit('online_update', { userId:user.id, online:true, mapId:msg.mapId, instanceId:msg.instanceId });
    emitPresence(user.id);
  }
});
// Si la instancia dueña de la sala cae, quienes jugaban desde esta se enteran y pueden volver a entrar.
setInterval(() => {
  if (!cluster.enabled) return;
  for (const [, s] of io.sockets.sockets) {
    const owner = s.data.gameOwner;
    if (owner && owner !== cluster.nodeId && !cluster.alive(owner)) {
      finishRemoteLeave(s);
      s.emit('join_error', { message:'Se perdió el servidor de esta partida. Volvé a entrar.' });
    }
  }
}, 5000).unref();

// ══════════════════════════════════════════════
// EVENTOS DE JUEGO (sala, apps y avatares)
// Cada handler recibe el socket por parámetro: puede ser el socket real o un "proxy" de alguien que está conectado a
// OTRA instancia (ver cluster.js). Así la sala vive en una sola instancia y todos juegan juntos.
// ══════════════════════════════════════════════
const gameHandlers = {};
function G(name, fn) { gameHandlers[name] = fn; }
const ackFn = cb => (typeof cb === 'function' ? cb : () => {});
G('app_hello', (socket, _, cb) => {
    const ack = ackFn(cb), ctx = appCtx(socket);
    if (!ctx) return ack({ ok:false, reason:'not_joined' });
    ack({ ok:true, socketId:socket.id, mapId:ctx.meta.mapId, instanceId:ctx.meta.instanceId, maxPlayers:maxPlayersFor(ctx.map),
      players:roomPlayers(ctx.room).map(publicPlayer), state:ctx.room.appState || {} });
});

G('app_send', (socket, { type, data, to } = {}, cb) => {
    const ack = ackFn(cb), ctx = appCtx(socket); if (!ctx) return ack({ ok:false, err:'No estás en una sala' });
    if (typeof type !== 'string' || !APP_KEY_RE.test(type)) return ack({ ok:false, err:'Tipo de mensaje inválido' });
    if (data !== undefined && jsonSize(data, Infinity) < 0) return ack({ ok:false, err:'Mensaje demasiado grande (máx. 8 KB)' });
    if (!rateOk(socket, 'appsend', 90)) return ack({ ok:false, err:'Demasiados mensajes por segundo' });
    const p = ctx.room.players[socket.id], msg = { from:publicPlayer(p), type, data: data === undefined ? null : data };
    if (typeof to === 'string' && to) {
      const target = roomPlayers(ctx.room).find(q => q.socketId === to || q.userId === to);
      if (!target) return ack({ ok:false, err:'Esa persona no está en la sala' });
      io.to(target.socketId).emit('app_msg', msg);
    } else socket.to(gameChannel(ctx.meta.mapId, ctx.meta.instanceId)).emit('app_msg', msg);
    ack({ ok:true });
});

G('app_state_set', (socket, { key, value } = {}, cb) => {
    const ack = ackFn(cb), ctx = appCtx(socket); if (!ctx) return ack({ ok:false, err:'No estás en una sala' });
    if (typeof key !== 'string' || !APP_KEY_RE.test(key)) return ack({ ok:false, err:'Clave inválida' });
    if (!rateOk(socket, 'appstate', 40)) return ack({ ok:false, err:'Demasiados cambios por segundo' });
    const st = ctx.room.appState || (ctx.room.appState = {});
    if (value === null || value === undefined) delete st[key];
    else {
      if (jsonSize(value, Infinity) < 0) return ack({ ok:false, err:'Valor demasiado grande (máx. 16 KB)' });
            st[key] = value;
          }
    io.to(gameChannel(ctx.meta.mapId, ctx.meta.instanceId)).emit('app_state', { key, value: value === undefined ? null : value, by:socket.data.user?.id || socket.id });
    ack({ ok:true });
});

G('app_data_get', (socket, _, cb) => {
    const ack = ackFn(cb), ctx = appCtx(socket), user = socket.data.user;
    if (!ctx || !user) return ack({ ok:false, err:'Iniciá sesión para usar el guardado' });
    ack({ ok:true, data: DB.appData?.[ctx.meta.mapId]?.[user.id]?.data ?? null });
});

G('app_data_set', (socket, { data } = {}, cb) => {
    const ack = ackFn(cb), ctx = appCtx(socket), user = socket.data.user;
    if (!ctx || !user) return ack({ ok:false, err:'Iniciá sesión para usar el guardado' });
    if (!rateOk(socket, 'appdata', 4)) return ack({ ok:false, err:'Guardando demasiado seguido' });
    DB.appData = DB.appData || {};
    const bucket = DB.appData[ctx.meta.mapId] || (DB.appData[ctx.meta.mapId] = {});
    if (data === null || data === undefined) delete bucket[user.id];
    else {
      if (jsonSize(data, Infinity) < 0) return ack({ ok:false, err:'El guardado supera los 64 KB' });
      if (!bucket[user.id] && Object.keys(bucket).length >= 5000) return ack({ ok:false, err:'Esta app llegó al límite de guardados' });
      bucket[user.id] = { data, updated:Date.now() };
    }
    scheduleSave(); ack({ ok:true });
});

G('app_score_submit', (socket, { board, score, mode } = {}, cb) => {
    const ack = ackFn(cb), ctx = appCtx(socket), user = socket.data.user;
    if (!ctx || !user) return ack({ ok:false, err:'Iniciá sesión para guardar puntajes' });
    if (typeof board !== 'string' || !APP_KEY_RE.test(board) || !Number.isFinite(Number(score))) return ack({ ok:false, err:'Puntaje inválido' });
    if (!rateOk(socket, 'appscore', 4)) return ack({ ok:false, err:'Demasiados envíos' });
    const value = Math.max(-1e12, Math.min(1e12, Number(score)));
    DB.appScores = DB.appScores || {};
    const boards = DB.appScores[ctx.meta.mapId] || (DB.appScores[ctx.meta.mapId] = {});
        const b = boards[board] || (boards[board] = { mode: mode === 'min' ? 'min' : 'max', entries:{} });
    const cur = b.entries[user.id];
        const better = !cur || (b.mode === 'min' ? value < cur.score : value > cur.score);
    if (better) b.entries[user.id] = { score:value, username:user.username, at:Date.now() };
    else if (cur.username !== user.username) cur.username = user.username;
    scheduleSave(); ack({ ok:true, improved:better, best:b.entries[user.id].score });
});

G('app_score_top', (socket, { board, n } = {}, cb) => {
    const ack = ackFn(cb), ctx = appCtx(socket), user = socket.data.user;
    if (!ctx) return ack({ ok:false, err:'No estás en una sala' });
    if (typeof board !== 'string' || !APP_KEY_RE.test(board)) return ack({ ok:false, err:'Ranking inválido' });
    if (!rateOk(socket, 'appscoretop', 6)) return ack({ ok:false, err:'Demasiadas consultas' });
    const b = DB.appScores?.[ctx.meta.mapId]?.[board];
    if (!b) return ack({ ok:true, mode:'max', top:[], me:null });
    const sorted = Object.entries(b.entries).map(([id, e]) => ({ id, username:e.username, score:e.score }))
      .sort((x, y) => b.mode === 'min' ? x.score - y.score : y.score - x.score);
    const top = sorted.slice(0, Math.max(1, Math.min(50, Number(n) || 10))).map((e, i) => ({ ...e, rank:i + 1 }));
    const mi = user ? sorted.findIndex(e => e.id === user.id) : -1;
    ack({ ok:true, mode:b.mode, top, me: mi >= 0 ? { rank:mi + 1, score:sorted[mi].score } : null });
});

G('join_game', (socket, data) => {
    const mapId = String(data?.mapId || '').slice(0,120);
    const instanceId = String(data?.instanceId || '').slice(0,80);
    const user = socket.data.user;
    const storedMap = DB.maps[mapId];
    if (!mapId || !instanceId || !storedMap || !canReadMap(storedMap, user)) {
      socket.emit('join_error', { message:'No tenés acceso a esta partida o ya no existe.' });
      return;
    }
    if (!canEnterAdult(storedMap, user)) {
      socket.emit('join_error', { code:'AGE_REQUIRED', message:AGE_REQUIRED_MSG });
      return;
    }
    const userId = user?.id || socket.id;
    const username = user?.username || String(data?.username || 'Invitado');
    const color = user?.color || '#5b8def';
    const prev = connSockets[socket.id];
    if (prev?.mapId && (prev.mapId !== mapId || prev.instanceId !== instanceId)) leaveRoom(socket, prev.mapId, prev.instanceId);
    const room = getRoom(mapId, instanceId);
    if (!room.players[socket.id] && Object.keys(room.players).length >= maxPlayersFor(storedMap)) {
      socket.emit('join_error', { message:'Este servidor está lleno. Probá con otro.' });
      return;
    }
    if (!room.worldParts || room.pendingReset) initializeRoomWorld(room,storedMap);
    const channel = gameChannel(mapId, instanceId);
    const pd = {
      socketId: socket.id, userId: userId||socket.id,
      username: username.substring(0,30), color: color||'#5b8def',
      look: CrixAvatar.profileLook(user?.look && typeof user.look==='object' ? user.look : data?.look),
      x:0,y:3,z:0, ry:0, anim:0, moving:false, onGround:false, mapId, instanceId, joinedAt:Date.now(), isAdult:!!user && isAgeVerified(user),
    };
    room.players[socket.id] = pd;
    connSockets[socket.id] = { ...(connSockets[socket.id]||{}), userId, username, color, mapId, instanceId };
    socket.join(channel);
    if (user && !socket.isProxy) {
      onlineUsers[user.id] = { ...(onlineUsers[user.id]||{}), socketId:socket.id, username, color, mapId, instanceId };
      io.emit('online_update', { userId:user.id, online:true, mapId, instanceId });
      emitPresence(user.id);
    }
    if (socket.isProxy) pd.homeNode = socket.homeNode;
    publishRoom(room);
    startRoomServerScripts(room,storedMap);
    sendRoomPlayersToRunner(room);
    log('JOIN', `${username} → ${mapId} / ${instanceId}`);
    socket.emit('room_state', {
      players: roomPlayers(room).filter(p=>p.socketId!==socket.id),
      avatars: room.avatars, serverNow: Date.now(),
      chat: room.chat.slice(-30), mapId, instanceId,
      ...roomWorldSnapshot(room), scriptRuntime:room.scriptStatus,
    });
    socket.to(channel).emit('player_joined', pd);
    socket.emit('join_ack', { socketId:socket.id, mapId, instanceId, playerCount:Object.keys(room.players).length });
});

G('player_move', (socket, data) => {
    const meta = connSockets[socket.id]; if (!meta?.mapId) return;
    const room = rooms[roomKey(meta.mapId, meta.instanceId)]; if (!room?.players[socket.id]) return;
    const p = room.players[socket.id];
    const bounded=(value,previous,min=-10000,max=10000)=>{const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):previous;};
    const prevX=p.x,prevY=p.y,prevZ=p.z,moveNow=Date.now(),moveDt=(moveNow-(p.moveAt||0))/1000;
    p.x=bounded(data?.x,p.x);p.y=bounded(data?.y,p.y);p.z=bounded(data?.z,p.z);
    if(p.moveAt&&moveDt>0.01&&moveDt<1)playerVelocity.set(p,{x:(p.x-prevX)/moveDt,y:(p.y-prevY)/moveDt,z:(p.z-prevZ)/moveDt});else playerVelocity.set(p,{x:0,y:0,z:0});
    Object.defineProperty(p,'moveAt',{value:moveNow,writable:true,enumerable:false,configurable:true});
    p.ry=bounded(data?.ry,p.ry,-1000,1000);p.anim=bounded(data?.anim,p.anim,-10,10);p.moving=!!data?.moving;p.onGround=!!data?.onGround;
    sendRoomPlayersToRunner(room);
    socket.to(gameChannel(meta.mapId, meta.instanceId)).emit('player_moved',
      { socketId:socket.id, x:p.x,y:p.y,z:p.z, ry:p.ry, anim:p.anim, moving:p.moving, og:p.onGround,
        vx:Math.round((playerVelocity.get(p)?.x||0)*100)/100, vy:Math.round((playerVelocity.get(p)?.y||0)*100)/100, vz:Math.round((playerVelocity.get(p)?.z||0)*100)/100 });
});

G('avatar_self', (socket, data) => {
    const meta = connSockets[socket.id]; if (!meta?.mapId) return;
    const room = rooms[roomKey(meta.mapId, meta.instanceId)]; const player = room?.players[socket.id]; if (!room || !player) return;
    const now = Date.now(); player.avatarTimes = (player.avatarTimes || []).filter(time => now - time < 1000);
    if (player.avatarTimes.length >= 20) return;                                     // 20 mensajes/s por jugador
    player.avatarTimes.push(now);
    const cmds = Array.isArray(data?.cmds) ? data.cmds.slice(0, 12) : [];
    const state = room.avatars[socket.id] || (room.avatars[socket.id] = {});
    const diffs = [];
    for (const cmd of cmds) { const diff = CrixAvatar.sanitizeCommand(cmd); if (diff && !diff.move) { CrixAvatar.mergeState(state, diff); diffs.push(diff); } }
    if (JSON.stringify(state).length > 24000) { delete room.avatars[socket.id]; return; }   // tope de tamaño por avatar
    if (state.look) player.look = CrixAvatar.sanitizeLook(state.look, player.look);
    for (const diff of diffs) socket.to(gameChannel(meta.mapId, meta.instanceId)).emit('avatar_cmd', { target:socket.id, diff });
});

// Muerte de un jugador: se avisa a los demás para que vean su sangre (cada cliente decide según la opción «Sangre» del juego)
G('player_died', (socket) => {
    const meta = connSockets[socket.id]; if (!meta?.mapId) return;
    const room = rooms[roomKey(meta.mapId, meta.instanceId)]; const player = room?.players[socket.id]; if (!room || !player) return;
    const now = Date.now(); if (player.diedAt && now - player.diedAt < 1500) return;   // antispam
    player.diedAt = now;
    socket.to(gameChannel(meta.mapId, meta.instanceId)).emit('player_died', { socketId:socket.id });
});

G('part_collect', (socket, data) => {
    const meta = connSockets[socket.id]; if (!meta?.mapId) return;
    const room = rooms[roomKey(meta.mapId, meta.instanceId)]; if (!room?.players[socket.id] || !room.worldParts) return;
    const id = String(data?.id || '').slice(0, 120);
    const part = room.worldParts[id];
    if (!part || part.behavior !== 'coin' || room.collectedIds.has(id)) return;
    const p = room.players[socket.id];
    // Validación anti-trampa: el jugador tiene que estar cerca de la pieza.
    if (Math.hypot((p.x||0)-part.x, (p.y||0)-part.y, (p.z||0)-part.z) > Math.max(part.sx, part.sy, part.sz) / 2 + 12) return;
    room.collectedIds.add(id);
    socket.to(gameChannel(meta.mapId, meta.instanceId)).emit('part_collected', { id, by:socket.id });
});

G('script_remote', (socket, data) => {
    const meta = connSockets[socket.id]; if (!meta?.mapId) return;
    const room = rooms[roomKey(meta.mapId, meta.instanceId)]; const player = room?.players[socket.id];
    if (!room || !player || !room.scriptStarted || !scriptRunner?.connected) return;
    const name = String(data?.name || '');
    if (!/^[\w.:-]{1,40}$/.test(name)) return;
    const now = Date.now(); player.remoteTimes = (player.remoteTimes || []).filter(time => now - time < 1000);
    if (player.remoteTimes.length >= 30) return;                       // 30 eventos por segundo por jugador
    player.remoteTimes.push(now);
    let payload = null; try { const text = JSON.stringify(data?.data === undefined ? null : data.data); if (text.length > 4096) return; payload = JSON.parse(text); } catch (_) { return; }
    scriptRunner.send({ type:'remote', roomId:roomKey(room.mapId, room.instanceId), userId:String(player.userId), name, data:payload });
});

G('game_chat', (socket, data) => {
    const meta = connSockets[socket.id]; if (!meta?.mapId||!data?.text) return;
    const msg = { socketId:socket.id, username:meta.username, text:String(data.text).slice(0,200), type:'chat' };
    const room = rooms[roomKey(meta.mapId, meta.instanceId)]; if (!room) return;
    room.chat.push({...msg, time:new Date().toISOString()});
    if (room.chat.length>100) room.chat.shift();
    io.to(gameChannel(meta.mapId, meta.instanceId)).emit('game_chat', msg);
});

G('leave_game', (socket) => {
    const meta = connSockets[socket.id]; if (meta?.mapId) leaveRoom(socket, meta.mapId, meta.instanceId);
});

io.on('connection', socket => {
  stats.total++;
  for (const ev of Object.keys(gameHandlers)) socket.on(ev, (...args) => routeGame(socket, ev, args));   // sala, apps y avatares (ver gameHandlers)
  if (socket.data.user) socket.join(userRoom(socket.data.user.id));   // todos los dispositivos de la cuenta reciben sus avisos

  // ── Llamadas de voz y video (señalización WebRTC) ──
  // El audio y el video van directo entre las dos personas (cifrado DTLS-SRTP); el servidor solo
  // retransmite la negociación (SDP e ICE) y lleva el estado: sonando, ocupado, aceptada, terminada.
  const ackFn = cb => (typeof cb === 'function' ? cb : () => {});
  socket.on('call_invite', ({ to, type } = {}, cb) => {
    const ack = ackFn(cb);
    const me = socket.data.user; to = String(to || ''); if (!me || !to || to === me.id) return ack({ ok:false, reason:'invalid' });
    dropStaleRinging(me.id); dropStaleRinging(to);
    const target = onlineUsers[to];
    if (!areFriends(me.id, to)) { socket.emit('call_unavailable', { from:to, reason:'not_friends' }); return ack({ ok:false, reason:'not_friends' }); }
    if (!DB.users[to] || DB.users[to].banned || (!target && !push.has(to))) { socket.emit('call_unavailable', { from:to, reason:'offline' }); return ack({ ok:false, reason:'offline' }); }
    if (calls.has(me.id)) { socket.emit('call_unavailable', { from:to, reason:'self_busy' }); return ack({ ok:false, reason:'self_busy' }); }
    if (calls.has(to)) { socket.emit('call_busy', { from:to }); return ack({ ok:false, reason:'busy' }); }
    callOutcomes.delete(me.id); callOutcomes.delete(to);
    const timer = setTimeout(() => {
      const c = calls.get(me.id); if (!c || c.accepted) return;
      clearCall(me.id, { event:'call_end', reason:'timeout' });
      rememberOutcome(me.id, to, 'call_end', 'timeout');
      const mine = onlineUsers[me.id]; if (mine) io.to(mine.socketId).emit('call_end', { from:to, reason:'timeout' });
    }, 45000);
    const callType = type === 'video' ? 'video' : 'audio', startedAt = Date.now();
    calls.set(me.id, { peer:to, caller:true, accepted:false, type:callType, timer, startedAt });
    calls.set(to, { peer:me.id, caller:false, accepted:false, type:callType, timer, startedAt });
    if (target) io.to(target.socketId).emit('call_invite', { from:me.id, fromName:me.username, type:callType });
    // Si la persona no tiene Crix abierto, el teléfono/PC suena igual con una notificación de llamada.
    // Con la app cerrada solo puede sonar la notificación del sistema (el service worker no reproduce audio),
    // así que se repite cada pocos segundos con el mismo tag (renotify) para que funcione como timbre.
    // Cada repetición vuelve a evaluar qué dispositivos tienen Crix a la vista; se corta al contestar,
    // rechazar, colgar o vencer (clearCall).
    // Cada repetición lleva un tag distinto (call-<id>-<n>): en iPhone un aviso con el mismo tag reemplaza al
    // anterior sin volver a sonar, así que cada uno tiene que ser una notificación nueva. Se cierran todas
    // al contestar, rechazar o cortar (service worker y app, por el prefijo call-<id>).
    let ringN = 0;
    const ringPayload = () => ({ type:'call', from:me.id, fromName:me.username, callType, tag:'call-' + me.id + '-' + (ringN++),
      url:'/?n=call&u=' + encodeURIComponent(me.id) });
    const ringTopic = 'call' + String(me.id).slice(0,20);
    notifyPush(to, ringPayload(), { ttl:45, urgency:'high', topic:ringTopic });
    const calleeEntry = calls.get(to);
    if (calleeEntry && push.has(to)) {
      let repeats = 0;
      calleeEntry.ring = setInterval(() => {
        if (calls.get(to) !== calleeEntry || calleeEntry.accepted || ++repeats > RING_MAX_REPEATS) { clearInterval(calleeEntry.ring); return; }
        notifyPush(to, ringPayload(), { ttl:10, urgency:'high', topic:ringTopic });
      }, RING_EVERY_MS);
    }
    ack({ ok:true, ringing:!!target });
  });
  // Aceptar es idempotente: si el aviso a quien llamó se perdió (socket reconectando) el cliente reintenta y se le vuelve a
  // avisar; antes el segundo intento se descartaba y los dos quedaban esperando hasta cortarse por tiempo.
  socket.on('call_accept', ({ to } = {}, cb) => {
    const ack = ackFn(cb);
    const me = socket.data.user, c = me && calls.get(me.id); to = String(to || '');
    if (!c || c.peer !== to) { socket.emit('call_end', { from:to, reason:'gone' }); return ack({ ok:false, reason:'gone' }); }   // la llamada ya no existe: que la pantalla no quede colgada
    if (c.caller) return ack({ ok:false, reason:'caller' });
    if (!c.accepted) {
      clearTimeout(c.timer); clearInterval(c.ring); clearTimeout(c.dcTimer); c.accepted = true;
      const other = calls.get(to); if (other) { other.accepted = true; clearTimeout(other.dcTimer); }
    }
    const target = onlineUsers[to];
    if (target) io.to(target.socketId).emit('call_accept', { from:me.id }); else log('CALL', 'accept de ' + me.username + ' sin socket de quien llamó (' + to + ')');
    ack({ ok:true, callerOnline:!!target });
  });
  socket.on('call_decline', ({ to } = {}, cb) => {
    const ack = ackFn(cb);
    const me = socket.data.user, c = me && calls.get(me.id); to = String(to || '');
    if (!c || c.peer !== to) return ack({ ok:true, already:true });   // ya no existe: el rechazo igual queda "hecho" (un reintento no debe pisar otra llamada)
    if (c.caller || c.accepted) return ack({ ok:false });
    clearCall(me.id, { event:'call_decline' });
    ack({ ok:true });
  });
  socket.on('call_end', ({ to } = {}, cb) => {
    const ack = ackFn(cb);
    const me = socket.data.user, c = me && calls.get(me.id); to = String(to || '');
    if (!c || c.peer !== to) return ack({ ok:true, already:true });   // ya estaba cortada: nada que avisar
    clearCall(me.id, { event:'call_end', reason:'hangup' });
    ack({ ok:true });
  });
  // Al reconectar, el cliente pregunta si su llamada sigue viva; si no, se le dice cómo terminó.
  socket.on('call_sync', ({ peer } = {}, cb) => {
    const ack = ackFn(cb);
    const me = socket.data.user; peer = String(peer || ''); if (!me || !peer) return ack({ alive:false });
    const c = calls.get(me.id);
    if (c && c.peer === peer) return ack({ alive:true, accepted:!!c.accepted });
    const o = callOutcomes.get(me.id);
    ack({ alive:false, outcome: o && o.peer === peer ? { event:o.event, reason:o.reason } : null });
  });
  // Modo respaldo: si WebRTC no logra conectar (TURN bloqueado, red restringida, hosting sin UDP…) el audio y el video bajan
  // de calidad pero viajan por este mismo socket, que ya funcionó para hacer sonar la llamada. Solo se retransmite entre
  // las dos personas de una llamada aceptada, con tope de tamaño y de ritmo.
  const CALL_MEDIA_MAX = { a:6000, v:100000, h:32 };
  socket.on('call_media', msg => {
    const me = socket.data.user; if (!me || !msg || typeof msg !== 'object') return;
    const to = String(msg.to || ''), k = msg.k === 'v' ? 'v' : msg.k === 'h' ? 'h' : 'a';
    const c = calls.get(me.id); if (!c || !c.accepted || c.peer !== to) return;
    let d = msg.d; if (d instanceof ArrayBuffer) d = Buffer.from(d); else if (ArrayBuffer.isView(d) && !Buffer.isBuffer(d)) d = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
    if (!Buffer.isBuffer(d) || !d.length || d.length > CALL_MEDIA_MAX[k]) return;
    const now = Date.now(), rl = c.rl || (c.rl = { t:now, a:0, v:0, h:0, bytes:0 });
    if (now - rl.t >= 1000) { rl.t = now; rl.a = rl.v = rl.h = 0; rl.bytes = 0; }
    if (++rl[k] > (k === 'a' ? 60 : k === 'v' ? 15 : 8) || (rl.bytes += d.length) > 450000) return;
    const target = onlineUsers[to]; if (!target) return;
    io.to(target.socketId).volatile.emit('call_media', { from:me.id, k, s:msg.s | 0, d });
  });
  socket.on('call_signal', ({ to, kind, sdp, candidate } = {}) => {
    const me = socket.data.user, c = me && calls.get(me.id); to = String(to || '');
    if (me && (!c || c.peer !== to)) return socket.emit('call_end', { from:to, reason:'gone' });
    if (!c || !c.accepted) return;
    if (!['offer','answer','ice'].includes(kind)) return;
    if (kind !== 'ice' && (typeof sdp !== 'string' || sdp.length > 60000)) return;
    if (kind === 'ice' && (candidate !== null && (typeof candidate !== 'object' || JSON.stringify(candidate).length > 4000))) return;
    const payload = { from:me.id, kind, sdp: kind === 'ice' ? undefined : sdp, candidate: kind === 'ice' ? candidate : undefined };
    const target = onlineUsers[to];
    if (!target) {
      // La otra persona está en segundo plano o cambió de red (socket caído): la señal se guarda y se entrega apenas
      // vuelva, así la oferta de reconexión y los candidatos ICE no se pierden. Una oferta nueva reemplaza lo anterior.
      const other = calls.get(to); if (!other) return;
      other.queue = other.queue || [];
      if (kind === 'offer') other.queue.length = 0;
      if (other.queue.length < 80) other.queue.push(payload);
      return;
    }
    io.to(target.socketId).emit('call_signal', payload);
  });

  // El chat privado solo se almacena y notifica mediante la API E2EE.
  // No se reenvían eventos `msg` antiguos que pudieran contener texto plano.
  // ── Modo equipo: co-edición en vivo ──
  socket.on('team_join', ({ mapId } = {}, cb) => {
    const ack = ackFn(cb), user = socket.data.user; mapId = String(mapId || '').slice(0, 120);
    const map = DB.maps[mapId];
    if (!user || !map || !canEditMap(map, user)) return ack({ ok:false, err:'No tenés permiso para editar este proyecto' });
    teamLeave(socket);
    const sess = teamSessions[mapId] || (teamSessions[mapId] = { members:new Map(), rev:0 });
    const me = { userId:user.id, username:user.username, color:user.color || '#5b8def', sel:null };
    sess.members.set(socket.id, me); socket.data.teamMapId = mapId;
    socket.join(teamChannel(mapId));
    socket.to(teamChannel(mapId)).emit('team_member', { action:'join', socketId:socket.id, ...me });
    ack({ ok:true, rev:sess.rev, members:[...sess.members].map(([socketId, m]) => ({ socketId, ...m })) });
  });
  socket.on('team_leave', () => teamLeave(socket));
  socket.on('team_ops', ({ ops } = {}, cb) => {
    const ack = ackFn(cb), user = socket.data.user, mapId = socket.data.teamMapId;
    const sess = mapId && teamSessions[mapId], map = mapId && DB.maps[mapId];
    if (!sess || !sess.members.has(socket.id) || !map || !canEditMap(map, user)) return ack({ ok:false, err:'No estás en una sesión de equipo' });
    if (!rateOk(socket, 'team', 30) || !Array.isArray(ops) || !ops.length) return ack({ ok:false });
    const applied = []; let budget = Infinity;
    for (const op of ops) {
      if (!op || typeof op !== 'object') continue;
      if (op.t === 'p' || op.t === 's') {
        const d = op.d, size = jsonSize(d, Infinity);
        if (!d || typeof d !== 'object' || Array.isArray(d) || d.id === undefined || String(d.id).length > 120 || size < 0 || (budget -= size) < 0) continue;
        const key = op.t === 'p' ? 'parts' : 'scripts', list = Array.isArray(map[key]) ? map[key] : (map[key] = []);
        const i = list.findIndex(x => x && String(x.id) === String(d.id));
        if (i >= 0) list[i] = d; else list.push(d);
        applied.push({ t:op.t, d });
      } else if (op.t === 'pd' || op.t === 'sd') {
        const id = String(op.id ?? '').slice(0, 120), key = op.t === 'pd' ? 'parts' : 'scripts';
        if (!id || !Array.isArray(map[key])) continue;
        map[key] = map[key].filter(x => !x || String(x.id) !== id);
        applied.push({ t:op.t, id });
      } else if (op.t === 'l') {
        if (!op.d || typeof op.d !== 'object' || Array.isArray(op.d) || jsonSize(op.d, 4096) < 0) continue;
        map.lighting = op.d; applied.push({ t:'l', d:op.d });
      } else if (op.t === 'n') {
        const name = String(op.d ?? '').trim().slice(0, 80) || 'Proyecto sin nombre';
        map.name = name; applied.push({ t:'n', d:name });
      } else if (op.t === 'x') {
        if (op.k !== 'settings' && op.k !== 'guis') continue;
        const okType = op.k === 'guis' ? Array.isArray(op.d) : (op.d && typeof op.d === 'object' && !Array.isArray(op.d));
        const size = jsonSize(op.d, 1e6);
        if (!okType || size < 0 || (budget -= size) < 0) continue;
        map[op.k] = op.d;
        if (op.k === 'settings') { const n = Number(op.d.maxPlayers); if (Number.isFinite(n)) map.maxPlayers = Math.max(1, Math.floor(n)); }
        applied.push({ t:'x', k:op.k, d:op.d });
      }
    }
    if (!applied.length) return ack({ ok:true, rev:sess.rev });
    sess.rev++; map.updated = new Date().toISOString(); scheduleSave();
    socket.to(teamChannel(mapId)).emit('team_ops', { from:socket.id, userId:user.id, rev:sess.rev, ops:applied });
    ack({ ok:true, rev:sess.rev });
  });
  socket.on('team_sel', ({ id } = {}) => {
    const mapId = socket.data.teamMapId, sess = mapId && teamSessions[mapId], me = sess?.members.get(socket.id);
    if (!me || !rateOk(socket, 'teamsel', 20)) return;
    me.sel = id == null ? null : String(id).slice(0, 120);
    socket.to(teamChannel(mapId)).emit('team_sel', { socketId:socket.id, id:me.sel });
  });
  socket.on('team_chat', ({ text } = {}) => {
    const mapId = socket.data.teamMapId, sess = mapId && teamSessions[mapId], me = sess?.members.get(socket.id);
    text = String(text || '').trim().slice(0, 300);
    if (!me || !text || !rateOk(socket, 'teamchat', 5)) return;
    io.to(teamChannel(mapId)).emit('team_chat', { socketId:socket.id, username:me.username, color:me.color, text, at:Date.now() });
  });

  // ── API para apps y juegos HTML (SDK window.Crix) ──
  // Guardado por persona y por app (queda en el servidor, no en el navegador).
  // Rankings: mejor puntaje por persona. mode 'max' (más alto gana, por defecto) o 'min' (más bajo gana, p. ej. tiempos).

  socket.on('user_online', ({ userId, username, color }) => {
    const user = socket.data.user;
    if (!user || user.id !== userId) return;
    socket.join(userRoom(user.id));
    onlineUsers[user.id] = { ...(onlineUsers[user.id]||{}), socketId: socket.id, username:user.username, color:user.color };
    connSockets[socket.id] = { ...(connSockets[socket.id]||{}), userId:user.id, username:user.username, color:user.color };
    // Persistir onlineAt en DB para que el cliente lo vea
    DB.users[user.id].onlineAt = Date.now();
    io.emit('online_update', { userId:user.id, online:true });
    emitPresence(user.id);
    // Si la app volvió de segundo plano con una llamada en curso, se cancela la cuenta regresiva de corte.
    const ongoing = calls.get(user.id);
    if (ongoing?.dcTimer) { clearTimeout(ongoing.dcTimer); ongoing.dcTimer = null; }
    // Señales (reoferta, ICE) que llegaron mientras estaba en segundo plano.
    if (ongoing?.accepted && ongoing.queue?.length) {
      const pendingSignals = ongoing.queue.splice(0);
      for (const sig of pendingSignals) socket.emit('call_signal', sig);
    }
    // Si alguien está llamando mientras la app estaba cerrada, el timbre aparece apenas se conecta.
    const pending = calls.get(user.id);
    if (pending && !pending.caller && !pending.accepted) {
      socket.emit('call_invite', { from:pending.peer, fromName:DB.users[pending.peer]?.username || 'Alguien', type:pending.type || 'audio' });
    }
  });
  // El cliente avisa si Crix está a la vista: si lo está, no se manda push (ya ve y escucha el aviso dentro de la app).
  socket.on('app_visibility', ({ visible, endpoint } = {}) => {
    const me = socket.data.user; if (!me) return;
    connSockets[socket.id] = { ...(connSockets[socket.id] || {}), userId:me.id, visible: visible === true, visAt: Date.now(),
      endpoint: typeof endpoint === 'string' && endpoint.length < 1000 ? endpoint : '' };
  });



  // Evento remoto LocalScript → Script de servidor (game.fireServer en el cliente, game.onClientEvent en el servidor).
  // Coleccionables compartidos: cuando alguien recoge una moneda, desaparece para todos en la sala.

  // ── Avatares: huesos, animaciones, cara y accesorios ───────────────────────────────────────────────────────────
  // Un cliente puede controlar SU PROPIO avatar (LocalScript, emotes); los Script de servidor controlan a cualquiera.
  // Todo se valida con las reglas compartidas de crix-avatar.js, se guarda en room.avatars (para quien entra tarde) y se replica.




  socket.on('ping_req', ts => socket.emit('pong_res', ts));


  socket.on('get_online_users', () => {
    socket.emit('online_users_list', [...new Set([...Object.keys(onlineUsers), ...(cluster.enabled ? cluster.remoteOnlineIds() : [])])]);
  });

  // Kick/ban en tiempo real
  socket.on('kick_user', ({ userId, banned }) => {
    if (!socket.data.user?.isAdmin || !userId) return;
    const target = onlineUsers[userId];
    if (target) {
      io.to(target.socketId).emit('you_are_banned', { banned });
    }
    // Persistir ban en DB
    if (DB.users[userId]) {
      DB.users[userId].banned = banned;
      saveDB();
    }
    log('BAN', userId);
  });

  socket.on('unban_user', ({ userId }) => {
    if (!socket.data.user?.isAdmin || !userId) return;
    if (DB.users[userId]) {
      delete DB.users[userId].banned;
      saveDB();
    }
    const target = onlineUsers[userId];
    if (target) {
      io.to(target.socketId).emit('you_are_unbanned');
    }
    log('UNBAN', userId);
  });

  socket.on('disconnect', () => {
    teamLeave(socket);
    const meta = connSockets[socket.id];
    leaveAnyRoom(socket);
    if (meta?.userId) {
      const presence = onlineUsers[meta.userId];
      // ¿Hay otra pestaña/dispositivo de la misma cuenta conectado? Entonces la cuenta sigue en línea y se le pasa la posta;
      // antes, cerrar la pestaña más nueva dejaba a la cuenta "desconectada" (sin recibir llamadas) con otra abierta.
      const otherSid = presence?.socketId === socket.id
        ? Object.keys(connSockets).find(sid => sid !== socket.id && connSockets[sid]?.userId === meta.userId && io.sockets.sockets.get(sid)?.connected)
        : null;
      if (otherSid) { presence.socketId = otherSid; }
      else if (presence?.socketId === socket.id) {
        const ringing = calls.get(meta.userId);
        const handing = !!(ringing && !ringing.caller && !ringing.accepted && handoffLive(meta.userId));   // traspaso a Safari en curso
        const keepRinging = handing || (ringing && !ringing.caller && !ringing.accepted && push.has(meta.userId));
        const keepActive = ringing && ringing.accepted;
        if (keepActive) {
          // Llamada en curso: el media es P2P y sigue aunque la señalización se corte (app en segundo plano,
          // cambio de red, pantalla bloqueada). Solo se corta si no vuelve a conectarse a tiempo.
          const uid = meta.userId;
          clearTimeout(ringing.dcTimer);
          ringing.dcTimer = setTimeout(() => {
            const cur = calls.get(uid);
            if (cur && cur === ringing && !onlineUsers[uid]) clearCall(uid, { event:'call_end', reason:'disconnect' });
          }, CALL_DISCONNECT_GRACE_MS);
        } else if (ringing && ringing.caller && !ringing.accepted) {
          // Quien llamaba perdió la conexión un instante (cambio de red, túnel): se le da margen para volver antes de cortar.
          const uid = meta.userId; clearTimeout(ringing.dcTimer);
          ringing.dcTimer = setTimeout(() => {
            const cur = calls.get(uid);
            if (cur && cur === ringing && !onlineUsers[uid]) clearCall(uid, { event:'call_end', reason:'disconnect' });
          }, 12000);
        } else if (!keepRinging) clearCall(meta.userId, { event:'call_end', reason:'disconnect' });
        else if (!handing) {
          // La app pasó a segundo plano y se cortó el socket sin avisar visibilidad: el teléfono tiene que sonar ahora.
          const caller = DB.users[ringing.peer];
          push.send(meta.userId, { type:'call', from:ringing.peer, fromName:caller?.username || 'Alguien', callType:ringing.type || 'audio',
            tag:'call-' + ringing.peer, url:'/?n=call&u=' + encodeURIComponent(ringing.peer) }, { ttl:40, urgency:'high', topic:'call' + String(ringing.peer).slice(0,20) }).catch(() => {});
        }
        delete onlineUsers[meta.userId];
        publishPresence(meta.userId);
        if (DB.users[meta.userId]) { DB.users[meta.userId].onlineAt = null; }
        io.emit('online_update', { userId:meta.userId, online:false });
        io.emit('presence_update', { userId:meta.userId, online:false });
      }
    }
    delete connSockets[socket.id];
  });
});

function leaveRoom(socket, mapId, instanceId) {
  const room = rooms[roomKey(mapId, instanceId)]; if (!room) return;
  const channel = gameChannel(mapId, instanceId);
  if (room.players[socket.id]) {
    socket.to(channel).emit('player_left', { socketId:socket.id });
    delete room.players[socket.id]; delete room.avatars[socket.id];
  }
  if(Object.keys(room.players).length){sendRoomPlayersToRunner(room);}
  else{
    if(scriptRunner?.connected&&room.scriptStarted)scriptRunner.send({type:'stop',roomId:roomKey(mapId,instanceId)});
    room.scriptStarted=false;room.scriptStatus='stopped';room.pendingReset=true;room.appState=null;
  }
  socket.leave(channel);
  publishRoom(room);
  const meta = connSockets[socket.id];
  if (meta) { meta.mapId = null; meta.instanceId = null; }
  if (socket.isProxy) { delete connSockets[socket.id]; remoteSockets.delete(socket.id); return; }
  if (meta?.userId && onlineUsers[meta.userId]?.socketId === socket.id) {
    delete onlineUsers[meta.userId].mapId;
    delete onlineUsers[meta.userId].instanceId;
    io.emit('online_update', { userId:meta.userId, online:true });
    emitPresence(meta.userId);
  }
}

// Limpiar zombies cada 30s
setInterval(() => {
  for (const [key, room] of Object.entries(rooms)) {
    let removedPlayer=false;
    for (const sid of Object.keys(room.players)) {
      const home = room.players[sid].homeNode;
      const s = home ? null : io.sockets.sockets.get(sid);
      if (home ? !cluster.alive(home) : (!s||!s.connected)) {
        if (home) { remoteSockets.delete(sid); delete connSockets[sid]; }
        delete room.players[sid]; delete room.avatars[sid];
        removedPlayer=true;
        io.to(gameChannel(room.mapId, room.instanceId)).emit('player_left', { socketId:sid });
      }
    }
    if(removedPlayer){
      publishRoom(room);
      if(Object.keys(room.players).length)sendRoomPlayersToRunner(room);
      else{if(scriptRunner?.connected&&room.scriptStarted)scriptRunner.send({type:'stop',roomId:roomKey(room.mapId,room.instanceId)});room.scriptStarted=false;room.scriptStatus='stopped';room.pendingReset=true;}
    }
    if (!Object.keys(room.players).length && Date.now()-room.createdAt > 30*60*1000) { if(scriptRunner?.connected&&room.scriptStarted)scriptRunner.send({type:'stop',roomId:roomKey(room.mapId,room.instanceId)});delete rooms[key]; cluster.setLocalRoom(key, null); }
  }
}, 30000);

// Si start.js dejó un servidor ya escuchando (el "placeholder"), se reutiliza su puerto: las peticiones pasan a este servidor sin
// que el puerto se cierre ni un instante (cerrarlo y reabrirlo producía "upstream connect error ... Connection refused").
function adoptOrListen(cb) {
  const ph = global.__crixPlaceholder;
  if (!ph || !ph.listening) return server.listen(PORT, cb);
  ph.requestTimeout = 0; ph.timeout = 0; ph.headersTimeout = 65000; ph.keepAliveTimeout = 65000;
  ph.removeAllListeners('request'); ph.removeAllListeners('upgrade');
  ph.on('request', (req, res) => server.emit('request', req, res));
  ph.on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head));
  cb();
}
cluster.init(io).finally(() => adoptOrListen(() => {
  console.log('');
  console.log('  ╔══════════════════════════════════╗');
  console.log('  ║    CRIX — Servidor Multijugador  ║');
  console.log('  ╠══════════════════════════════════╣');
  console.log(`  ║  Puerto : ${PORT}                    ║`);
  console.log(`  Build   : ${CRIX_BUILD}`);
  console.log(`  ║  URL    : http://localhost:${PORT}   ║`);
  console.log('  ╚══════════════════════════════════╝');
  console.log('');
}));

// Render envía SIGTERM en cada deploy: guardar y subir todo lo pendiente antes de salir.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`[${signal}] Guardando datos antes de salir…`);
  try { cluster.shutdown(); saveDBNow(); await persist.flush(25000); } catch (e) { console.error('[SHUTDOWN]', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
