const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  20000,
  pingInterval: 10000,
});
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'crix_data.json');

// ══ BASE DE DATOS EN MEMORIA (persistida en JSON) ══
let DB = { users: {}, maps: {}, convs: {} };

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      DB.users = DB.users || {}; DB.maps = DB.maps || {}; DB.convs = DB.convs || {};
      console.log(`[DB] ${Object.keys(DB.users).length} usuarios, ${Object.keys(DB.maps).length} mapas`);
    }
  } catch(e) { console.error('[DB] Error al cargar:', e.message); }
}
function saveDB() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(DB), 'utf8'); }
  catch(e) { console.error('[DB] Error al guardar:', e.message); }
}
setInterval(saveDB, 30000);
loadDB();

// ══ ESTADO EN MEMORIA ══
const rooms = {};
const connectedSockets = {};
const onlineUsers = {};
const stats = { totalConnections: 0, peakConcurrent: 0, startTime: Date.now() };

function getRoom(mapId) { if (!rooms[mapId]) rooms[mapId] = { players: {}, chat: [] }; return rooms[mapId]; }
function addChatMsg(mapId, msg) { const r = getRoom(mapId); r.chat.push({...msg, time: new Date().toISOString()}); if (r.chat.length > 100) r.chat.shift(); }
function getRoomPlayers(mapId) { return Object.values(getRoom(mapId).players); }
function countOnline() { return Object.keys(onlineUsers).length; }
function logEvent(type, data) { console.log(`[${new Date().toLocaleTimeString('es-AR')}] ${type}:`, data); }

// ══ API REST ══
app.use(express.static(path.join(__dirname)));

// Registrar
app.post('/api/register', (req, res) => {
  const { username, pw, color, id } = req.body;
  if (!username || !pw) return res.json({ ok: false, err: 'Faltan campos' });
  const exists = Object.values(DB.users).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (exists) return res.json({ ok: false, err: 'Nombre ya en uso' });
  const uid = id || String(Date.now());
  const user = { id: uid, username, pw, color: color || '#5b8def', created: new Date().toISOString(), friends: [], games: [], visits: 0, bio: '', following: [], liked: [] };
  DB.users[uid] = user; saveDB();
  const { pw: _, ...safeUser } = user;
  res.json({ ok: true, user: safeUser });
});

// Login
app.post('/api/login', (req, res) => {
  const { username, pw } = req.body;
  if (!username || !pw) return res.json({ ok: false, err: 'Faltan campos' });
  const user = Object.values(DB.users).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.json({ ok: false, err: 'Usuario no encontrado' });
  if (user.pw !== pw) return res.json({ ok: false, err: 'Contraseña incorrecta' });
  if (user.banned) {
    const isPerm = user.banned.permanent;
    const expiry = user.banned.until ? new Date(user.banned.until) : null;
    if (isPerm || (expiry && expiry > new Date())) return res.json({ ok: false, banned: user.banned });
    if (expiry && expiry <= new Date()) { delete user.banned; saveDB(); }
  }
  const { pw: _, ...safeUser } = user;
  res.json({ ok: true, user: safeUser });
});

// Obtener usuario
app.get('/api/user/:id', (req, res) => {
  const u = DB.users[req.params.id];
  if (!u) return res.json({ ok: false });
  const { pw: _, ...safe } = u;
  res.json({ ok: true, user: safe });
});

// Actualizar usuario
app.post('/api/user/:id', (req, res) => {
  const u = DB.users[req.params.id]; if (!u) return res.json({ ok: false });
  const allowed = ['bio','color','friends','games','visits','following','liked','onlineAt','isAdmin','banned','avatar'];
  allowed.forEach(k => { if (req.body[k] !== undefined) u[k] = req.body[k]; });
  DB.users[req.params.id] = u; saveDB();
  io.emit('user_updated', { userId: req.params.id });
  res.json({ ok: true });
});

// Todos los usuarios
app.get('/api/users', (req, res) => {
  const safe = {};
  for (const [id, u] of Object.entries(DB.users)) {
    const { pw: _, ...s } = u;
    if (u.banned && u.banned.permanent) {
      safe[id] = { id, username: 'Banned User', color: '#333344', banned: true, created: u.created };
    } else {
      safe[id] = s;
    }
  }
  res.json({ ok: true, users: safe });
});

// Todos los mapas
app.get('/api/maps', (req, res) => {
  const uid = req.query.userId;
  const maps = {};
  for (const [id, m] of Object.entries(DB.maps)) {
    const priv = m.privacy || 'public';
    if (priv === 'public') { maps[id] = m; continue; }
    if (uid && m.authorId === uid) { maps[id] = m; continue; }
    if (uid && priv === 'friends') {
      const u = DB.users[uid];
      if (u && (u.friends||[]).includes(m.authorId)) maps[id] = m;
      continue;
    }
    if (uid && priv === 'assigned') {
      const u = DB.users[uid];
      if (u && (m.assignedPlayers||[]).includes(u.username)) maps[id] = m;
    }
  }
  res.json({ ok: true, maps });
});

// Guardar mapa
app.post('/api/maps', (req, res) => {
  const m = req.body; if (!m || !m.id) return res.json({ ok: false });
  DB.maps[m.id] = m; saveDB();
  io.emit('map_updated', { mapId: m.id });
  res.json({ ok: true });
});

// Borrar mapa
app.delete('/api/maps/:id', (req, res) => {
  delete DB.maps[req.params.id]; saveDB();
  io.emit('map_deleted', { mapId: req.params.id });
  res.json({ ok: true });
});

// Conversaciones
app.get('/api/convs/:userId', (req, res) => {
  const uid = req.params.userId;
  const result = {};
  for (const [cid, msgs] of Object.entries(DB.convs)) {
    if (cid.split('_').includes(uid)) result[cid] = msgs;
  }
  res.json({ ok: true, convs: result });
});

app.post('/api/convs/:convId', (req, res) => {
  const { convId } = req.params; const { msg } = req.body;
  if (!msg) return res.json({ ok: false });
  DB.convs[convId] = DB.convs[convId] || [];
  DB.convs[convId].push(msg);
  if (DB.convs[convId].length > 500) DB.convs[convId] = DB.convs[convId].slice(-500);
  saveDB();
  const parts = convId.split('_');
  parts.forEach(uid => {
    const online = onlineUsers[uid];
    if (online) io.to(online.socketId).emit('new_private_msg', { convId, msg });
  });
  res.json({ ok: true });
});

// Status
app.get('/status', (req, res) => {
  res.json({ status: 'online', online: countOnline(), users: Object.keys(DB.users).length, maps: Object.keys(DB.maps).length, uptime_s: Math.floor((Date.now() - stats.startTime) / 1000) });
});

// ══ SOCKET.IO ══
io.on('connection', (socket) => {
  stats.totalConnections++;

  socket.on('user_online', ({ userId, username, color }) => {
    if (!userId) return;
    onlineUsers[userId] = { socketId: socket.id, since: Date.now(), username, color };
    connectedSockets[socket.id] = { ...connectedSockets[socket.id], userId, username, color };
    io.emit('online_update', { userId, online: true });
  });

  socket.on('join_game', (data) => {
    const { mapId, userId, username, color } = data;
    if (!mapId || !username) return;
    const prev = connectedSockets[socket.id];
    if (prev?.mapId && prev.mapId !== mapId) leaveRoom(socket, prev.mapId);
    const room = getRoom(mapId);
    const playerData = { socketId: socket.id, userId: userId || socket.id, username: username.substring(0, 30), color: color || '#5b8def', x: 0, y: 3, z: 0, ry: 0, anim: 0, moving: false, mapId, joinedAt: Date.now() };
    room.players[socket.id] = playerData;
    connectedSockets[socket.id] = { ...(connectedSockets[socket.id]||{}), userId, username, color, mapId };
    socket.join('map_' + mapId);
    if (countOnline() > stats.peakConcurrent) stats.peakConcurrent = countOnline();
    logEvent('JOIN', `${username} → mapa ${mapId}`);
    socket.emit('room_state', { players: getRoomPlayers(mapId).filter(p => p.socketId !== socket.id), chat: room.chat.slice(-30), mapId });
    socket.to('map_' + mapId).emit('player_joined', playerData);
    socket.emit('join_ack', { socketId: socket.id, mapId, playerCount: Object.keys(room.players).length });
  });

  socket.on('player_move', (data) => {
    const meta = connectedSockets[socket.id]; if (!meta?.mapId) return;
    const room = rooms[meta.mapId]; if (!room?.players[socket.id]) return;
    const p = room.players[socket.id];
    p.x = data.x ?? p.x; p.y = data.y ?? p.y; p.z = data.z ?? p.z;
    p.ry = data.ry ?? p.ry; p.anim = data.anim ?? p.anim; p.moving = data.moving ?? p.moving;
    socket.to('map_' + meta.mapId).emit('player_moved', { socketId: socket.id, x: p.x, y: p.y, z: p.z, ry: p.ry, anim: p.anim, moving: p.moving });
  });

  socket.on('game_chat', (data) => {
    const meta = connectedSockets[socket.id]; if (!meta?.mapId || !data?.text) return;
    const msg = { socketId: socket.id, username: meta.username, text: String(data.text).substring(0, 200), type: 'chat' };
    addChatMsg(meta.mapId, msg);
    io.to('map_' + meta.mapId).emit('game_chat', msg);
  });

  socket.on('ping_req', (ts) => socket.emit('pong_res', ts));

  socket.on('disconnect', () => {
    const meta = connectedSockets[socket.id];
    if (meta?.mapId) leaveRoom(socket, meta.mapId);
    if (meta?.userId) { delete onlineUsers[meta.userId]; io.emit('online_update', { userId: meta.userId, online: false }); }
    delete connectedSockets[socket.id];
  });

  socket.on('leave_game', () => { const meta = connectedSockets[socket.id]; if (meta?.mapId) leaveRoom(socket, meta.mapId); });
});

function leaveRoom(socket, mapId) {
  const room = rooms[mapId]; if (!room) return;
  const player = room.players[socket.id];
  if (player) { socket.to('map_' + mapId).emit('player_left', { socketId: socket.id }); delete room.players[socket.id]; }
  socket.leave('map_' + mapId);
  if (connectedSockets[socket.id]) connectedSockets[socket.id].mapId = null;
}

setInterval(() => {
  for (const [mapId, room] of Object.entries(rooms)) {
    for (const [sid] of Object.entries(room.players)) {
      const sock = io.sockets.sockets.get(sid);
      if (!sock || !sock.connected) { delete room.players[sid]; io.to('map_' + mapId).emit('player_left', { socketId: sid }); }
    }
  }
  saveDB();
}, 30000);

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════╗');
  console.log('  ║      CRIX Multiplayer Server  ║');
  console.log('  ╠═══════════════════════════════╣');
  console.log(`  ║  Puerto  : ${PORT}               ║`);
  console.log(`  ║  Juego   : http://localhost:${PORT} ║`);
  console.log('  ╚═══════════════════════════════╝');
  console.log('');
});
