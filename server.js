const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 20000, pingInterval: 10000,
});
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'crix_data.json');

// ══════════════════════════════════════════════
// BASE DE DATOS — archivo JSON local
// En Render gratuito el archivo dura mientras el
// proceso vive (~15 min sin tráfico). Para que
// sobreviva reinicios se usa un backup en memoria
// y se guarda frecuentemente.
// ══════════════════════════════════════════════
let DB = { users: {}, maps: {}, convs: {}, videos: [], posts: [], _v: 0 };

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      DB = { users:{}, maps:{}, convs:{}, _v:0, ...parsed };
      console.log(`[DB] Cargado: ${Object.keys(DB.users).length} usuarios, ${Object.keys(DB.maps).length} mapas`);
    } else {
      console.log('[DB] Archivo nuevo — empezando vacío');
    }
  } catch(e) { console.error('[DB] Error al cargar:', e.message); }
}

function saveDB() {
  try {
    DB._v = (DB._v || 0) + 1;
    fs.writeFileSync(DATA_FILE, JSON.stringify(DB), 'utf8');
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

function getRoom(mapId) {
  if (!rooms[mapId]) rooms[mapId] = { players:{}, chat:[] };
  return rooms[mapId];
}
function roomPlayers(mapId) { return Object.values(getRoom(mapId).players); }
function log(t,d) { console.log(`[${new Date().toLocaleTimeString()}] ${t}:`, d); }
function safeUser(u) { if (!u) return null; const {pw:_,...s}=u; return s; }

// ══════════════════════════════════════════════
// HTTP — archivos estáticos
// ══════════════════════════════════════════════
app.use(express.static(path.join(__dirname)));

// ── REGISTER ──
app.post('/api/register', (req, res) => {
  try {
    const { username, pw, color, id } = req.body;
    if (!username || !pw) return res.json({ ok:false, err:'Faltan campos' });
    const dup = Object.values(DB.users).find(u =>
      u.username.toLowerCase() === username.toLowerCase()
    );
    if (dup) return res.json({ ok:false, err:'Ese nombre ya existe' });
    const uid = id || `u${Date.now()}`;
    const user = {
      id: uid, username, pw, color: color||'#5b8def',
      created: new Date().toISOString(),
      friends:[], games:[], visits:0, bio:'',
      following:[], liked:[], isAdmin: false,
    };
    // El primer usuario registrado es admin automáticamente si se llama Crix
    if (username.toLowerCase() === 'crix') user.isAdmin = true;
    DB.users[uid] = user;
    saveDB();
    log('REGISTER', username);
    res.json({ ok:true, user: safeUser(user) });
  } catch(e) { res.json({ ok:false, err:e.message }); }
});

// ── LOGIN ──
app.post('/api/login', (req, res) => {
  try {
    const { username, pw } = req.body;
    if (!username || !pw) return res.json({ ok:false, err:'Faltan campos' });
    const user = Object.values(DB.users).find(u =>
      u.username.toLowerCase() === username.toLowerCase()
    );
    if (!user) return res.json({ ok:false, err:'Usuario no encontrado' });
    if (user.pw !== pw) return res.json({ ok:false, err:'Contraseña incorrecta' });
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
    res.json({ ok:true, user: safeUser(user) });
  } catch(e) { res.json({ ok:false, err:e.message }); }
});

// ── GET usuario ──
app.get('/api/user/:id', (req, res) => {
  const u = DB.users[req.params.id];
  if (!u) return res.json({ ok:false, err:'No encontrado' });
  res.json({ ok:true, user: safeUser(u) });
});

// ── UPDATE usuario ──
app.post('/api/user/:id', (req, res) => {
  try {
    const u = DB.users[req.params.id];
    if (!u) return res.json({ ok:false });
    const allowed = ['bio','color','friends','games','visits','following',
                     'liked','onlineAt','isAdmin','banned','avatar'];
    allowed.forEach(k => { if (req.body[k] !== undefined) u[k] = req.body[k]; });
    DB.users[req.params.id] = u;
    saveDB();
    io.emit('user_updated', { userId: req.params.id });
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, err:e.message }); }
});

// ── GET todos los usuarios (sin pw) ──
app.get('/api/users', (req, res) => {
  const out = {};
  for (const [id, u] of Object.entries(DB.users)) {
    if (u.banned && u.banned.permanent) {
      out[id] = { id, username:'Banned User', color:'#333344', banned:true, created:u.created };
    } else {
      out[id] = safeUser(u);
    }
  }
  res.json({ ok:true, users: out });
});

// ── GET mapas ──
app.get('/api/maps', (req, res) => {
  const uid  = req.query.userId;
  const uObj = uid ? DB.users[uid] : null;
  const out  = {};
  for (const [id, m] of Object.entries(DB.maps)) {
    const priv = m.privacy || 'public';
    if (priv === 'public')   { out[id]=m; continue; }
    if (uid && m.authorId === uid) { out[id]=m; continue; }
    if (uid && priv === 'friends' && uObj && (uObj.friends||[]).includes(m.authorId)) { out[id]=m; continue; }
    if (uid && priv === 'assigned' && uObj && (m.assignedPlayers||[]).includes(uObj.username)) { out[id]=m; continue; }
  }
  res.json({ ok:true, maps: out });
});

// ── SAVE mapa ──
app.post('/api/maps', (req, res) => {
  try {
    const m = req.body;
    if (!m || !m.id) return res.json({ ok:false });
    DB.maps[m.id] = m;
    saveDB();
    io.emit('map_updated', { mapId: m.id });
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, err:e.message }); }
});

// ── DELETE mapa ──
app.delete('/api/maps/:id', (req, res) => {
  delete DB.maps[req.params.id];
  saveDB();
  io.emit('map_deleted', { mapId: req.params.id });
  res.json({ ok:true });
});

// ── GET conversaciones de un usuario ──
app.get('/api/convs/:userId', (req, res) => {
  const uid = req.params.userId;
  const out = {};
  for (const [cid, msgs] of Object.entries(DB.convs)) {
    if (cid.split('_').includes(uid)) out[cid] = msgs;
  }
  res.json({ ok:true, convs: out });
});

// ── POST mensaje ──
app.post('/api/convs/:convId', (req, res) => {
  try {
    const { convId } = req.params;
    const { msg } = req.body;
    if (!msg) return res.json({ ok:false });
    DB.convs[convId] = DB.convs[convId] || [];
    DB.convs[convId].push(msg);
    if (DB.convs[convId].length > 500)
      DB.convs[convId] = DB.convs[convId].slice(-500);
    saveDB();
    // Notificar en tiempo real
    convId.split('_').forEach(uid => {
      const o = onlineUsers[uid];
      if (o) io.to(o.socketId).emit('new_private_msg', { convId, msg });
    });
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, err:e.message }); }
});

// ── SOLICITUDES DE AMISTAD ──
app.post('/api/friend-request', (req, res) => {
  try {
    const { fromId, toId } = req.body;
    if (!fromId || !toId || fromId === toId) return res.json({ok:false,err:'IDs inválidos'});
    const from = DB.users[fromId]; const to = DB.users[toId];
    if (!from || !to) return res.json({ok:false,err:'Usuario no encontrado'});
    // No duplicar solicitudes
    to.friendRequests_recv = to.friendRequests_recv || [];
    from.friendRequests_sent = from.friendRequests_sent || [];
    if (!to.friendRequests_recv.includes(fromId)) to.friendRequests_recv.push(fromId);
    if (!from.friendRequests_sent.includes(toId)) from.friendRequests_sent.push(toId);
    DB.users[fromId] = from; DB.users[toId] = to; saveDB();
    // Notificar en tiempo real si está online
    const toOnline = onlineUsers[toId];
    if (toOnline) io.to(toOnline.socketId).emit('friend_request', { from: { id:from.id, username:from.username, color:from.color } });
    res.json({ok:true});
  } catch(e) { res.json({ok:false,err:e.message}); }
});

app.post('/api/friend-accept', (req, res) => {
  try {
    const { fromId, toId } = req.body; // from=quien mandó, to=quien acepta
    if (!fromId || !toId) return res.json({ok:false,err:'IDs inválidos'});
    const from = DB.users[fromId]; const to = DB.users[toId];
    if (!from || !to) return res.json({ok:false,err:'Usuario no encontrado'});
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
    if (fromOnline) io.to(fromOnline.socketId).emit('friend_accepted', { by: { id:to.id, username:to.username, color:to.color } });
    io.emit('user_updated', {userId:fromId}); io.emit('user_updated', {userId:toId});
    res.json({ok:true});
  } catch(e) { res.json({ok:false,err:e.message}); }
});

app.post('/api/friend-reject', (req, res) => {
  try {
    const { fromId, toId } = req.body;
    const from = DB.users[fromId]; const to = DB.users[toId];
    if (from) { from.friendRequests_sent=(from.friendRequests_sent||[]).filter(id=>id!==toId); DB.users[fromId]=from; }
    if (to)   { to.friendRequests_recv=(to.friendRequests_recv||[]).filter(id=>id!==fromId);   DB.users[toId]=to;   }
    saveDB();
    res.json({ok:true});
  } catch(e) { res.json({ok:false,err:e.message}); }
});

// ── VIDEOS ──
app.get('/api/videos', (req, res) => {
  const vids = DB.videos || [];
  // No devolver los datos binarios en el listado (demasiado pesado)
  const safe = vids.map(v => ({ ...v, data: v.data ? '[data]' : null }));
  res.json({ ok: true, videos: safe });
});

app.get('/api/videos/:id/data', (req, res) => {
  const v = (DB.videos || []).find(x => x.id === req.params.id);
  if (!v) return res.json({ ok: false });
  res.json({ ok: true, data: v.data, thumb: v.thumb });
});

app.post('/api/videos', (req, res) => {
  try {
    const v = req.body;
    if (!v || !v.id || !v.title) return res.json({ ok: false, err: 'Faltan campos' });
    DB.videos = DB.videos || [];
    // Reemplazar si ya existe
    const idx = DB.videos.findIndex(x => x.id === v.id);
    if (idx >= 0) DB.videos[idx] = v; else DB.videos.push(v);
    saveDB();
    io.emit('video_new', { id: v.id, title: v.title, authorName: v.authorName, cat: v.cat, thumb: v.thumb, created: v.created });
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, err: e.message }); }
});

app.post('/api/videos/:id/like', (req, res) => {
  const { userId } = req.body;
  const v = (DB.videos || []).find(x => x.id === req.params.id);
  if (!v) return res.json({ ok: false });
  v.likes = v.likes || [];
  const idx = v.likes.indexOf(userId);
  if (idx === -1) v.likes.push(userId); else v.likes.splice(idx, 1);
  saveDB();
  res.json({ ok: true, likes: v.likes.length });
});

app.post('/api/videos/:id/comment', (req, res) => {
  const v = (DB.videos || []).find(x => x.id === req.params.id);
  if (!v) return res.json({ ok: false });
  v.comments = v.comments || [];
  v.comments.push(req.body.comment);
  saveDB();
  res.json({ ok: true });
});

// ── POSTS (Foros) ──
app.get('/api/posts', (req, res) => {
  const posts = (DB.posts || []).slice(-200); // últimos 200
  res.json({ ok: true, posts });
});

app.post('/api/posts', (req, res) => {
  try {
    const p = req.body;
    if (!p || !p.id) return res.json({ ok: false });
    DB.posts = DB.posts || [];
    DB.posts.unshift(p);
    if (DB.posts.length > 500) DB.posts = DB.posts.slice(0, 500);
    saveDB();
    io.emit('new_post', { id: p.id, authorId: p.authorId, authorName: p.authorName, text: (p.text||'').substring(0,100) });
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, err: e.message }); }
});

app.delete('/api/posts/:id', (req, res) => {
  DB.posts = (DB.posts || []).filter(p => p.id !== req.params.id);
  saveDB();
  io.emit('post_deleted', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/posts/:id/like', (req, res) => {
  const { userId } = req.body;
  const p = (DB.posts || []).find(x => x.id === req.params.id);
  if (!p) return res.json({ ok: false });
  p.likes = p.likes || [];
  const idx = p.likes.indexOf(userId);
  if (idx === -1) p.likes.push(userId); else p.likes.splice(idx, 1);
  saveDB();
  res.json({ ok: true, likes: p.likes.length });
});

app.post('/api/posts/:id/reply', (req, res) => {
  const p = (DB.posts || []).find(x => x.id === req.params.id);
  if (!p) return res.json({ ok: false });
  p.replies = p.replies || [];
  p.replies.push(req.body.reply);
  saveDB();
  res.json({ ok: true });
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

// Auto-ping cada 13 minutos para no dormir
setInterval(() => {
  try {
    https.get(`https://crix-server-1.onrender.com/ping`, r => {
      log('AUTOPing', r.statusCode);
    }).on('error', ()=>{});
  } catch(e) {}
}, 13 * 60 * 1000);

// ══════════════════════════════════════════════
// SOCKET.IO
// ══════════════════════════════════════════════
io.on('connection', socket => {
  stats.total++;

  socket.on('user_online', ({ userId, username, color }) => {
    if (!userId) return;
    onlineUsers[userId] = { socketId: socket.id, username, color };
    connSockets[socket.id] = { ...(connSockets[socket.id]||{}), userId, username, color };
    // Persistir onlineAt en DB para que el cliente lo vea
    if (DB.users[userId]) { DB.users[userId].onlineAt = Date.now(); }
    io.emit('online_update', { userId, online:true });
  });

  socket.on('join_game', data => {
    const { mapId, userId, username, color } = data;
    if (!mapId || !username) return;
    const prev = connSockets[socket.id];
    if (prev?.mapId && prev.mapId !== mapId) leaveRoom(socket, prev.mapId);
    const room = getRoom(mapId);
    const pd = {
      socketId: socket.id, userId: userId||socket.id,
      username: username.substring(0,30), color: color||'#5b8def',
      x:0,y:3,z:0, ry:0, anim:0, moving:false, mapId, joinedAt:Date.now(),
    };
    room.players[socket.id] = pd;
    connSockets[socket.id] = { ...(connSockets[socket.id]||{}), userId, username, color, mapId };
    socket.join('map_'+mapId);
    log('JOIN', `${username} → ${mapId}`);
    socket.emit('room_state', {
      players: roomPlayers(mapId).filter(p=>p.socketId!==socket.id),
      chat: room.chat.slice(-30), mapId,
    });
    socket.to('map_'+mapId).emit('player_joined', pd);
    socket.emit('join_ack', { socketId:socket.id, mapId, playerCount:Object.keys(room.players).length });
  });

  socket.on('player_move', data => {
    const meta = connSockets[socket.id]; if (!meta?.mapId) return;
    const room = rooms[meta.mapId]; if (!room?.players[socket.id]) return;
    const p = room.players[socket.id];
    p.x=data.x??p.x; p.y=data.y??p.y; p.z=data.z??p.z;
    p.ry=data.ry??p.ry; p.anim=data.anim??p.anim; p.moving=data.moving??p.moving;
    socket.to('map_'+meta.mapId).emit('player_moved',
      { socketId:socket.id, x:p.x,y:p.y,z:p.z, ry:p.ry, anim:p.anim, moving:p.moving });
  });

  socket.on('game_chat', data => {
    const meta = connSockets[socket.id]; if (!meta?.mapId||!data?.text) return;
    const msg = { socketId:socket.id, username:meta.username, text:String(data.text).slice(0,200), type:'chat' };
    const room = getRoom(meta.mapId);
    room.chat.push({...msg, time:new Date().toISOString()});
    if (room.chat.length>100) room.chat.shift();
    io.to('map_'+meta.mapId).emit('game_chat', msg);
  });

  socket.on('ping_req', ts => socket.emit('pong_res', ts));

  socket.on('leave_game', () => {
    const meta = connSockets[socket.id]; if (meta?.mapId) leaveRoom(socket, meta.mapId);
  });

  socket.on('get_online_users', () => {
    socket.emit('online_users_list', Object.keys(onlineUsers));
  });

  // Kick/ban en tiempo real
  socket.on('kick_user', ({ userId, banned }) => {
    if (!userId) return;
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
    if (!userId) return;
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
    if (meta?.mapId) leaveRoom(socket, meta.mapId);
    if (meta?.userId) {
      delete onlineUsers[meta.userId];
      if (DB.users[meta.userId]) { DB.users[meta.userId].onlineAt = null; }
      io.emit('online_update', { userId:meta.userId, online:false });
    }
    delete connSockets[socket.id];
  });
});

function leaveRoom(socket, mapId) {
  const room = rooms[mapId]; if (!room) return;
  if (room.players[socket.id]) {
    socket.to('map_'+mapId).emit('player_left', { socketId:socket.id });
    delete room.players[socket.id];
  }
  socket.leave('map_'+mapId);
  if (connSockets[socket.id]) connSockets[socket.id].mapId = null;
}

// Limpiar zombies cada 30s
setInterval(() => {
  for (const [mapId, room] of Object.entries(rooms)) {
    for (const sid of Object.keys(room.players)) {
      const s = io.sockets.sockets.get(sid);
      if (!s||!s.connected) {
        delete room.players[sid];
        io.to('map_'+mapId).emit('player_left', { socketId:sid });
      }
    }
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
