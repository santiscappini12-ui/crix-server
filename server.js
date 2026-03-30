const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  20000,
  pingInterval: 10000,
});

const PORT = process.env.PORT || 3000;

const rooms = {};
const connectedSockets = {};
const stats = {
  totalConnections: 0,
  peakConcurrent:   0,
  startTime:        Date.now(),
};

function getRoom(mapId) {
  if (!rooms[mapId]) rooms[mapId] = { players: {}, chat: [] };
  return rooms[mapId];
}

function addChatMsg(mapId, msg) {
  const room = getRoom(mapId);
  room.chat.push({ ...msg, time: new Date().toISOString() });
  if (room.chat.length > 100) room.chat.shift();
}

function getRoomPlayers(mapId) {
  return Object.values(getRoom(mapId).players);
}

function countOnline() {
  return Object.keys(connectedSockets).length;
}

function logEvent(type, data) {
  const ts = new Date().toLocaleTimeString('es-AR');
  console.log(`[${ts}] ${type}:`, data);
}

// ── Servir archivos estáticos desde la raíz (donde está index.html) ──
app.use(express.static(path.join(__dirname)));

app.get('/status', (req, res) => {
  const rooms_info = {};
  for (const [mapId, room] of Object.entries(rooms)) {
    rooms_info[mapId] = {
      players: Object.keys(room.players).length,
      chatMessages: room.chat.length,
    };
  }
  res.json({
    status:   'online',
    online:   countOnline(),
    peak:     stats.peakConcurrent,
    uptime_s: Math.floor((Date.now() - stats.startTime) / 1000),
    rooms:    rooms_info,
  });
});

io.on('connection', (socket) => {
  stats.totalConnections++;
  logEvent('CONNECT', socket.id);

  socket.on('join_game', (data) => {
    const { mapId, userId, username, color } = data;
    if (!mapId || !username) return;
    const prev = connectedSockets[socket.id];
    if (prev?.mapId && prev.mapId !== mapId) leaveRoom(socket, prev.mapId);
    const room = getRoom(mapId);
    const playerData = {
      socketId: socket.id,
      userId:   userId || socket.id,
      username: username.substring(0, 20),
      color:    color || '#5b8def',
      x: 0, y: 3, z: 0,
      ry: 0, anim: 0, moving: false,
      mapId,
      joinedAt: Date.now(),
    };
    room.players[socket.id] = playerData;
    connectedSockets[socket.id] = { userId, username, color, mapId };
    socket.join('map_' + mapId);
    const online = countOnline();
    if (online > stats.peakConcurrent) stats.peakConcurrent = online;
    logEvent('JOIN', `${username} → mapa ${mapId}`);
    socket.emit('room_state', {
      players: getRoomPlayers(mapId).filter(p => p.socketId !== socket.id),
      chat:    room.chat.slice(-30),
      mapId,
    });
    socket.to('map_' + mapId).emit('player_joined', playerData);
    socket.emit('join_ack', {
      socketId: socket.id,
      mapId,
      playerCount: Object.keys(room.players).length,
    });
  });

  socket.on('player_move', (data) => {
    const meta = connectedSockets[socket.id];
    if (!meta?.mapId) return;
    const room = rooms[meta.mapId];
    if (!room?.players[socket.id]) return;
    const p = room.players[socket.id];
    p.x      = data.x      ?? p.x;
    p.y      = data.y      ?? p.y;
    p.z      = data.z      ?? p.z;
    p.ry     = data.ry     ?? p.ry;
    p.anim   = data.anim   ?? p.anim;
    p.moving = data.moving ?? p.moving;
    socket.to('map_' + meta.mapId).emit('player_moved', {
      socketId: socket.id,
      x: p.x, y: p.y, z: p.z,
      ry: p.ry, anim: p.anim, moving: p.moving,
    });
  });

  socket.on('game_chat', (data) => {
    const meta = connectedSockets[socket.id];
    if (!meta?.mapId || !data?.text) return;
    const text = String(data.text).substring(0, 200);
    const msg = { socketId: socket.id, username: meta.username, text, type: 'chat' };
    addChatMsg(meta.mapId, msg);
    io.to('map_' + meta.mapId).emit('game_chat', msg);
  });

  socket.on('private_msg', (data) => {
    const meta = connectedSockets[socket.id];
    if (!meta || !data?.toSocketId) return;
    const payload = {
      fromSocketId: socket.id,
      fromUsername: meta.username,
      fromColor:    meta.color,
      text:         data.text?.substring(0, 500),
      type:         data.type || 'text',
      mediaData:    data.mediaData || null,
      filename:     data.filename  || null,
      time:         new Date().toISOString(),
    };
    io.to(data.toSocketId).emit('private_msg', payload);
    socket.emit('private_msg_ack', { toSocketId: data.toSocketId });
  });

  socket.on('request_players', () => {
    const meta = connectedSockets[socket.id];
    if (!meta?.mapId) return;
    socket.emit('room_state', {
      players: getRoomPlayers(meta.mapId).filter(p => p.socketId !== socket.id),
      chat:    [],
      mapId:   meta.mapId,
    });
  });

  socket.on('ping_req', (ts) => {
    socket.emit('pong_res', ts);
  });

  socket.on('disconnect', (reason) => {
    const meta = connectedSockets[socket.id];
    if (meta?.mapId) leaveRoom(socket, meta.mapId);
    delete connectedSockets[socket.id];
    logEvent('DISCONNECT', `${meta?.username || socket.id} (${reason})`);
  });

  socket.on('leave_game', () => {
    const meta = connectedSockets[socket.id];
    if (meta?.mapId) leaveRoom(socket, meta.mapId);
  });
});

function leaveRoom(socket, mapId) {
  const room = rooms[mapId];
  if (!room) return;
  const player = room.players[socket.id];
  if (player) {
    socket.to('map_' + mapId).emit('player_left', { socketId: socket.id });
    delete room.players[socket.id];
    logEvent('LEAVE', `${player.username} ← mapa ${mapId}`);
  }
  socket.leave('map_' + mapId);
}

setInterval(() => {
  for (const [mapId, room] of Object.entries(rooms)) {
    for (const [sid, player] of Object.entries(room.players)) {
      const sock = io.sockets.sockets.get(sid);
      if (!sock || !sock.connected) {
        delete room.players[sid];
        io.to('map_' + mapId).emit('player_left', { socketId: sid });
        logEvent('CLEANUP', `zombie ${sid} removed from map ${mapId}`);
      }
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════╗');
  console.log('  ║      CRIX Multiplayer Server  ║');
  console.log('  ╠═══════════════════════════════╣');
  console.log(`  ║  Puerto  : ${PORT}                 ║`);
  console.log(`  ║  Status  : http://localhost:${PORT}/status ║`);
  console.log(`  ║  Juego   : http://localhost:${PORT}  ║`);
  console.log('  ╚═══════════════════════════════╝');
  console.log('');
});
