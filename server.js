const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const crypto   = require('crypto');
const { fork } = require('node:child_process');
const persist  = require('./persist');
const guard    = require('./media-guard');
const mediaDirect = require('./media-direct');

if (persist.enabled && !persist.restored) {
  console.error('[PERSIST] Hay almacenamiento externo configurado: arrancá con "npm start" (start.js) para restaurar los datos antes de iniciar el servidor.');
  process.exit(1);
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 20000, pingInterval: 10000,
});
app.use(express.json({ limit: '50mb' }));
mediaDirect.init();
guard.startAutoReload(persist);
console.log(mediaDirect.direct() ? '[MEDIA] Subida directa al bucket ACTIVA: los medios no pasan por este servidor' : '[MEDIA] Sin bucket S3: los medios pasan por el servidor (solo desarrollo)');

const PORT = process.env.PORT || 3000;
const DATA_FILE = persist.DATA_FILE;

// ══════════════════════════════════════════════
// Base de datos JSON. En producción, CRIX_DATA_FILE debe apuntar
// a un disco persistente montado por el proveedor de alojamiento.
// ══════════════════════════════════════════════
let DB = { users: {}, maps: {}, convs: {}, videos: [], posts: [], sessions: {}, moderation: { incidents: [] }, _v: 0 };

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      DB = { users:{}, maps:{}, convs:{}, videos:[], posts:[], sessions:{}, _v:0, ...parsed };
      DB.users = DB.users || {}; DB.maps = DB.maps || {}; DB.convs = DB.convs || {};
      DB.videos = DB.videos || []; DB.posts = DB.posts || []; DB.sessions = DB.sessions || {}; DB.moderation = DB.moderation || { incidents: [] };
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
// Guardar cada 10 segundos para no perder datos
setInterval(saveDB, 10000);

// ══════════════════════════════════════════════
// ESTADO EN MEMORIA (sesiones activas)
// ══════════════════════════════════════════════
const rooms          = {};
const connSockets    = {};   // socketId → { userId, username, color, mapId }
const onlineUsers    = {};   // userId   → { socketId, username, color }
const stats = { start: Date.now(), total: 0 };
const calls = new Map();       // userId → { peer, caller, accepted, timer } (llamadas sonando o activas)
function clearCall(userId, notify) {
  const c = calls.get(userId); if (!c) return null;
  clearTimeout(c.timer); calls.delete(userId);
  const other = calls.get(c.peer);
  if (other && other.peer === userId) { clearTimeout(other.timer); calls.delete(c.peer); }
  if (notify) { const target = onlineUsers[c.peer]; if (target) io.to(target.socketId).emit(notify.event, { from:userId, reason:notify.reason }); }
  return c;
}

function maxPlayersFor(map) { const n = Number(map?.maxPlayers); return Number.isFinite(n) ? Math.max(1, Math.min(200, Math.floor(n))) : 50; }
function roomKey(mapId, instanceId) { return JSON.stringify([mapId, instanceId]); }
function gameChannel(mapId, instanceId) { return `game:${encodeURIComponent(mapId)}:${instanceId}`; }
function getRoom(mapId, instanceId) {
  const key = roomKey(mapId, instanceId);
  if (!rooms[key]) rooms[key] = { mapId, instanceId, createdAt:Date.now(), players:{}, chat:[], worldParts:null, basePartIds:new Set(), changedPartIds:new Set(), removedPartIds:new Set(), physicsVelocities:{}, scriptStarted:false, scriptStatus:'stopped', pendingReset:false, commandTimes:[] };
  return rooms[key];
}
function roomPlayers(room) { return Object.values(room.players); }
function log(t,d) { console.log(`[${new Date().toLocaleTimeString()}] ${t}:`, d); }

function normalizeRoomPart(id, source = {}) {
  const pos=source.position||{}, size=source.size||{};
  const number=(value,fallback=0,min=-10000,max=10000)=>{const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;};
  const types=['Block','Sphere','Cylinder','Wedge','TrussPart','Spawn','ImportedMesh'];
  const materials=['SmoothPlastic','Plastic','Brick','Wood','WoodPlanks','Metal','DiamondPlate','Neon','Glass','Ice','Grass','Sand','Concrete','Rock','Marble','Cobblestone','Fabric'];
  const type=types.includes(source.type)?source.type:'Block';
  const part={
    id:String(id).slice(0,120), name:String(source.name||'Part').slice(0,80), type,
    x:number(source.x??pos.x??pos.X),y:number(source.y??pos.y??pos.Y),z:number(source.z??pos.z??pos.Z),
    sx:number(source.sx??size.x??size.X,4,0.1,1000),sy:number(source.sy??size.y??size.Y,4,0.1,1000),sz:number(source.sz??size.z??size.Z,4,0.1,1000),
    rx:number(source.rx),ry:number(source.ry),rz:number(source.rz),
    color:/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(source.color||''))?String(source.color):'#5b8def',
    material:materials.includes(source.material)?source.material:'SmoothPlastic',
    anchored:source.anchored!==false,canCollide:source.canCollide!==false,transparent:number(source.transparent,0,0,0.95),
    behavior:['none','kill','bounce','checkpoint','speed','coin','heal','teleport','win'].includes(source.behavior)?source.behavior:'none',
    behaviorValue:number(source.behaviorValue,0,-1000,1000),target:String(source.target||'').slice(0,80),
    textureId:/^tx_[a-z0-9]{3,40}$/.test(String(source.textureId||''))?String(source.textureId):'',texScale:number(source.texScale,4,0.25,64),texTint:source.texTint===true,
  };
  if(type==='ImportedMesh'&&typeof source.meshData==='string'&&source.meshData.length<=2*1024*1024)part.meshData=source.meshData;
  return part;
}

function initializeRoomWorld(room, map) {
  room.worldParts={}; room.basePartIds=new Set(); room.changedPartIds=new Set(); room.removedPartIds=new Set(); room.physicsVelocities={};
  for(const [index,source] of (Array.isArray(map?.parts)?map.parts:[]).entries()){
    if(!source||source.isNPC)continue;
    const id=String(source.id||`map-part-${index}`),part=normalizeRoomPart(id,source);
    room.worldParts[id]=part;room.basePartIds.add(id);
  }
  room.pendingReset=false;room.scriptStarted=false;room.scriptStatus='stopped';room.commandTimes=[];
}

function roomWorldSnapshot(room) {
  const runtimeParts=Object.values(room.worldParts||{}).filter(part=>!room.basePartIds.has(part.id)&&part.type!=='Spawn');
  const worldChanges=Array.from(room.changedPartIds).map(id=>room.worldParts[id]).filter(part=>part&&part.type!=='Spawn');
  return {runtimeParts,worldChanges,removedParts:[...room.removedPartIds]};
}

let scriptRunner=null, scriptRunnerError=null;
function ensureScriptRunner() {
  if(scriptRunner?.connected)return scriptRunner;
  if(scriptRunnerError)return null;
  try{
    const major=Number(process.versions.node.split('.')[0]);
    scriptRunner=fork(path.join(__dirname,'script-runner.js'),[],{execArgv:major>=20?['--no-node-snapshot']:[],stdio:['ignore','inherit','inherit','ipc']});
    scriptRunner.on('message',handleScriptRunnerMessage);
    scriptRunner.on('error',error=>{scriptRunnerError=error.message;log('SCRIPT_RUNNER',error.message);});
    scriptRunner.on('exit',(code)=>{scriptRunner=null;if(code!==0){scriptRunnerError='El proceso aislado de scripts terminó ('+code+'). Reiniciá Crix para volver a intentar.';log('SCRIPT_RUNNER',scriptRunnerError);for(const room of Object.values(rooms)){if(room.scriptStarted){room.scriptStarted=false;room.scriptStatus='error';io.to(gameChannel(room.mapId,room.instanceId)).emit('script_runtime_status',{status:'error',message:scriptRunnerError});}}}});
    return scriptRunner;
  }catch(error){scriptRunnerError=error.message;log('SCRIPT_RUNNER',error.message);return null;}
}

function startRoomServerScripts(room,map) {
  if(room.scriptStarted)return;
  const scripts=(Array.isArray(map?.scripts)?map.scripts:[]).filter(script=>script?.type==='Script');
  if(!scripts.length){room.scriptStarted=true;room.scriptStatus='ready';return;}
  const runner=ensureScriptRunner();
  if(!runner){room.scriptStatus='error';io.to(gameChannel(room.mapId,room.instanceId)).emit('script_runtime_status',{status:'error',message:scriptRunnerError||'No se pudo iniciar el entorno de scripts.'});return;}
  room.scriptStarted=true;room.scriptStatus='starting';
  runner.send({type:'start',roomId:roomKey(room.mapId,room.instanceId),mapId:room.mapId,instanceId:room.instanceId,scripts,parts:Array.isArray(map.parts)?map.parts:[],players:roomPlayers(room)});
}

function sendRoomPlayersToRunner(room) {
  if(!scriptRunner?.connected||!room?.scriptStarted)return;
  scriptRunner.send({type:'players',roomId:roomKey(room.mapId,room.instanceId),players:roomPlayers(room)});
}

function handleScriptRunnerMessage(message) {
  if(!message||typeof message!=='object')return;
  if(message.type==='fatal'){scriptRunnerError=String(message.message||'Falló el entorno aislado de scripts.');log('SCRIPT_RUNNER',scriptRunnerError);return;}
  const room=Object.values(rooms).find(item=>roomKey(item.mapId,item.instanceId)===String(message.roomId||''));
  if(!room)return;
  if(message.type==='started'){
    room.scriptStatus='ready';
    io.to(gameChannel(room.mapId,room.instanceId)).emit('script_runtime_status',{status:'ready',scriptCount:message.scriptCount||0});
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
  if(message.type==='sceneCommand')applyServerScriptCommand(room,message.command,message.payload||{});
}

function applyServerScriptCommand(room,command,payload) {
  const now=Date.now();room.commandTimes=room.commandTimes.filter(time=>now-time<1000);
  if(room.commandTimes.length>=100)return;
  room.commandTimes.push(now);
  const id=String(payload.id||'').slice(0,120);
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
    if(part.anchored)room.physicsVelocities[id]=0;
    scriptRunner?.send({type:'worldPart',roomId:roomKey(room.mapId,room.instanceId),part});
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
  for(const room of Object.values(rooms)){
    if(!Object.keys(room.players).length||!room.worldParts)continue;
    const parts=Object.values(room.worldParts);
    for(const part of parts){
      if(part.type==='Spawn'||part.anchored||part.isNPC)continue;
      const velocity=Math.max(-0.8,(room.physicsVelocities[part.id]||0)-0.018);
      const oldY=part.y,oldBottom=oldY-part.sy/2,oldTop=oldY+part.sy/2;
      part.y+=velocity;room.physicsVelocities[part.id]=velocity;
      if(part.canCollide){
        for(const other of parts){
          if(other.id===part.id||other.type==='Spawn'||!other.canCollide)continue;
          const overlapX=Math.abs(part.x-other.x)<(part.sx+other.sx)/2;
          const overlapZ=Math.abs(part.z-other.z)<(part.sz+other.sz)/2;
          if(!overlapX||!overlapZ)continue;
          const bottom=part.y-part.sy/2,top=part.y+part.sy/2,otherBottom=other.y-other.sy/2,otherTop=other.y+other.sy/2;
          if(velocity<=0&&oldBottom>=otherTop-0.08&&bottom<otherTop){part.y=otherTop+part.sy/2;room.physicsVelocities[part.id]=0;break;}
          if(velocity>0&&oldTop<=otherBottom+0.08&&top>otherBottom){part.y=otherBottom-part.sy/2;room.physicsVelocities[part.id]=0;break;}
        }
      }
      if(Math.abs(part.y-oldY)>0.0001){
        if(room.basePartIds.has(part.id))room.changedPartIds.add(part.id);
        const positionUpdate={id:part.id,x:part.x,y:part.y,z:part.z};
        scriptRunner?.send({type:'worldPosition',roomId:roomKey(room.mapId,room.instanceId),part:positionUpdate});
        io.to(gameChannel(room.mapId,room.instanceId)).emit('runtime_scene',{command:'upsertPart',payload:{part:positionUpdate}});
      }
    }
  }
}
setInterval(stepServerWorldPhysics,50);

// Presencia visible para todos: qué juego e instancia está jugando cada persona.
function presenceInfo(userId, viewer) {
  const presence = onlineUsers[userId];
  if (!presence) return { online:false };
  const info = { online:true };
  const map = presence.mapId ? DB.maps[presence.mapId] : null;
  if (map && presence.instanceId && (viewer === undefined ? (map.privacy || 'public') === 'public' : (viewer?.id === userId || canReadMap(map, viewer)))) {
    const room = rooms[roomKey(presence.mapId, presence.instanceId)];
    info.currentGameId = presence.mapId; info.currentInstanceId = presence.instanceId;
    info.currentGameName = map.name || presence.mapId;
    info.currentInstancePlayers = room ? Object.keys(room.players).length : 1;
  }
  return info;
}
function emitPresence(userId) {
  const user = DB.users[userId]; if (!user) return;
  io.emit('presence_update', { userId, username:user.username, color:user.color, ...presenceInfo(userId) });
}

function safeUser(u) { if (!u) return null; const {pw:_,e2eeVault:__,...s}=u; return s; }
function publicUser(u) {
  if (!u) return null;
  const { pw:_, e2eeVault:__, banned:___, adminGrantedBy:____, friendRequests:_____, friendRequests_recv:______, friendRequests_sent:_______, ...profile } = u;
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
function canReadMap(map, user) {
  const privacy = map.privacy || 'public';
  if (privacy === 'public') return true;
  if (!user) return false;
  if (map.authorId === user.id || user.isAdmin) return true;
  if (privacy === 'friends') return (user.friends || []).includes(map.authorId);
  if (privacy === 'assigned') return (map.assignedPlayers || []).includes(user.username);
  return false;
}
// ── Almacenamiento de videos: archivos en disco (no base64 dentro del JSON de la base) ──
const VIDEO_DIR = persist.VIDEO_DIR;
const VIDEO_EXT = { 'video/mp4':'mp4', 'video/webm':'webm', 'video/ogg':'ogv' };
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Detecta el formato REAL por los primeros bytes (no confía en lo que diga el cliente).
function sniffVideo(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'video/webm';
  if (buf.toString('latin1', 0, 4) === 'OggS') return 'video/ogg';
  const box = buf.toString('latin1', 4, 8);
  if (['ftyp','moov','mdat','free','wide','skip'].includes(box)) return 'video/mp4';  // MP4 / MOV / M4V / 3GP
  return null;
}
function videoFilePath(video) { return video && video.file ? path.join(VIDEO_DIR, path.basename(video.file)) : null; }
function storeVideoBuffer(video, buffer) {
  if (!VIDEO_ID_RE.test(String(video.id))) throw new Error('Identificador de video inválido');
  if (buffer.length > MAX_VIDEO_BYTES) throw new Error('El video supera el máximo de 60 MB');
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

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) { socket.data.user = null; return next(); }
  const session = DB.sessions[tokenHash(token)];
  const user = session && session.expiresAt > Date.now() ? DB.users[session.userId] : null;
  if (!user || user.banned) return next(new Error('Sesión inválida'));
  socket.data.user = user;
  next();
});


// ══════════════════════════════════════════════
// Moderación de contenido ilegal (firmas + listas de hashes). Sin filtros de palabras ni censura de opinión:
// solo material ilegal conocido y archivos que no son lo que dicen ser.
// ══════════════════════════════════════════════
function recordIncident(user, source, info) {
  DB.moderation = DB.moderation || { incidents: [] };
  const inc = { id: crypto.randomBytes(6).toString('hex'), t: Date.now(), userId: user?.id || null, username: user?.username || null, source,
    sha256: info.sha256 || info.hash || null, peerId: info.peerId || null, alg: info.alg || null, list: info.list || null, label: info.label || info.signature || null, reviewed: false };
  DB.moderation.incidents.unshift(inc); if (DB.moderation.incidents.length > 2000) DB.moderation.incidents.length = 2000;
  console.warn(`[GUARD] Bloqueado (${source}) usuario=${inc.userId} lista=${inc.list} etiqueta=${inc.label} sha256=${inc.sha256}`);
  return inc;
}
// Coincidencia con lista de hashes: se corta la subida y, salvo CRIX_ON_MATCH=block, la cuenta pierde la posibilidad de subir medios.
function blockUpload(user, res, source, r) {
  if (r.blocked) {
    recordIncident(user, source, { ...r.blocked, sha256: r.sha256 });
    if (user && process.env.CRIX_ON_MATCH !== 'block') user.mediaBanned = true;
    if (user && process.env.CRIX_ON_MATCH === 'ban') user.banned = true;
    saveDB();
    return res.status(451).json({ ok:false, err:'Este contenido coincide con material ilegal conocido y fue bloqueado.', blocked:true });
  }
  return res.status(r.status || 400).json({ ok:false, err:r.err || 'Archivo rechazado' });
}
// Para rutas que todavía reciben bytes (modo local / compatibilidad): firma + hashes.
async function scanBuffer(user, buf, kind, source) {
  const v = guard.verifyKind(buf, kind); if (!v.ok) return { status:415, err:v.err || 'Formato no permitido' };
  const info = guard.hashBuffer(buf), hit = await guard.checkHashes(info, buf);
  return hit ? { status:451, blocked:hit, sha256:info.sha256 } : null;
}
// Cualquier JSON que traiga archivos embebidos (data:...;base64) se escanea igual.
app.use(async (req, res, next) => {
  try {
    if (req.method !== 'POST' || !req.body || typeof req.body !== 'object' || req.path.startsWith('/api/convs/') || req.path.startsWith('/api/e2ee/')) return next();
    const hits = await guard.scanDataUris(req.body);
    if (!hits.length) return next();
    const user = readSession(req), h = hits[0];
    if (h.hit) return blockUpload(user, res, 'inline:' + req.path, { blocked:h.hit, sha256:h.sha256 });
    return res.status(415).json({ ok:false, err:`Un archivo adjunto no es un medio válido (${h.bad.mime}).` });
  } catch (e) { next(); }
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
const PUBLIC_FILES = ['/index.html','/service-worker.js','/manifest.webmanifest','/crix-icon.svg'];
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(PUBLIC_FILES, (req, res) => res.sendFile(path.join(__dirname, req.path)));

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

app.get('/api/session', requireAuth, (req, res) => res.json({ ok:true, user:safeUser(req.user) }));
app.post('/api/logout', requireAuth, (req, res) => {
  const token = (req.get('authorization') || '').slice(7);
  delete DB.sessions[tokenHash(token)];
  saveDB();
  res.json({ ok:true });
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
        (typeof req.body.avatar !== 'string' ||
         !(/^\/m\/[0-9a-f]{64}\.(?:jpg|png|webp)$/.test(req.body.avatar) ||
           (req.body.avatar.length <= 180000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(req.body.avatar)))))
      return res.status(400).json({ ok:false, err:'La foto debe ser JPG, PNG o WebP y no superar el límite permitido' });
    if (req.body.avatar && u.mediaBanned) return res.status(403).json({ ok:false, err:'Tu cuenta no puede subir medios' });
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
    const presence = onlineUsers[id];
    const activeMap = presence?.mapId ? DB.maps[presence.mapId] : null;
    const activeRoom = presence?.instanceId ? rooms[roomKey(presence.mapId, presence.instanceId)] : null;
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
          currentInstancePlayers: activeRoom ? Object.keys(activeRoom.players).length : 1,
        } : {}),
      };
    }
  }
  res.json({ ok:true, users: out });
});

// ── Servidores ICE para las llamadas (STUN público; TURN opcional por variables de entorno) ──
app.get('/api/ice', requireAuth, (req, res) => {
  const iceServers = [{ urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302'] }];
  if (process.env.CRIX_TURN_URL) iceServers.push({ urls:String(process.env.CRIX_TURN_URL).split(',').map(x => x.trim()).filter(Boolean), username:process.env.CRIX_TURN_USER || '', credential:process.env.CRIX_TURN_PASS || '' });
  res.json({ ok:true, iceServers });
});

// ── Gente en línea ahora (visible para todos) ──
app.get('/api/online', (req, res) => {
  const viewer = readSession(req);
  const list = Object.keys(onlineUsers).map(id => {
    const u = DB.users[id]; if (!u || u.banned) return null;
    return { id, username:u.username, color:u.color, avatar:u.avatar || '', ...presenceInfo(id, viewer) };
  }).filter(Boolean);
  res.json({ ok:true, users:list });
});

// ── Unirse al servidor de cualquier persona que esté jugando ──
app.post('/api/join-user/:id', requireAuth, (req, res) => {
  const target = DB.users[req.params.id];
  const presence = onlineUsers[req.params.id];
  if (!target || !presence) return res.status(404).json({ ok:false, err:'Esa persona no está en línea.' });
  if (!presence.mapId || !presence.instanceId) return res.status(409).json({ ok:false, err:'Esa persona no está jugando ahora.' });
  const map = DB.maps[presence.mapId];
  if (!map || !canReadMap(map, req.user)) return res.status(403).json({ ok:false, err:'No tenés acceso al juego que está jugando.' });
  const room = rooms[roomKey(presence.mapId, presence.instanceId)];
  const count = room ? Object.keys(room.players).length : 0;
  if (count >= maxPlayersFor(map)) return res.status(409).json({ ok:false, err:'Ese servidor está lleno.' });
  res.json({ ok:true, mapId:presence.mapId, instanceId:presence.instanceId, gameName:map.name || presence.mapId, players:count });
});

// ── GET mapas ──
app.get('/api/maps', (req, res) => {
  const uObj = readSession(req);
  const out  = {};
  for (const [id, m] of Object.entries(DB.maps)) {
    if (canReadMap(m, uObj)) out[id]=m;
  }
  res.json({ ok:true, maps: out });
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
    }))
    .sort((a,b) => b.playerCount-a.playerCount || a.startedAt-b.startedAt);
  res.json({ ok:true, instances });
});

// Reservar una sala nueva. Jugar en otra instancia nunca mezcla a sus jugadores.
app.post('/api/maps/:id/instances', requireAuth, (req, res) => {
  const map = DB.maps[req.params.id];
  if (!map || !canReadMap(map, req.user)) return res.status(404).json({ ok:false, err:'Juego no encontrado' });
  const instanceId = crypto.randomUUID();
  const room = getRoom(req.params.id, instanceId);
  res.status(201).json({ ok:true, instance:{ id:room.instanceId, mapId:room.mapId, startedAt:room.createdAt } });
});


// ══════════════════════════════════════════════
// Subida directa de medios (presign → PUT al bucket → commit con verificación)
// ══════════════════════════════════════════════
app.post('/api/media/presign', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.kind === 'video') { const v = (DB.videos || []).find(x => x.id === b.ref); if (!v) return res.status(404).json({ ok:false, err:'Primero creá el video' }); if (v.authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ ok:false, err:'No podés editar este contenido' }); }
    if (b.kind === 'texture') { const m = DB.maps[b.ref]; if (!m) return res.status(404).json({ ok:false, err:'Guardá el juego antes de subir texturas' }); if (m.authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ ok:false, err:'No podés editar este juego' }); }
    mediaDirect.learnOrigin(req.headers.origin, req.headers.host);   // autoriza en el bucket el origen del propio sitio
    const r = await mediaDirect.presign(req.user, b);
    if (r.status !== 200) return r.blocked ? blockUpload(req.user, res, 'presign', r) : res.status(r.status).json({ ok:false, err:r.err });
    res.json({ ok:true, mode:r.mode, uploadId:r.uploadId, url:r.url, headers:r.headers });
  } catch (e) { res.status(500).json({ ok:false, err:e.message }); }
});
// Solo modo local (sin bucket): el archivo llega acá. Con bucket S3 el navegador sube directo y esta ruta no se usa.
app.put('/api/media/:uploadId/blob', requireAuth, express.raw({ type: () => true, limit: 61 * 1024 * 1024 }), async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (mediaDirect.direct() && process.env.CRIX_RELAY_FALLBACK !== '1') return res.status(409).json({ ok:false, err:'Subí directo al almacenamiento' });
  const r = mediaDirect.direct() ? await mediaDirect.receiveRelay(req.user, req.params.uploadId, body) : await mediaDirect.receiveLocal(req.user, req.params.uploadId, body);
  res.status(r.status).json({ ok:r.status === 200, err:r.err });
});
// Imágenes sueltas (fotos de perfil, miniaturas, posts, imágenes de GUI): se guardan por su SHA-256 → /m/<hash>.<ext>
app.post('/api/media/commit', requireAuth, async (req, res) => {
  try {
    const r = await mediaDirect.commit(req.user, String(req.body?.uploadId || ''), (sig, info) => mediaDirect.mediaKey(info.sha256, sig.ext), { kind:'image' });
    if (r.status !== 200) return r.blocked ? blockUpload(req.user, res, 'image', r) : res.status(r.status).json({ ok:false, err:r.err });
    if (!mediaDirect.direct()) await persist.putFile(r.key, mediaDirect.localPath(r.key));
    res.json({ ok:true, url:'/m/' + r.key.slice('media/'.length), sha256:r.sha256, mime:r.mime, size:r.size });
  } catch (e) { res.status(500).json({ ok:false, err:e.message }); }
});
app.get('/m/:file', async (req, res) => {
  const f = req.params.file;
  if (!mediaDirect.MEDIA_KEY_RE.test(f)) return res.status(404).end();
  if (guard.checkSha256Only(f.slice(0, 64))) return res.status(451).end();      // si la lista se actualiza, el bloqueo rige también para lo ya subido
  const key = 'media/' + f;
  if (mediaDirect.direct()) {
    const url = await mediaDirect.readUrl(key).catch(() => null); if (!url) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=1800'); return res.redirect(302, url);
  }
  const file = await persist.ensureLocal(key, mediaDirect.localPath(key)) ? mediaDirect.localPath(key) : null; if (!file) return res.status(404).end();
  res.set({ 'X-Content-Type-Options':'nosniff', 'Cache-Control':'public, max-age=86400' });
  res.sendFile(file, { dotfiles:'allow' }, err => { if (err && !res.headersSent) res.status(err.status || 500).end(); });
});

// ── Chequeo de hashes para el chat E2EE ──
// El servidor no puede ver los adjuntos cifrados. El cliente calcula el SHA-256 del archivo ANTES de cifrarlo (y el
// receptor al abrirlo) y consulta acá. Solo viaja el hash, nunca el contenido ni la clave.
const checkRate = new Map();
app.post('/api/moderation/check', requireAuth, (req, res) => {
  const now = Date.now(), e = checkRate.get(req.user.id) || { n:0, t:now };
  if (now - e.t > 60e3) { e.n = 0; e.t = now; } e.n++; checkRate.set(req.user.id, e);
  if (e.n > 120) return res.status(429).json({ ok:false, err:'Demasiadas consultas' });
  const hashes = (Array.isArray(req.body?.hashes) ? req.body.hashes : []).filter(h => /^[0-9a-f]{64}$/i.test(String(h))).slice(0, 20).map(h => String(h).toLowerCase());
  const context = req.body?.context === 'receive' ? 'receive' : 'send', peer = String(req.body?.peer || '').slice(0, 80);
  const blocked = [];
  for (const h of hashes) {
    const hit = guard.checkSha256Only(h); if (!hit) continue;
    blocked.push(h);
    recordIncident(req.user, 'e2ee-' + context, { ...hit, sha256:h, peerId: context === 'receive' ? peer : null });   // en 'receive' el usuario es quien lo recibió; el emisor declarado no está verificado
    if (context === 'send' && process.env.CRIX_ON_MATCH !== 'block') req.user.mediaBanned = true;
  }
  if (blocked.length) saveDB();
  res.json({ ok:true, blocked });
});

// ── Administración de moderación ──
app.get('/api/admin/media-status', requireAuth, requireAdmin, async (req, res) => {
  if (req.query.recheck === '1') await mediaDirect.ensureCors();
  res.json({ ok:true, ...mediaDirect.status() });
});
app.get('/api/admin/moderation', requireAuth, requireAdmin, (req, res) => {
  res.json({ ok:true, lists:guard.stats(), incidents:(DB.moderation?.incidents || []).slice(0, 300) });
});
app.post('/api/admin/moderation/:id/review', requireAuth, requireAdmin, (req, res) => {
  const inc = (DB.moderation?.incidents || []).find(x => x.id === req.params.id); if (!inc) return res.status(404).json({ ok:false });
  inc.reviewed = true; if (req.body?.unban && inc.userId && DB.users[inc.userId]) delete DB.users[inc.userId].mediaBanned;
  saveDB(); res.json({ ok:true });
});
// Cargar una lista de hashes obtenida de una organización (queda guardada en el bucket y sobrevive a los deploys).
app.post('/api/admin/moderation/hashlist', requireAuth, requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60), text = String(req.body?.text || '');
  if (!name || !text) return res.status(400).json({ ok:false, err:'Faltan nombre o contenido' });
  const n = guard.setList('bucket:' + name + '.txt', text);
  await persist.putKey(`moderation/hashlists/${name}.txt`, Buffer.from(text, 'utf8'), 'text/plain').catch(e => console.warn('[GUARD] No se pudo guardar la lista en el bucket:', e.message));
  res.json({ ok:true, hashes:n, stats:guard.stats() });
});

// ── Texturas de los juegos: archivos en disco (el mapa solo guarda la lista de ids) ──
const TEX_DIR = persist.TEX_DIR;
const TEX_ID_RE = /^tx_[a-z0-9]{3,40}$/, MAP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEX_BYTES = 450 * 1024;   // sin límite de cantidad de texturas por juego
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
  if (map.authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ ok:false, err:'No podés editar este juego' });
  if (mediaDirect.direct()) return res.status(409).json({ ok:false, err:'Actualizá la página: las texturas ahora se suben directo al almacenamiento' });
  const incoming = req.body && req.body.textures;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ ok:false, err:'Faltan texturas' });
  const entries = Object.entries(incoming).slice(0, 8), ids = new Set(map.textureIds || []), staged = [];
  for (const [tid, value] of entries) {
    if (!TEX_ID_RE.test(tid)) return res.status(400).json({ ok:false, err:'Identificador de textura inválido' });
    const buf = dataUrlToBuffer(value);
    if (!buf) return res.status(400).json({ ok:false, err:'Imagen inválida' });
    if (buf.length > MAX_TEX_BYTES) return res.status(413).json({ ok:false, err:'La textura supera 450 KB' });
    const kind = sniffImage(buf);
    if (!kind) return res.status(400).json({ ok:false, err:'Formato de imagen no soportado (PNG, JPG, WEBP o GIF)' });
    const blocked = await scanBuffer(req.user, buf, 'image', 'texture'); if (blocked) return blockUpload(req.user, res, 'texture', blocked);
    staged.push({ tid, buf, kind });
  }
  fs.mkdirSync(texDir(req.params.id), { recursive:true });
  const uploads = [];
  for (const { tid, buf, kind } of staged) {
    const name = `${tid}.${kind.ext}`;
    try { const old = texFile(req.params.id, tid); if (old) { fs.unlinkSync(old); if (path.basename(old) !== name) persist.delKey(`textures/${req.params.id}/${path.basename(old)}`); } } catch {}
    fs.writeFileSync(path.join(texDir(req.params.id), name), buf); ids.add(tid);
    uploads.push(persist.putFile(`textures/${req.params.id}/${name}`, path.join(texDir(req.params.id), name)));
  }
  await Promise.all(uploads);
  map.textureIds = [...ids]; saveDB();
  res.json({ ok:true, textureIds: map.textureIds });
});

app.post('/api/maps/:id/textures/commit', requireAuth, async (req, res) => {
  try {
    const map = DB.maps[req.params.id], tid = String(req.body?.tid || '');
    if (!map || !MAP_ID_RE.test(req.params.id)) return res.status(404).json({ ok:false, err:'Guardá el juego antes de subir texturas' });
    if (map.authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ ok:false, err:'No podés editar este juego' });
    if (!TEX_ID_RE.test(tid)) return res.status(400).json({ ok:false, err:'Identificador de textura inválido' });
    const r = await mediaDirect.commit(req.user, String(req.body?.uploadId || ''), sig => `textures/${req.params.id}/${tid}.${sig.ext}`, { kind:'texture', ref:req.params.id });
    if (r.status !== 200) return r.blocked ? blockUpload(req.user, res, 'texture', r) : res.status(r.status).json({ ok:false, err:r.err });
    map.texFiles = map.texFiles || {}; map.texHashes = map.texHashes || {};
    const oldName = map.texFiles[tid], name = `${tid}.${r.ext}`;
    if (oldName && oldName !== name) { mediaDirect.removeKey(`textures/${req.params.id}/${oldName}`); if (!mediaDirect.direct()) persist.delKey(`textures/${req.params.id}/${oldName}`); }
    if (!mediaDirect.direct()) await persist.putFile(r.key, mediaDirect.localPath(r.key));
    map.texFiles[tid] = name; map.texHashes[tid] = r.sha256;
    map.textureIds = [...new Set([...(map.textureIds || []), tid])]; saveDB();
    res.json({ ok:true, textureIds:map.textureIds });
  } catch (e) { res.status(500).json({ ok:false, err:e.message }); }
});
app.get('/api/maps/:id/textures/:tid', async (req, res) => {
  const map = DB.maps[req.params.id], user = readSession(req) || userFromToken(req.query.t);
  if (!map || !MAP_ID_RE.test(req.params.id) || !TEX_ID_RE.test(req.params.tid) || !canReadMap(map, user)) return res.status(404).end();
  const hh = map.texHashes && map.texHashes[req.params.tid]; if (hh && guard.checkSha256Only(hh)) return res.status(451).end();
  if (mediaDirect.direct()) {
    let name = map.texFiles && map.texFiles[req.params.tid];
    if (!name) { const f = await persist.listKeys(`textures/${req.params.id}/${req.params.tid}.`).catch(() => []); name = f[0] && f[0].key.split('/').pop(); }   // texturas anteriores a la subida directa
    if (!name) return res.status(404).end();
    const url = await mediaDirect.readUrl(`textures/${req.params.id}/${name}`, { privateAccess:(map.privacy || 'public') !== 'public' }).catch(() => null); if (!url) return res.status(404).end();
    res.set('Cache-Control', (map.privacy || 'public') === 'public' ? 'public, max-age=1800' : 'private, no-store');
    return res.redirect(302, url);
  }
  const file = texFile(req.params.id, req.params.tid) || await persist.fetchTexture(req.params.id, req.params.tid); if (!file) return res.status(404).end();
  res.set({ 'Content-Type': TEX_MIME[path.extname(file).slice(1)] || 'application/octet-stream', 'X-Content-Type-Options':'nosniff', 'Cache-Control': (map.privacy || 'public') === 'public' ? 'public, max-age=86400' : 'private, max-age=600' });
  res.sendFile(file, { dotfiles:'allow' }, err => { if (err && !res.headersSent) res.status(err.status || 500).end(); });
});

// ── SAVE mapa ──
app.post('/api/maps', (req, res) => {
  try {
    const user = readSession(req);
    if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para guardar juegos' });
    const m = req.body;
    if (!m || !m.id) return res.json({ ok:false });
    const old = DB.maps[m.id];
    if (old && old.authorId !== user.id && !user.isAdmin)
      return res.status(403).json({ ok:false, err:'No podés editar este juego' });
    DB.maps[m.id] = { ...m, likedBy:old?.likedBy || m.likedBy || [], plays:old?.plays ?? m.plays ?? 0, likes:old?.likes ?? m.likes ?? 0, authorId: old?.authorId || user.id, authorName: old?.authorName || user.username, textureIds: old?.textureIds || [], texFiles: old?.texFiles || {}, texHashes: old?.texHashes || {} };
    delete DB.maps[m.id].textures;
    saveDB();
    io.emit('map_updated', { mapId: m.id });
    if (!old && (DB.maps[m.id].privacy || 'public') === 'public') io.emit('map_new', { mapId:m.id, name:DB.maps[m.id].name, authorName:DB.maps[m.id].authorName });
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, err:e.message }); }
});

// ── DELETE mapa ──
app.delete('/api/maps/:id', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para borrar juegos' });
  const existing = DB.maps[req.params.id];
  if (!existing) return res.json({ ok:true });
  if (existing.authorId !== user.id && !user.isAdmin)
    return res.status(403).json({ ok:false, err:'No podés borrar este juego' });
  delete DB.maps[req.params.id];
  if (MAP_ID_RE.test(req.params.id)) { try { fs.rmSync(texDir(req.params.id), { recursive:true, force:true }); } catch {} persist.delPrefix(`textures/${req.params.id}/`); }
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
  io.emit('map_updated', { mapId:map.id });
  res.json({ ok:true, liked, likes:map.likes });
});

app.post('/api/maps/:id/play', (req, res) => {
  const map = DB.maps[req.params.id];
  if (!map || !canReadMap(map, readSession(req))) return res.status(404).json({ ok:false });
  map.plays = (map.plays || 0) + 1;
  saveDB();
  io.emit('map_updated', { mapId:map.id });
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
    convId.split('_').forEach(uid => {
      const o = onlineUsers[uid];
      if (o) io.to(o.socketId).emit('new_private_msg', { convId, msg:encryptedMessage });
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
    const toOnline = onlineUsers[toId];
    if (toOnline) io.to(toOnline.socketId).emit('friend_request', { from:from.id, fromName:from.username });
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
    const fromOnline = onlineUsers[fromId];
    if (fromOnline) io.to(fromOnline.socketId).emit('friend_accepted', { from:to.id, fromName:to.username });
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
  const v = (DB.videos || []).find(x => x.id === req.params.id);
  if (!v || !canReadVideo(v, readSession(req))) return res.status(404).json({ ok: false });
  const file = await videoLocalFile(v);
  if (!file) return res.status(404).json({ ok:false, err:'El archivo del video no está disponible' });
  if (v.size > 25 * 1024 * 1024) return res.status(413).json({ ok:false, err:'Usá /stream para videos grandes', stream:`/api/videos/${v.id}/stream` });
  res.json({ ok: true, data: `data:${v.mime};base64,${fs.readFileSync(file).toString('base64')}`, thumb: v.thumb });
});

// Reproducción por streaming (con soporte de rangos para adelantar/retroceder).
// El <video> no puede enviar encabezados, por eso el token de sesión también se acepta por ?t= (solo aquí).
app.get('/api/videos/:id/stream', async (req, res) => {
  const v = (DB.videos || []).find(x => x.id === req.params.id);
  const user = readSession(req) || userFromToken(req.query.t);
  if (!v || !canReadVideo(v, user)) return res.status(404).end();
  if (v.sha256 && guard.checkSha256Only(v.sha256)) return res.status(451).end();   // lista actualizada después de subirlo
  if (mediaDirect.direct() && v.file) {
    const url = await mediaDirect.readUrl('videos/' + path.basename(v.file), { privateAccess:(v.privacy || 'public') !== 'public' }).catch(() => null);
    if (!url) return res.status(404).end();
    res.set('Cache-Control', (v.privacy || 'public') === 'public' ? 'public, max-age=1800' : 'private, no-store');
    return res.redirect(302, url);                                                  // los bytes salen del bucket, no de este servidor
  }
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
    const privacy = ['public','private'].includes(v.privacy) ? v.privacy : 'public';
    const thumb = typeof v.thumb === 'string' && (/^\/m\/[0-9a-f]{64}\.(?:jpg|png|webp)$/.test(v.thumb) || (/^data:image\/(jpeg|png|webp);base64,/.test(v.thumb) && v.thumb.length <= 200000)) ? v.thumb : (old?.thumb || null);
    const saved = {
      ...(old || {}), id:String(v.id), title:String(v.title).slice(0,120), desc:String(v.desc || '').slice(0,2000), cat:String(v.cat || 'otros').slice(0,30),
      authorId: old?.authorId || user.id, authorName: old?.authorName || user.username, privacy, thumb,
      views: old?.views || 0, likes: old?.likes || [], comments: old?.comments || [], created: old?.created || v.created || new Date().toISOString()
    };
    const wasReady = !!old?.ready;
    if (typeof v.data === 'string' && v.data !== '[data]') {   // compatibilidad: archivo embebido en base64
      if (mediaDirect.direct()) return res.status(409).json({ ok:false, err:'Actualizá la página: los videos ahora se suben directo al almacenamiento' });
      const buf = dataUrlToBuffer(v.data);
      if (!buf) return res.status(400).json({ ok:false, err:'Archivo de video inválido' });
      const blocked = await scanBuffer(user, buf, 'video', 'video-inline'); if (blocked) return blockUpload(user, res, 'video-inline', blocked);
      let upload; try { upload = storeVideoBuffer(saved, buf); } catch (err) { return res.status(400).json({ ok:false, err:err.message }); }
      await upload;
    } else if (!old) saved.ready = false;                       // el archivo llega después con PUT /file
    if (idx >= 0) DB.videos[idx] = saved; else DB.videos.push(saved);
    saveDB();
    if (saved.ready && !wasReady && saved.privacy === 'public') io.emit('video_new', { id: saved.id, title: saved.title, authorId: saved.authorId, authorName: saved.authorName, cat: saved.cat, thumb: saved.thumb, created: saved.created, privacy: saved.privacy });
    res.json({ ok: true, ready: !!saved.ready });
  } catch(e) { res.json({ ok: false, err: e.message }); }
});


// El navegador ya subió el archivo directo al bucket: acá se verifica y se publica.
app.post('/api/videos/:id/commit', requireAuth, async (req, res) => {
  try {
    const video = (DB.videos || []).find(x => x.id === req.params.id);
    if (!video) return res.status(404).json({ ok:false, err:'Primero creá el video' });
    if (video.authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ ok:false, err:'No podés editar este contenido' });
    const r = await mediaDirect.commit(req.user, String(req.body?.uploadId || ''), sig => `videos/${video.id}.${sig.ext}`, { kind:'video', ref:video.id });
    if (r.status !== 200) return r.blocked ? blockUpload(req.user, res, 'video', r) : res.status(r.status).json({ ok:false, err:r.err });
    const wasReady = !!video.ready, oldFile = video.file, file = path.basename(r.key);
    if (oldFile && oldFile !== file) { mediaDirect.removeKey('videos/' + path.basename(oldFile)); if (!mediaDirect.direct()) persist.delKey('videos/' + path.basename(oldFile)); }
    if (!mediaDirect.direct()) await persist.putFile(r.key, mediaDirect.localPath(r.key));
    video.file = file; video.mime = r.mime; video.size = r.size; video.sha256 = r.sha256; video.ready = true; delete video.data;
    saveDB();
    if (!wasReady && video.privacy === 'public') io.emit('video_new', { id: video.id, title: video.title, authorId: video.authorId, authorName: video.authorName, cat: video.cat, thumb: video.thumb, created: video.created, privacy: video.privacy });
    res.json({ ok:true, size:video.size, mime:video.mime });
  } catch (e) { res.status(500).json({ ok:false, err:e.message }); }
});

// Subida binaria del archivo por el servidor (solo modo local / compatibilidad; con bucket queda cerrada).
app.put('/api/videos/:id/file', express.raw({ type: () => true, limit: MAX_VIDEO_BYTES + 1024 }), async (req, res) => {
  try {
    const user = readSession(req);
    if (!user) return res.status(401).json({ ok:false, err:'Iniciá sesión para publicar' });
    const video = (DB.videos || []).find(x => x.id === req.params.id);
    if (!video) return res.status(404).json({ ok:false, err:'Primero creá el video' });
    if (video.authorId !== user.id && !user.isAdmin) return res.status(403).json({ ok:false, err:'No podés editar este contenido' });
    if (mediaDirect.direct()) return res.status(409).json({ ok:false, err:'Actualizá la página: los videos ahora se suben directo al almacenamiento' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ ok:false, err:'Archivo vacío' });
    const blocked = await scanBuffer(user, req.body, 'video', 'video-put'); if (blocked) return blockUpload(user, res, 'video-put', blocked);
    video.sha256 = guard.hashBuffer(req.body).sha256;
    const wasReady = !!video.ready;
    let upload; try { upload = storeVideoBuffer(video, req.body); } catch (err) { return res.status(400).json({ ok:false, err:err.message }); }
    await upload;
    saveDB();
    if (!wasReady && video.privacy === 'public') io.emit('video_new', { id: video.id, title: video.title, authorId: video.authorId, authorName: video.authorName, cat: video.cat, thumb: video.thumb, created: video.created, privacy: video.privacy });
    res.json({ ok:true, size:video.size, mime:video.mime });
  } catch (e) { res.status(500).json({ ok:false, err:e.message }); }
});

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
  res.json({ ok: true, liked, likes: v.likes.length });
});

app.post('/api/videos/:id/view', (req, res) => {
  const video = (DB.videos || []).find(x => x.id === req.params.id);
  if (!video || !canReadVideo(video, readSession(req))) return res.status(404).json({ ok:false });
  video.views = (video.views || 0) + 1;
  saveDB();
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
  if ((video.privacy || 'public') === 'public') io.emit('video_deleted', { id:req.params.id });
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
    if (DB.posts.length > 500) DB.posts = DB.posts.slice(0, 500);
    saveDB();
    io.emit('new_post', { id: savedPost.id, authorId: savedPost.authorId, authorName: savedPost.authorName, text: (savedPost.text||'').substring(0,100) });
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
  res.json({ ok: true, reply });
});

// ── STATUS ──
app.get('/status', (req, res) => res.json({
  ok:true, online: Object.keys(onlineUsers).length,
  users: Object.keys(DB.users).length,
  maps:  Object.keys(DB.maps).length,
  uptime: Math.floor((Date.now()-stats.start)/1000),
}));

// ── PING (evita que Render duerma el proceso) ──
app.get('/ping', (req, res) => res.send('pong'));

// Auto-ping cada 13 minutos para que Render no duerma el proceso.
// Solo corre en Render (o si definís CRIX_KEEPALIVE_URL). En otros hosts (p. ej. Koyeb, que duerme a propósito) no hace nada.
const KEEPALIVE_URL = process.env.CRIX_KEEPALIVE_URL || (process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '') + '/ping' : '');
if (KEEPALIVE_URL) setInterval(() => {
  try {
    https.get(KEEPALIVE_URL, r => {
      log('AUTOPing', r.statusCode);
    }).on('error', ()=>{});
  } catch(e) {}
}, 13 * 60 * 1000);

// ══════════════════════════════════════════════
// SOCKET.IO
// ══════════════════════════════════════════════
io.on('connection', socket => {
  stats.total++;

  // ── Llamadas de voz y video (señalización WebRTC) ──
  // El audio y el video van directo entre las dos personas (cifrado DTLS-SRTP); el servidor solo
  // retransmite la negociación (SDP e ICE) y lleva el estado: sonando, ocupado, aceptada, terminada.
  socket.on('call_invite', ({ to, type } = {}) => {
    const me = socket.data.user; to = String(to || ''); if (!me || !to || to === me.id) return;
    const target = onlineUsers[to];
    if (!target || !DB.users[to] || DB.users[to].banned) return socket.emit('call_unavailable', { from:to, reason:'offline' });
    if (calls.has(me.id)) return socket.emit('call_unavailable', { from:to, reason:'self_busy' });
    if (calls.has(to)) return socket.emit('call_busy', { from:to });
    const timer = setTimeout(() => {
      const c = calls.get(me.id); if (!c || c.accepted) return;
      clearCall(me.id, { event:'call_end', reason:'timeout' });
      const mine = onlineUsers[me.id]; if (mine) io.to(mine.socketId).emit('call_end', { from:to, reason:'timeout' });
    }, 45000);
    calls.set(me.id, { peer:to, caller:true, accepted:false, timer });
    calls.set(to, { peer:me.id, caller:false, accepted:false, timer });
    io.to(target.socketId).emit('call_invite', { from:me.id, fromName:me.username, type: type === 'video' ? 'video' : 'audio' });
  });
  socket.on('call_accept', ({ to } = {}) => {
    const me = socket.data.user, c = me && calls.get(me.id); to = String(to || '');
    if (!c || c.peer !== to || c.caller || c.accepted) return;
    clearTimeout(c.timer); c.accepted = true; const other = calls.get(to); if (other) other.accepted = true;
    const target = onlineUsers[to]; if (target) io.to(target.socketId).emit('call_accept', { from:me.id });
  });
  socket.on('call_decline', ({ to } = {}) => {
    const me = socket.data.user, c = me && calls.get(me.id); to = String(to || '');
    if (!c || c.peer !== to || c.caller || c.accepted) return;
    clearCall(me.id, { event:'call_decline' });
  });
  socket.on('call_end', ({ to } = {}) => {
    const me = socket.data.user, c = me && calls.get(me.id); to = String(to || '');
    if (!c || c.peer !== to) return;
    clearCall(me.id, { event:'call_end', reason:'hangup' });
  });
  socket.on('call_signal', ({ to, kind, sdp, candidate } = {}) => {
    const me = socket.data.user, c = me && calls.get(me.id); to = String(to || '');
    if (!c || c.peer !== to || !c.accepted) return;
    if (!['offer','answer','ice'].includes(kind)) return;
    if (kind !== 'ice' && (typeof sdp !== 'string' || sdp.length > 60000)) return;
    if (kind === 'ice' && (candidate !== null && (typeof candidate !== 'object' || JSON.stringify(candidate).length > 4000))) return;
    const target = onlineUsers[to]; if (!target) return;
    io.to(target.socketId).emit('call_signal', { from:me.id, kind, sdp: kind === 'ice' ? undefined : sdp, candidate: kind === 'ice' ? candidate : undefined });
  });

  // El chat privado solo se almacena y notifica mediante la API E2EE.
  // No se reenvían eventos `msg` antiguos que pudieran contener texto plano.
  socket.on('user_online', ({ userId, username, color }) => {
    const user = socket.data.user;
    if (!user || user.id !== userId) return;
    onlineUsers[user.id] = { ...(onlineUsers[user.id]||{}), socketId: socket.id, username:user.username, color:user.color };
    connSockets[socket.id] = { ...(connSockets[socket.id]||{}), userId:user.id, username:user.username, color:user.color };
    // Persistir onlineAt en DB para que el cliente lo vea
    DB.users[user.id].onlineAt = Date.now();
    io.emit('online_update', { userId:user.id, online:true });
    emitPresence(user.id);
  });

  socket.on('join_game', data => {
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
      x:0,y:3,z:0, ry:0, anim:0, moving:false, onGround:false, mapId, instanceId, joinedAt:Date.now(),
    };
    room.players[socket.id] = pd;
    connSockets[socket.id] = { ...(connSockets[socket.id]||{}), userId, username, color, mapId, instanceId };
    socket.join(channel);
    if (user) {
      onlineUsers[user.id] = { ...(onlineUsers[user.id]||{}), socketId:socket.id, username, color, mapId, instanceId };
      io.emit('online_update', { userId:user.id, online:true, mapId, instanceId });
      emitPresence(user.id);
    }
    startRoomServerScripts(room,storedMap);
    sendRoomPlayersToRunner(room);
    log('JOIN', `${username} → ${mapId} / ${instanceId}`);
    socket.emit('room_state', {
      players: roomPlayers(room).filter(p=>p.socketId!==socket.id),
      chat: room.chat.slice(-30), mapId, instanceId,
      ...roomWorldSnapshot(room), scriptRuntime:room.scriptStatus,
    });
    socket.to(channel).emit('player_joined', pd);
    socket.emit('join_ack', { socketId:socket.id, mapId, instanceId, playerCount:Object.keys(room.players).length });
  });

  socket.on('player_move', data => {
    const meta = connSockets[socket.id]; if (!meta?.mapId) return;
    const room = rooms[roomKey(meta.mapId, meta.instanceId)]; if (!room?.players[socket.id]) return;
    const p = room.players[socket.id];
    const bounded=(value,previous,min=-10000,max=10000)=>{const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):previous;};
    p.x=bounded(data?.x,p.x);p.y=bounded(data?.y,p.y);p.z=bounded(data?.z,p.z);
    p.ry=bounded(data?.ry,p.ry,-1000,1000);p.anim=bounded(data?.anim,p.anim,-10,10);p.moving=!!data?.moving;p.onGround=!!data?.onGround;
    sendRoomPlayersToRunner(room);
    socket.to(gameChannel(meta.mapId, meta.instanceId)).emit('player_moved',
      { socketId:socket.id, x:p.x,y:p.y,z:p.z, ry:p.ry, anim:p.anim, moving:p.moving });
  });

  socket.on('game_chat', data => {
    const meta = connSockets[socket.id]; if (!meta?.mapId||!data?.text) return;
    const msg = { socketId:socket.id, username:meta.username, text:String(data.text).slice(0,200), type:'chat' };
    const room = rooms[roomKey(meta.mapId, meta.instanceId)]; if (!room) return;
    room.chat.push({...msg, time:new Date().toISOString()});
    if (room.chat.length>100) room.chat.shift();
    io.to(gameChannel(meta.mapId, meta.instanceId)).emit('game_chat', msg);
  });

  socket.on('ping_req', ts => socket.emit('pong_res', ts));

  socket.on('leave_game', () => {
    const meta = connSockets[socket.id]; if (meta?.mapId) leaveRoom(socket, meta.mapId, meta.instanceId);
  });

  socket.on('get_online_users', () => {
    socket.emit('online_users_list', Object.keys(onlineUsers));
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
    const meta = connSockets[socket.id];
    if (meta?.mapId) leaveRoom(socket, meta.mapId, meta.instanceId);
    if (meta?.userId) {
      const presence = onlineUsers[meta.userId];
      if (presence?.socketId === socket.id) {
        clearCall(meta.userId, { event:'call_end', reason:'disconnect' });
        delete onlineUsers[meta.userId];
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
    delete room.players[socket.id];
  }
  if(Object.keys(room.players).length){sendRoomPlayersToRunner(room);}
  else{
    if(scriptRunner?.connected&&room.scriptStarted)scriptRunner.send({type:'stop',roomId:roomKey(mapId,instanceId)});
    room.scriptStarted=false;room.scriptStatus='stopped';room.pendingReset=true;
  }
  socket.leave(channel);
  const meta = connSockets[socket.id];
  if (meta) { meta.mapId = null; meta.instanceId = null; }
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
      const s = io.sockets.sockets.get(sid);
      if (!s||!s.connected) {
        delete room.players[sid];
        removedPlayer=true;
        io.to(gameChannel(room.mapId, room.instanceId)).emit('player_left', { socketId:sid });
      }
    }
    if(removedPlayer){
      if(Object.keys(room.players).length)sendRoomPlayersToRunner(room);
      else{if(scriptRunner?.connected&&room.scriptStarted)scriptRunner.send({type:'stop',roomId:roomKey(room.mapId,room.instanceId)});room.scriptStarted=false;room.scriptStatus='stopped';room.pendingReset=true;}
    }
    if (!Object.keys(room.players).length && Date.now()-room.createdAt > 30*60*1000) { if(scriptRunner?.connected&&room.scriptStarted)scriptRunner.send({type:'stop',roomId:roomKey(room.mapId,room.instanceId)});delete rooms[key]; }
  }
}, 30000);

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════╗');
  console.log('  ║    CRIX — Servidor Multijugador  ║');
  console.log('  ╠══════════════════════════════════╣');
  console.log(`  ║  Puerto : ${PORT}                    ║`);
  console.log(`  ║  URL    : http://localhost:${PORT}   ║`);
  console.log('  ╚══════════════════════════════════╝');
  console.log('');
});

// Render envía SIGTERM en cada deploy: guardar y subir todo lo pendiente antes de salir.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`[${signal}] Guardando datos antes de salir…`);
  try { saveDB(); await persist.flush(25000); } catch (e) { console.error('[SHUTDOWN]', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
