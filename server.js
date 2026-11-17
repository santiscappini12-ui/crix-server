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
const worldPhysics = require('./world-physics');
const classification = require('./classification');   // cuestionario de clasificación por país (juegos, apps y videos)

if (persist.enabled && !persist.restored) {
  console.error('[PERSIST] Hay almacenamiento externo configurado: arrancá con "npm start" (start.js) para restaurar los datos antes de iniciar el servidor.');
  process.exit(1);
}

const app    = express();
const server = http.createServer(app);
const cluster = require('./cluster')();   // varias instancias jugando juntas (Redis); sin CRIX_REDIS_URL queda inactivo
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 45000, pingInterval: 15000,
  maxHttpBufferSize: 1e9,
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
app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));   // health check del hosting
// Identifica qué instancia respondió (cabecera X-Crix-Instance): si dos navegadores ven ids distintos, hay más de una instancia corriendo.
const INSTANCE_TAG = cluster.nodeId;
const CRIX_BUILD = 'guest-i18n-google-2026-11-16';   // sirve para comprobar qué versión del código está corriendo realmente en el hosting
app.use('/api', (req, res, next) => { res.set({ 'X-Crix-Instance': INSTANCE_TAG, 'X-Crix-Build': CRIX_BUILD }); next(); });
// Lecturas del catálogo: primero se trae lo que otra instancia haya subido (así lo publicado se ve en todos lados al instante).
app.use(['/api/maps', '/api/videos', '/api/posts', '/api/users'], async (req, res, next) => {
  if (req.method === 'GET') { try { await persist.pullFresh(2000, 2500); } catch {} }
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
let DB = { users: {}, maps: {}, convs: {}, videos: [], posts: [], sessions: {}, push: {}, _v: 0 };
let dbSync = null;   // fusión entre instancias (db-sync.js); se crea justo después de loadDB()

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      DB = { users:{}, maps:{}, convs:{}, videos:[], posts:[], sessions:{}, push:{}, _v:0, ...parsed };
      DB.users = DB.users || {}; DB.maps = DB.maps || {}; DB.convs = DB.convs || {};
      DB.videos = DB.videos || []; DB.posts = DB.posts || []; DB.sessions = DB.sessions || {};
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
function saveDB() {
  try {
    if (dbSync) dbSync.reconcile();   // estampa `_u` en lo que cambió y deja lápidas de lo que se borró
    // Solo se escribe (y se sube al almacenamiento externo) si el contenido cambió.
    const prevV = DB._v || 0;
    DB._v = 0;
    const sig = crypto.createHash('sha1').update(JSON.stringify(DB)).digest('hex');
    if (sig === lastDbSig) { DB._v = prevV; return; }
    DB._v = prevV + 1;
    const json = JSON.stringify(DB);
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tempFile = `${DATA_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, json, 'utf8');
    fs.renameSync(tempFile, DATA_FILE);
    lastDbSig = sig;
    persist.saveDb(json);
  } catch(e) { console.error('[DB] Error al guardar:', e.message); }
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
  if (!video || (video.privacy || 'public') === 'public') io.emit(event, payload);
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
      if (kind === 'new' && rec.ready !== false && (rec.privacy || 'public') === 'public') io.emit('video_new', { id, title:rec.title, authorId:rec.authorId, authorName:rec.authorName, cat:rec.cat, thumb:rec.thumb, created:rec.created, privacy:rec.privacy });
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
persist.setSync({ merge(remote) { const changed = dbSync.merge(remote); if (changed) saveDB(); return changed; } });
persist.startSync();

// Notificaciones push (mensajes, llamadas y solicitudes con la app cerrada)
const push = require('./push')({ getDB: () => DB, saveDB });
push.init();
// Guardar cada 10 segundos para no perder datos
setInterval(saveDB, 10000);

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
    anchored:source.anchored!==false,canCollide:source.canCollide!==false,transparent:number(source.transparent,0,0,0.95),
    behavior:['none','kill','bounce','checkpoint','speed','coin','heal','teleport','win'].includes(source.behavior)?source.behavior:'none',
    behaviorValue:number(source.behaviorValue,0,-1e9,1e9),target:String(source.target||'').slice(0,80),
    textureId:/^tx_[a-z0-9]{3,40}$/.test(String(source.textureId||''))?String(source.textureId):'',texScale:number(source.texScale,4,0.001,1e6),texTint:source.texTint===true,
  };
  for(const [key,lo,hi,fallback] of [['friction',0,1,0.15],['bounce',0,1,0.05],['drag',0,1,0.003],['gravityScale',-5,5,1]])if(source[key]!==undefined&&source[key]!==null)part[key]=number(source[key],fallback,lo,hi);
  if(Array.isArray(source.tags))part.tags=source.tags.slice(0,1000).map(tag=>String(tag).slice(0,40));
  if(type==='ImportedMesh'&&typeof source.meshData==='string')part.meshData=source.meshData;
  return part;
}

function initializeRoomWorld(room, map) {
  room.avatars={}; room.npcs={};
  room.worldParts={}; room.basePartIds=new Set(); room.changedPartIds=new Set(); room.removedPartIds=new Set(); room.physicsVelocities={};
  for(const [index,source] of (Array.isArray(map?.parts)?map.parts:[]).entries()){
    if(source&&source.isNPC){const nid=String(source.id||`map-part-${index}`);room.npcs[nid]={id:nid,name:String(source.name||'NPC').slice(0,80),look:source.look&&typeof source.look==='object'?CrixAvatar.sanitizeLook(source.look,{}):null};continue;}
    if(!source)continue;
    const id=String(source.id||`map-part-${index}`),part=normalizeRoomPart(id,source);
    room.worldParts[id]=part;room.basePartIds.add(id);
  }
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
    scriptRunner=fork(path.join(__dirname,'script-runner.js'),[],{execArgv:major>=20?['--no-node-snapshot']:[],stdio:['ignore','inherit','inherit','ipc']});
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
  runner.send({type:'start',roomId:roomKey(room.mapId,room.instanceId),mapId:room.mapId,instanceId:room.instanceId,scripts,parts:Object.values(room.worldParts||{}),players:playersForRunner(room)});
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
      else for(const npc of Object.values(room.npcs||{}))if(npc.id===raw||npc.name===raw)keys.push('n:'+npc.id);
    }
    const channel=gameChannel(room.mapId,room.instanceId);
    for(const key of keys.slice(0,64)){
      const state=room.avatars[key]||(room.avatars[key]={});CrixAvatar.mergeState(state,diff);
      if(JSON.stringify(state).length>24000){delete room.avatars[key];continue;}
      if(key[0]!=='n'||key[1]!==':'){const pl=room.players[key];if(pl&&state.look)pl.look=CrixAvatar.sanitizeLook(state.look,pl.look);}
      io.to(channel).emit('avatar_cmd',{target:key,diff});
    }
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
    io.to(gameChannel(room.mapId,room.instanceId)).emit('runtime_scene',{command:'upsertPart',payload:{part}});
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

function stepServerWorldPhysics() {
  const now=Date.now();
  for(const room of Object.values(rooms)){
    if(!Object.keys(room.players).length||!room.worldParts){if(room.phys)room.phys.lastAt=0;continue;}
    const roomId=roomKey(room.mapId,room.instanceId),channel=gameChannel(room.mapId,room.instanceId);
    const result=worldPhysics.stepRoom(room,now,playersForRunner(room));
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
    if(!room.lastSyncAt||now-room.lastSyncAt>=2000){
      room.lastSyncAt=now;
      const parts=[];
      for(const part of Object.values(room.worldParts)){
        if(part.anchored||part.type==='Spawn'||part.y<=-500)continue;
        const entry={id:part.id,x:part.x,y:part.y,z:part.z};
        if(part.type==='Sphere'){entry.rx=part.rx||0;entry.ry=part.ry||0;entry.rz=part.rz||0;}
        parts.push(entry);
        if(parts.length>=400)break;
      }
      if(parts.length)io.to(channel).emit('world_sync',{t:now,parts});
    }
  }
}
setInterval(stepServerWorldPhysics,50);

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
  cluster.setLocalRoom(roomKey(room.mapId, room.instanceId), players.length
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

function safeUser(u) { if (!u) return null; const {pw:_,e2eeVault:__,googleSub:___g,...s}=u; return s; }
function publicUser(u) {
  if (!u) return null;
  const { pw:_, e2eeVault:__, banned:___, adminGrantedBy:____, friendRequests:_____, friendRequests_recv:______, friendRequests_sent:_______, googleSub:________, ...profile } = u;
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
  if (!user || user.banned) return null;
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
function mapIsPublic(map) { return !!map && (map.privacy || 'public') === 'public' && !map.unrated; }
function canReadMap(map, user) {
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
const publicPlayer = p => ({ id:p.userId, socketId:p.socketId, username:p.username, color:p.color, joinedAt:p.joinedAt });
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
function publicVideo(video) {
  const { data, file, ...rest } = video;
  return { ...rest, data: video.ready !== false ? '[data]' : null, ready: video.ready !== false };
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
  return user && !user.banned ? user : null;
}

function canReadVideo(video, user) {
  if ((video.privacy || 'public') === 'public') return true;
  return !!user && (video.authorId === user.id || user.isAdmin);
}

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) { socket.data.user = null; return next(); }
  let session = DB.sessions[tokenHash(token)];
  if (!session && persist.enabled) { try { await persist.pullFresh(2000, 2500); } catch {} session = DB.sessions[tokenHash(token)]; }
  const user = session && session.expiresAt > Date.now() ? DB.users[session.userId] : null;
  if (!user || user.banned) return next(new Error('Sesión inválida'));
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
const PUBLIC_FILES = ['/index.html','/service-worker.js','/manifest.webmanifest','/crix-icon.svg','/crix-avatar.js','/crix-avatar.glb','/GLTFLoader.js',
  '/icons/icon-192.png','/icons/icon-512.png','/icons/icon-maskable-512.png','/icons/apple-touch-icon.png','/icons/badge-72.png'];
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

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
function gameIconSource(map) { return okIconData(map?.icon) ? map.icon : (typeof map?.thumb === 'string' && map.thumb.length <= 2000000 && ICON_DATA_RE.test(map.thumb) ? map.thumb : null); }
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
    start_url: `/juego/${id}?pwa=1`, scope: '/', display: 'standalone', orientation: 'any', background_color: '#080a0f', theme_color: '#080a0f',
    categories: ['games'], icons: [{ src: icon, sizes: '192x192', type, purpose: 'any' }, { src: icon, sizes: '512x512', type, purpose: 'any' }],
  }));
});
app.get(['/juego/:id', '/juego/:id/:slug'], sharePage('juego'));
app.get(['/video/:id', '/video/:id/:slug'], sharePage('video'));
app.get('/u/:username', sharePage('u'));
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
        return res.json({ ok:false, banned: user.banned });
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
      if (user.banned.permanent || (until && until > new Date())) return res.status(403).json({ ok:false, err:'Esta cuenta está suspendida.', banned: user.banned });
      delete user.banned; saveDB();
    }
    log('GOOGLE', user.username);
    res.json({ ok:true, user: safeUser(user), token: issueSession(user), isNew });
  } catch (e) { res.status(500).json({ ok:false, err:'No se pudo iniciar sesión con Google' }); }
});

app.get('/api/session', requireAuth, (req, res) => res.json({ ok:true, user:safeUser(req.user) }));
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
  if (!user || user.banned) return res.status(403).json({ ok:false, err:'Cuenta no disponible' });
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
      else if (typeof req.body.look !== 'object' || JSON.stringify(req.body.look).length > 600) return res.status(400).json({ ok:false, err:'Aspecto de avatar inválido' });
      else u.look = CrixAvatar.sanitizeLook(req.body.look, {});
    }
    const allowed = ['bio','color','games','visits','following','liked','onlineAt','avatar'];
    if (actor.isAdmin) allowed.push('banned');
    allowed.forEach(k => { if (req.body[k] !== undefined) u[k] = req.body[k]; });
    if (actor.isAdmin && req.body.isAdmin !== undefined) {
      u.isAdmin = !!req.body.isAdmin;
      if (u.isAdmin) u.adminGrantedBy = actor.id; else delete u.adminGrantedBy;
    }
    DB.users[req.params.id] = u;
    saveDB();
    io.emit('user_updated', { userId: req.params.id });
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, err:e.message }); }
});

// ── GET todos los usuarios (sin pw) ──
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
        ...(viewer?.isAdmin ? safeUser(u) : publicUser(u)),
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
function publicMapRecord(m) { if (m.icon) { const { icon, ...rest } = m; return { ...rest, hasIcon:true }; } return m; }
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
  if (m.icon) out.hasIcon = true;
  if (typeof m.thumb === 'string' && m.thumb) {
    if (m.thumb.length <= 4096) out.thumb = m.thumb;
    else if (mapIsPublic(m) && /^data:image\/(jpeg|png|webp|gif);base64,/.test(m.thumb)) out.thumb = `/api/maps/${encodeURIComponent(id)}/thumb?v=${Number(m._u) || 0}`;
    else if (m.thumb.length <= 400000) out.thumb = m.thumb;   // no públicos: sin URL abierta, la miniatura va dentro
  }
  return out;
}
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
app.get('/api/maps', (req, res) => {
  const uObj = readSession(req);
  const out  = {};
  const wantFull = req.query.full === '1';
  let used = 0;
  for (const [id, m] of Object.entries(DB.maps)) {
    if (!canReadMap(m, uObj)) continue;
    const mine = uObj && (m.authorId === uObj.id || (Array.isArray(m.collaborators) && m.collaborators.includes(uObj.id)));
    if (wantFull) { out[id] = publicMapRecord(m); continue; }
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
  if (!m || !canReadMap(m, readSession(req))) return res.status(404).json({ ok:false, err:'Juego no encontrado' });
  res.json({ ok:true, map: publicMapRecord(m) });
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
    .filter(room => room.mapId === req.params.id && Object.keys(room.players).length > 0)
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
  const instanceId = cluster.nodeId + '-' + crypto.randomUUID();   // el prefijo dice qué instancia del servidor es dueña de la sala
  const room = getRoom(req.params.id, instanceId);
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
  const file = texFile(assetId(req.params.id), req.params.tid) || await persist.fetchTexture(assetId(req.params.id), req.params.tid); if (!file) return res.status(404).end();
  res.set({ 'Content-Type': TEX_MIME[path.extname(file).slice(1)] || 'application/octet-stream', 'X-Content-Type-Options':'nosniff', 'Cache-Control': mapIsPublic(map) ? 'public, max-age=86400' : 'private, max-age=600' });
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
    const next = { ...body, assetsId: old?.assetsId, likedBy:old?.likedBy || m.likedBy || [], plays:old?.plays ?? m.plays ?? 0, likes:old?.likes ?? m.likes ?? 0, authorId: old?.authorId || user.id, authorName: old?.authorName || user.username, textureIds: old?.textureIds || [], sounds: old?.sounds || {}, collaborators: old?.collaborators || [] };
    // En una sesión de equipo activa, las partes/scripts/luces ya llegan por cambios en vivo: un guardado completo no las pisa.
    if (old && teamInSession(m.id, user.id)) for (const k of TEAM_PROTECTED) if (old[k] !== undefined) next[k] = old[k];
    if (okIconData(m.icon)) next.icon = m.icon; else if (okIconData(old?.icon)) next.icon = old.icon; else delete next.icon;
    delete next.hasIcon;
    delete next.unrated; delete next.classification;
    if (cls) next.classification = cls;
    // Sin clasificación válida, un juego/app NUEVO queda como borrador oculto (solo lo ve su autor). Los anteriores a esta función siguen visibles.
    if (!cls && (!old || old.unrated)) next.unrated = true;
    DB.maps[m.id] = next;
    delete DB.maps[m.id].textures;
    saveDB();
    io.emit('map_updated', { mapId: m.id });
    if ((!old || old.unrated) && mapIsPublic(DB.maps[m.id])) io.emit('map_new', { mapId:m.id, name:DB.maps[m.id].name, authorName:DB.maps[m.id].authorName });
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
  for (const k of ['appData', 'appScores']) if (DB[k] && DB[k][oldId]) { DB[k][newId] = DB[k][oldId]; delete DB[k][oldId]; }
  saveDB();
  io.emit('map_deleted', { mapId: oldId });
  io.emit('map_updated', { mapId: newId });
  res.json({ ok:true, id:newId });
});

// ── DELETE mapa ──
app.delete('/api/maps/:id', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para borrar juegos' });
  const existing = DB.maps[req.params.id];
  if (!existing) return res.json({ ok:true });
  if (existing.authorId !== user.id && !user.isAdmin)
    return res.status(403).json({ ok:false, err:'No podés borrar este juego' });
  const aid = assetId(req.params.id);
  delete DB.maps[req.params.id];
  if (DB.appData) delete DB.appData[req.params.id];
  if (DB.appScores) delete DB.appScores[req.params.id];
  if (MAP_ID_RE.test(aid)) { try { fs.rmSync(texDir(aid), { recursive:true, force:true }); } catch {} persist.delPrefix(`textures/${aid}/`); try { fs.rmSync(soundDir(aid), { recursive:true, force:true }); } catch {} persist.delPrefix(`sounds/${aid}/`); }
  saveDB();
  io.emit('map_deleted', { mapId: req.params.id });
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
  toUser(req.user.id).emit('user_updated', { userId:req.user.id });               // tus otros dispositivos actualizan tus favoritos
  res.json({ ok:true, liked, likes:map.likes });
});

app.post('/api/maps/:id/play', (req, res) => {
  const map = DB.maps[req.params.id];
  if (!map || !canReadMap(map, readSession(req))) return res.status(404).json({ ok:false });
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
  const v = await findVideoReady(req.params.id);
  if (!v || !canReadVideo(v, readSession(req))) return res.status(404).json({ ok: false });
  const file = await videoLocalFile(v);
  if (!file) return res.status(404).json({ ok:false, err:'El archivo del video no está disponible' });
  if (v.size > 25 * 1024 * 1024) return res.status(413).json({ ok:false, err:'Usá /stream para videos grandes', stream:`/api/videos/${v.id}/stream` });
  res.json({ ok: true, data: `data:${v.mime};base64,${fs.readFileSync(file).toString('base64')}`, thumb: v.thumb });
});

// Reproducción por streaming (con soporte de rangos para adelantar/retroceder).
// El <video> no puede enviar encabezados, por eso el token de sesión también se acepta por ?t= (solo aquí).
app.get('/api/videos/:id/stream', async (req, res) => {
  const v = await findVideoReady(req.params.id);
  const user = readSession(req) || userFromToken(req.query.t);
  if (!v || !canReadVideo(v, user)) return res.status(404).end();
  const file = await videoLocalFile(v);
  if (!file) return res.status(404).end();
  res.set({ 'Content-Type': v.mime || 'video/mp4', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': (v.privacy || 'public') === 'public' ? 'public, max-age=3600' : 'private, max-age=600' });
  res.sendFile(file, { acceptRanges: true, dotfiles: 'allow' }, err => { if (err && !res.headersSent) res.status(err.status || 500).end(); });
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
    const saved = {
      ...(old || {}), id:String(v.id), title:String(v.title).slice(0,120), desc:String(v.desc || '').slice(0,2000), cat:String(v.cat || 'otros').slice(0,30),
      authorId: old?.authorId || user.id, authorName: old?.authorName || user.username, privacy, thumb, ...(cls ? { classification: cls } : {}),
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
    const becamePublic = !!old && old.privacy !== 'public' && saved.privacy === 'public';
    if (saved.ready && (!wasReady || becamePublic) && saved.privacy === 'public') io.emit('video_new', { id: saved.id, title: saved.title, authorId: saved.authorId, authorName: saved.authorName, cat: saved.cat, thumb: saved.thumb, created: saved.created, privacy: saved.privacy });
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
    video.file = file; video.mime = mime; video.size = size; video.ready = true; delete video.data;
    await settleUpload(persist.putFile('videos/' + file, path.join(VIDEO_DIR, file)));
    saveDB();
    if (!wasReady && video.privacy === 'public') io.emit('video_new', { id: video.id, title: video.title, authorId: video.authorId, authorName: video.authorName, cat: video.cat, thumb: video.thumb, created: video.created, privacy: video.privacy });
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
  const comment = { id:`c${crypto.randomUUID()}`, authorId:user.id, authorName:user.username, text, created:new Date().toISOString() };
  v.comments.push(comment);
  saveDB();
  emitVideoEvent(v, 'video_updated', { id:v.id, comment });
  res.json({ ok: true, comment });
});

app.delete('/api/videos/:id', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para continuar' });
  const video = (DB.videos || []).find(v => v.id === req.params.id);
  if (!video) return res.json({ ok:true });
  if (video.authorId !== user.id && !user.isAdmin)
    return res.status(403).json({ ok:false, err:'No podés borrar este video' });
  DB.videos = DB.videos.filter(v => v.id !== req.params.id);
  { const f = videoFilePath(video); if (f) { try { fs.unlinkSync(f); } catch {} persist.delKey('videos/' + path.basename(f)); } }
  saveDB();
  emitVideoEvent(video, 'video_deleted', { id:req.params.id });
  res.json({ ok:true });
});

// ── POSTS (Foros) ──
app.get('/api/posts', (req, res) => {
  res.json({ ok: true, posts:DB.posts || [] });
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
    if (previous && previous.authorId !== user.id && !user.isAdmin)
      return res.status(403).json({ ok:false, err:'No podés editar esta publicación' });
    const savedPost = { ...(previous || {}), ...p, authorId:previous?.authorId || user.id, authorName:previous?.authorName || user.username, privacy:'public' };
    if (index >= 0) DB.posts[index] = savedPost; else DB.posts.unshift(savedPost);
    saveDB();
    if (previous) io.emit('post_updated', { id: savedPost.id, refetch:true });   // edición: sin aviso de "nuevo post"
    else io.emit('new_post', { id: savedPost.id, authorId: savedPost.authorId, authorName: savedPost.authorName, text: (savedPost.text||'').substring(0,100) });
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
  res.json({ ok: true, reply });
});

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
const userBrief = u => u ? { id:u.id, username:u.username, color:u.color, isAdmin:!!u.isAdmin, look:u.look, friends:Array.isArray(u.friends) ? u.friends.slice(0, 2000) : [] } : null;
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
  if (!cluster.alive(owner)) { socket.emit('join_error', { message:'Esa partida ya no está activa. Abrí una nueva con "Jugar".' }); return; }
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
      look: CrixAvatar.sanitizeLook(user?.look && typeof user.look==='object' ? user.look : data?.look, {}),
      x:0,y:3,z:0, ry:0, anim:0, moving:false, onGround:false, mapId, instanceId, joinedAt:Date.now(),
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
      avatars: room.avatars,
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
      { socketId:socket.id, x:p.x,y:p.y,z:p.z, ry:p.ry, anim:p.anim, moving:p.moving, og:p.onGround });
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
    for (const cmd of cmds) { const diff = CrixAvatar.sanitizeCommand(cmd); if (diff) { CrixAvatar.mergeState(state, diff); diffs.push(diff); } }
    if (JSON.stringify(state).length > 24000) { delete room.avatars[socket.id]; return; }   // tope de tamaño por avatar
    if (state.look) player.look = CrixAvatar.sanitizeLook(state.look, player.look);
    for (const diff of diffs) socket.to(gameChannel(meta.mapId, meta.instanceId)).emit('avatar_cmd', { target:socket.id, diff });
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

cluster.init(io).finally(() => server.listen(PORT, () => {
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
  try { cluster.shutdown(); saveDB(); await persist.flush(25000); } catch (e) { console.error('[SHUTDOWN]', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
