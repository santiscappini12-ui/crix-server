/**
 * Crix — Servidor Multiplayer
 * Node.js + Socket.IO
 *
 * Funciones:
 *  - Salas por mapa (mapId) — cada juego tiene su propia sala
 *  - Sync de posición, rotación y animación de jugadores (~20 tick/s)
 *  - Chat público en juego con historial por sala
 *  - Lista de jugadores conectados por sala
 *  - Heartbeat / limpieza de jugadores desconectados
 *  - Mensajería privada entre jugadores (amigos)
 *  - Estado del servidor (ping, jugadores online)
 */

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

// ══════════════════════════════════════════════
// ESTADO EN MEMORIA
// ══════════════════════════════════════════════

/**
 * rooms[mapId] = {
 *   players: {
 *     socketId: { id, username, color, x, y, z, ry, anim, moving, mapId, joinedAt }
 *   },
 *   chat: [ { username, text, time, type } ]  (últimos 100 msgs)
 * }
 */
const rooms = {};

// socketId -> { userId, username, color, mapId }
const connectedSockets = {};

// Estadísticas globales
const stats = {
  totalConnections: 0,
  peakConcurrent:   0,
  startTime:        Date.now(),
};

// ══════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════
function getRoom(mapId) {
  if (!rooms[mapId]) {
    rooms[mapId] = { players: {}, chat: [] };
  }
  return rooms[mapId];
}

function addChatMsg(mapId, msg) {
  const room = getRoom(mapId);
  room.chat.push({ ...msg, time: new Date().toISOString() });
  if (room.chat.length > 100) room.chat.shift();
}

function getRoomPlayers(mapId) {
  const room = getRoom(mapId);
  return Object.values(room.players);
}

function countOnline() {
  return Object.keys(connectedSockets).length;
}

function logEvent(type, data) {
  const ts = new Date().toLocaleTimeString('es-AR');
  console.log(`[${ts}] ${type}:`, data);
}

// ══════════════════════════════════════════════
// HTTP — servir el HTML del juego
// ══════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));

// Health check / status
app.get('/status', (req, res) => {
  const rooms_info = {};
  for (const [mapId, room] of Object.entries(rooms)) {
    rooms_info[mapId] = {
      players: Object.keys(room.players).length,
      chatMessages: room.chat.length,
    };
  }
  res.json({
    status:     'online',
    online:     countOnline(),
    peak:       stats.peakConcurrent,
    uptime_s:   Math.floor((Date.now() - stats.startTime) / 1000),
    rooms:      rooms_info,
  });
});

// ══════════════════════════════════════════════
// SOCKET.IO — EVENTOS
// ══════════════════════════════════════════════
io.on('connection', (socket) => {
  stats.totalConnections++;
  logEvent('CONNECT', socket.id);

  // ── join_game ──
  // Jugador entra a un mapa
  // data: { mapId, userId, username, color }
  socket.on('join_game', (data) => {
    const { mapId, userId, username, color } = data;
    if (!mapId || !username) return;

    // Si ya estaba en otro mapa, sacarlo de ahí
    const prev = connectedSockets[socket.id];
    if (prev?.mapId && prev.mapId !== mapId) {
      leaveRoom(socket, prev.mapId);
    }

    // Registrar en el mapa nuevo
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

    // Actualizar peak
    const online = countOnline();
    if (online > stats.peakConcurrent) stats.peakConcurrent = online;

    logEvent('JOIN', `${username} → mapa ${mapId} (${Object.keys(room.players).length} jugadores)`);

    // 1. Decirle a este jugador quién más está en el mapa
    socket.emit('room_state', {
      players:  getRoomPlayers(mapId).filter(p => p.socketId !== socket.id),
      chat:     room.chat.slice(-30), // últimos 30 mensajes
      mapId,
    });

    // 2. Avisarles a los demás que llegó alguien
    socket.to('map_' + mapId).emit('player_joined', playerData);

    // 3. Confirmación al propio jugador
    socket.emit('join_ack', {
      socketId: socket.id,
      mapId,
      playerCount: Object.keys(room.players).length,
    });
  });

  // ── player_move ──
  // Envío de posición cada ~50ms (20 tick/s)
  // data: { x, y, z, ry, anim, moving }
  socket.on('player_move', (data) => {
    const meta = connectedSockets[socket.id];
    if (!meta?.mapId) return;

    const room = rooms[meta.mapId];
    if (!room?.players[socket.id]) return;

    // Actualizar estado del jugador
    const p = room.players[socket.id];
    p.x      = data.x      ?? p.x;
    p.y      = data.y      ?? p.y;
    p.z      = data.z      ?? p.z;
    p.ry     = data.ry     ?? p.ry;
    p.anim   = data.anim   ?? p.anim;
    p.moving = data.moving ?? p.moving;

    // Broadcastear a la sala (sin el emisor)
    socket.to('map_' + meta.mapId).emit('player_moved', {
      socketId: socket.id,
      x: p.x, y: p.y, z: p.z,
      ry: p.ry, anim: p.anim, moving: p.moving,
    });
  });

  // ── game_chat ──
  // Chat público en el juego
  // data: { text }
  socket.on('game_chat', (data) => {
    const meta = connectedSockets[socket.id];
    if (!meta?.mapId || !data?.text) return;

    // Longitud máxima
    const text = String(data.text).substring(0, 200);

    const msg = {
      socketId: socket.id,
      username: meta.username,
      text,
      type: 'chat',
    };

    addChatMsg(meta.mapId, msg);

    // Broadcastear a toda la sala (incluyendo al emisor)
    io.to('map_' + meta.mapId).emit('game_chat', msg);
  });

  // ── private_msg ──
  // Mensaje privado a otro jugador (por socketId o userId)
  // data: { toSocketId, text, type, data (para archivos/audio) }
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
    // Echo al emisor para confirmar entrega
    socket.emit('private_msg_ack', { toSocketId: data.toSocketId });
  });

  // ── request_players ──
  // Pedir lista actualizada de jugadores en la sala
  socket.on('request_players', () => {
    const meta = connectedSockets[socket.id];
    if (!meta?.mapId) return;
    socket.emit('room_state', {
      players:  getRoomPlayers(meta.mapId).filter(p => p.socketId !== socket.id),
      chat:     [],
      mapId:    meta.mapId,
    });
  });

  // ── ping ──
  // Para medir latencia desde el cliente
  socket.on('ping_req', (ts) => {
    socket.emit('pong_res', ts);
  });

  // ── disconnect ──
  socket.on('disconnect', (reason) => {
    const meta = connectedSockets[socket.id];
    if (meta?.mapId) {
      leaveRoom(socket, meta.mapId);
    }
    delete connectedSockets[socket.id];
    logEvent('DISCONNECT', `${meta?.username || socket.id} (${reason})`);
  });

  // ── leave_game (explícito) ──
  socket.on('leave_game', () => {
    const meta = connectedSockets[socket.id];
    if (meta?.mapId) leaveRoom(socket, meta.mapId);
  });
});

// ══════════════════════════════════════════════
// HELPERS INTERNOS
// ══════════════════════════════════════════════
function leaveRoom(socket, mapId) {
  const room = rooms[mapId];
  if (!room) return;

  const player = room.players[socket.id];
  if (player) {
    socket.to('map_' + mapId).emit('player_left', { socketId: socket.id });
    delete room.players[socket.id];
    logEvent('LEAVE', `${player.username} ← mapa ${mapId} (${Object.keys(room.players).length} quedan)`);
  }

  socket.leave('map_' + mapId);

  // Limpiar sala vacía
  if (Object.keys(room.players).length === 0) {
    // Mantener el chat pero borrar la referencia si querés ahorrar memoria
    // delete rooms[mapId];
  }
}

// ══════════════════════════════════════════════
// TICK — limpieza periódica de jugadores zombie
// ══════════════════════════════════════════════
setInterval(() => {
  const now = Date.now();
  for (const [mapId, room] of Object.entries(rooms)) {
    for (const [sid, player] of Object.entries(room.players)) {
      // Si el socket ya no existe, limpiarlo
      const sock = io.sockets.sockets.get(sid);
      if (!sock || !sock.connected) {
        delete room.players[sid];
        io.to('map_' + mapId).emit('player_left', { socketId: sid });
        logEvent('CLEANUP', `zombie player ${sid} removed from map ${mapId}`);
      }
    }
  }

  // Log estado cada 30s
  const online = countOnline();
  if (online > 0) {
    console.log(`[TICK] Online: ${online} | Salas activas: ${Object.keys(rooms).filter(id => Object.keys(rooms[id].players).length > 0).length}`);
  }
}, 30000);

// ══════════════════════════════════════════════
// START
// ══════════════════════════════════════════════
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════╗');
  console.log('  ║      CRIX Multiplayer Server  ║');
  console.log('  ╠═══════════════════════════════╣');
  console.log(`  ║  Puerto  : ${PORT}                 ║`);
  console.log(`  ║  Status  : http://localhost:${PORT}/status ║`);
  console.log('  ║  Juego   : http://localhost:3000  ║');
  console.log('  ╚═══════════════════════════════╝');
  console.log('');
});
