# Crix — Servidor Multiplayer

Servidor Node.js + Socket.IO para el juego Crix.  
Maneja salas por mapa, sync de posición (~20 tick/s), chat público y latencia.

---

## Instalación rápida

```bash
# 1. Entrá a la carpeta
cd crix-server

# 2. Instalá dependencias
npm install

# 3. Iniciá el servidor
npm start
```

Abrí el juego en: **http://localhost:3000**

---

## Estructura

```
crix-server/
├── server.js          ← Servidor principal (Express + Socket.IO)
├── package.json
├── README.md
└── public/
    └── index.html     ← El juego completo (cliente)
```

---

## Cómo funciona el multiplayer

### Eventos cliente → servidor

| Evento | Descripción |
|---|---|
| `join_game`    | Entrar a la sala de un mapa |
| `player_move`  | Enviar posición/rotación (~20/seg) |
| `game_chat`    | Enviar mensaje al chat público |
| `leave_game`   | Salir de la sala explícitamente |
| `ping_req`     | Medir latencia (timestamp) |

### Eventos servidor → cliente

| Evento | Descripción |
|---|---|
| `join_ack`      | Confirmación de unión con cantidad de jugadores |
| `room_state`    | Estado inicial: jugadores actuales + historial de chat |
| `player_joined` | Un jugador nuevo entró |
| `player_moved`  | Posición actualizada de un jugador |
| `player_left`   | Un jugador salió |
| `game_chat`     | Mensaje de chat de otro jugador |
| `pong_res`      | Respuesta de ping con timestamp |

---

## API REST

| Endpoint | Descripción |
|---|---|
| `GET /status` | Estado: jugadores online, salas activas, uptime |

```json
{
  "status": "online",
  "online": 3,
  "peak": 7,
  "uptime_s": 3600,
  "rooms": {
    "1": { "players": 3, "chatMessages": 12 }
  }
}
```

---

## Despliegue

### Railway / Render / Fly.io
Subí la carpeta `crix-server/`. El puerto se toma de `process.env.PORT` automáticamente.

### VPS con PM2
```bash
npm install -g pm2
pm2 start server.js --name crix
pm2 save
```

### Variables de entorno
```
PORT=3000    # Puerto del servidor (default: 3000)
```

---

## Modo offline

Si el servidor no está disponible, el juego corre igual en modo **single player**.  
El cliente detecta si Socket.IO no responde y degrada sin errores.
