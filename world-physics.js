'use strict';

// Física autoritativa de las piezas de una instancia + detección de contactos para los Script de servidor.
//
// Reglas que se mantienen iguales a las del cliente (index.html → _stepScriptParts / _stepGameplay), para que
// lo que ve cada jugador coincida con lo que "sabe" el servidor:
//   · gravedad 0.018 por paso, caída máxima 0.8 por paso, y pasos de 1/60 s (el servidor acumula tiempo real
//     y hace los pasos que correspondan, en vez de un paso por cada tick de 50 ms);
//   · cada pieza colisiona con su caja alineada a los ejes TAL COMO LA DIBUJA el cliente: con su rotación
//     y con el origen real de cada forma (la cuña, por ejemplo, tiene el origen en la base);
//   · el jugador mide 1 × 3.05 × 1 con el origen en los pies, y los toques usan los mismos márgenes que
//     game.onTouched de los LocalScript.

const STEP = 1 / 60;
const GRAVITY = 0.018;
const MAX_FALL = 0.8;
const SNAP = 0.08;           // tolerancia para "aterrizar" sobre una cara
const CARRY_TOL = 1.5;       // una pieza apoyada acompaña a su soporte si este se movió menos que esto entre pasos
const VOID_Y = -500;         // por debajo de esto la pieza deja de simularse (evita caer para siempre)
const MAX_CATCHUP_STEPS = 12;
const MAX_EVENTS_PER_TICK = 40;
const LANDING_MIN_SPEED = 0; // todos los aterrizajes se registran; cada script filtra con minSpeed

const PLAYER = { halfW: 0.5, halfD: 0.5, height: 3.05 };
const PART_PAD = 0.12;       // margen de toque pieza ↔ jugador (igual que el cliente)
const PLAYER_PAD = 0.1;
const PAIR_PAD = 0.05;       // margen de toque pieza ↔ pieza
const MAX_SWEEP = 16;        // si una pieza se mueve más que esto en un tick es un teletransporte: no se barre el camino

// ── Cajas ────────────────────────────────────────────────────────────────────────────────────────

const shapeCache = new WeakMap();

function localExtents(part) {
  const sx = part.sx, sy = part.sy, sz = part.sz;
  switch (part.type) {
    case 'Sphere': { const r = Math.min(sx, sy, sz) / 2; return [-r, r, -r, r, -r, r]; }
    case 'Cylinder': return [-sx / 2, sx / 2, -sy / 2, sy / 2, -sx / 2, sx / 2];
    case 'Wedge': return [-sx / 2, sx / 2, 0, sy, -sz / 2, sz / 2];
    case 'TrussPart': return [-sx * 0.125, sx * 0.125, -sy / 2, sy / 2, -sz * 0.125, sz * 0.125];
    default: return [-sx / 2, sx / 2, -sy / 2, sy / 2, -sz / 2, sz / 2];
  }
}

// Offset del centro y semiextensiones de la caja en ejes del mundo (independiente de la posición).
function shapeOf(part) {
  const cached = shapeCache.get(part);
  if (cached && cached.type === part.type && cached.sx === part.sx && cached.sy === part.sy && cached.sz === part.sz &&
      cached.rx === part.rx && cached.ry === part.ry && cached.rz === part.rz) return cached;
  const [x0, x1, y0, y1, z0, z1] = localExtents(part);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  const hx = (x1 - x0) / 2, hy = (y1 - y0) / 2, hz = (z1 - z0) / 2;
  const shape = { type: part.type, sx: part.sx, sy: part.sy, sz: part.sz, rx: part.rx, ry: part.ry, rz: part.rz, ox: cx, oy: cy, oz: cz, ex: hx, ey: hy, ez: hz };
  if (part.rx || part.ry || part.rz) {
    // Euler XYZ de three.js: R = Rx · Ry · Rz
    const a = Math.cos(part.rx || 0), b = Math.sin(part.rx || 0);
    const c = Math.cos(part.ry || 0), d = Math.sin(part.ry || 0);
    const e = Math.cos(part.rz || 0), f = Math.sin(part.rz || 0);
    const ae = a * e, af = a * f, be = b * e, bf = b * f;
    const r00 = c * e, r01 = -c * f, r02 = d;
    const r10 = af + be * d, r11 = ae - bf * d, r12 = -b * c;
    const r20 = bf - ae * d, r21 = be + af * d, r22 = a * c;
    shape.ox = r00 * cx + r01 * cy + r02 * cz;
    shape.oy = r10 * cx + r11 * cy + r12 * cz;
    shape.oz = r20 * cx + r21 * cy + r22 * cz;
    shape.ex = Math.abs(r00) * hx + Math.abs(r01) * hy + Math.abs(r02) * hz;
    shape.ey = Math.abs(r10) * hx + Math.abs(r11) * hy + Math.abs(r12) * hz;
    shape.ez = Math.abs(r20) * hx + Math.abs(r21) * hy + Math.abs(r22) * hz;
  }
  shapeCache.set(part, shape);
  return shape;
}

function partBox(part) {
  const s = shapeOf(part);
  const cx = part.x + s.ox, cy = part.y + s.oy, cz = part.z + s.oz;
  return { minX: cx - s.ex, maxX: cx + s.ex, minY: cy - s.ey, maxY: cy + s.ey, minZ: cz - s.ez, maxZ: cz + s.ez };
}

function playerBox(player) {
  const x = Number(player.x) || 0, y = Number(player.y) || 0, z = Number(player.z) || 0;
  return {
    minX: x - PLAYER.halfW - PLAYER_PAD, maxX: x + PLAYER.halfW + PLAYER_PAD,
    minY: y - PLAYER_PAD, maxY: y + PLAYER.height,
    minZ: z - PLAYER.halfD - PLAYER_PAD, maxZ: z + PLAYER.halfD + PLAYER_PAD,
  };
}

function overlapXZ(a, b) {
  return a.minX < b.maxX - 1e-4 && a.maxX > b.minX + 1e-4 && a.minZ < b.maxZ - 1e-4 && a.maxZ > b.minZ + 1e-4;
}
function intersects(a, b, pad = 0) {
  return a.minX - pad < b.maxX && a.maxX + pad > b.minX &&
         a.minY - pad < b.maxY && a.maxY + pad > b.minY &&
         a.minZ - pad < b.maxZ && a.maxZ + pad > b.minZ;
}
function unionBox(a, b) {
  return { minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY), minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ) };
}

// Normal del contacto vista desde `part`: dirección que va de `other` hacia `part`, por el eje de menor penetración.
function contactNormal(part, other) {
  const ox = Math.min(part.maxX, other.maxX) - Math.max(part.minX, other.minX);
  const oy = Math.min(part.maxY, other.maxY) - Math.max(part.minY, other.minY);
  const oz = Math.min(part.maxZ, other.maxZ) - Math.max(part.minZ, other.minZ);
  const sign = (a, b) => (a >= b ? 1 : -1);
  if (oy <= ox && oy <= oz) return { x: 0, y: sign((part.minY + part.maxY) / 2, (other.minY + other.maxY) / 2), z: 0 };
  if (ox <= oz) return { x: sign((part.minX + part.maxX) / 2, (other.minX + other.maxX) / 2), y: 0, z: 0 };
  return { x: 0, y: 0, z: sign((part.minZ + part.maxZ) / 2, (other.minZ + other.maxZ) / 2) };
}

const r3 = value => Math.round(value * 1000) / 1000;

function isWatched(room, part) {
  const watched = room.watched;
  return !!watched && watched.size > 0 && (watched.has(part.id) || watched.has(part.name));
}

// ── Estado por sala ──────────────────────────────────────────────────────────────────────────────

function stateOf(room) {
  if (!room.phys) room.phys = { lastAt: 0, acc: 0, support: new Map(), prev: new Map(), contacts: new Map(), landing: new Map() };
  return room.phys;
}

// Para llamar cuando un script cambia a mano la posición de una pieza (teletransporte): se descarta su velocidad y apoyo.
function resetBody(room, id) {
  if (room.physicsVelocities) room.physicsVelocities[id] = 0;
  if (room.phys) room.phys.support.delete(id);
}

// ── Paso de simulación ───────────────────────────────────────────────────────────────────────────

function stepDynamic(room, ps, e, entries, byId, landings) {
  const part = e.part, id = part.id;
  const oldBottom = e.box.minY, oldTop = e.box.maxY;
  let vy = room.physicsVelocities[id] || 0;
  let dy = 0;

  // 1) Apoyada sobre algo: lo acompaña (ascensores y plataformas móviles).
  const supportId = ps.support.get(id);
  if (supportId !== undefined) {
    const se = byId.get(supportId);
    if (se && se.part.canCollide && overlapXZ(e.box, se.box) && Math.abs(oldBottom - se.box.maxY) <= CARRY_TOL) {
      dy = se.box.maxY - oldBottom;
      if (Math.abs(dy) < 1e-9) dy = 0;
      room.physicsVelocities[id] = 0;
      if (dy !== 0) { part.y += dy; e.box.minY += dy; e.box.maxY += dy; }
      return;
    }
    ps.support.delete(id);
  }

  // 2) Caída libre.
  vy = Math.max(-MAX_FALL, vy - GRAVITY);
  dy = vy;
  if (part.canCollide) {
    let landTop = -Infinity, landOn = null, ceilBottom = Infinity, ceilOn = null;
    for (const o of entries) {
      if (o === e || !o.part.canCollide || !overlapXZ(e.box, o.box)) continue;
      if (vy <= 0) {
        if (oldBottom >= o.box.maxY - SNAP && oldBottom + vy < o.box.maxY && o.box.maxY > landTop) { landTop = o.box.maxY; landOn = o; }
      } else if (oldTop <= o.box.minY + SNAP && oldTop + vy > o.box.minY && o.box.minY < ceilBottom) { ceilBottom = o.box.minY; ceilOn = o; }
    }
    if (landOn) {
      const speed = -vy / STEP;
      dy = landTop - oldBottom;
      vy = 0;
      ps.support.set(id, landOn.part.id);
      if (speed >= LANDING_MIN_SPEED) landings.push({ a: id, b: landOn.part.id, speed });
    } else if (ceilOn) {
      const speed = vy / STEP;
      dy = ceilBottom - oldTop;
      vy = 0;
      landings.push({ a: id, b: ceilOn.part.id, speed });
    }
  }
  room.physicsVelocities[id] = vy;
  if (dy !== 0) { part.y += dy; e.box.minY += dy; e.box.maxY += dy; }
}

function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

// Avanza la física de la sala hasta `now` y calcula los contactos.
// players: [{ userId, username, x, y, z, vx, vy, vz }]
// Devuelve { changed: [{id,x,y,z}], events: [...] }.
function stepRoom(room, now, players) {
  const ps = stateOf(room);
  const result = { changed: [], events: [] };
  if (!room.worldParts) return result;

  const dtMs = ps.lastAt ? Math.min(250, Math.max(0, now - ps.lastAt)) : 50;
  ps.lastAt = now;
  ps.acc += dtMs / 1000;
  let steps = Math.floor(ps.acc / STEP);
  if (steps > MAX_CATCHUP_STEPS) { steps = MAX_CATCHUP_STEPS; ps.acc = 0; } else ps.acc -= steps * STEP;
  const dt = Math.max(dtMs / 1000, 1e-3);

  const entries = [], byId = new Map();
  for (const part of Object.values(room.worldParts)) {
    if (part.type === 'Spawn' || part.isNPC) continue;
    const entry = { part, box: partBox(part), dyn: !part.anchored, startY: part.y };
    entries.push(entry); byId.set(part.id, entry);
  }
  const dynamics = entries.filter(entry => entry.dyn && entry.part.y > VOID_Y);
  const landings = [];
  for (let s = 0; s < steps; s++) for (const entry of dynamics) stepDynamic(room, ps, entry, entries, byId, landings);

  for (const entry of dynamics) {
    if (Math.abs(entry.part.y - entry.startY) > 1e-4) result.changed.push({ id: entry.part.id, x: entry.part.x, y: entry.part.y, z: entry.part.z });
  }
  for (const landing of landings) {
    const key = pairKey(landing.a, landing.b);
    ps.landing.set(key, Math.max(ps.landing.get(key) || 0, landing.speed));
  }

  // ── Movimiento desde el tick anterior (física o scripts) ──
  const moved = new Set(), velocity = new Map(), swept = new Map(), nextPrev = new Map();
  for (const entry of entries) {
    const part = entry.part, before = ps.prev.get(part.id);
    nextPrev.set(part.id, { x: part.x, y: part.y, z: part.z, box: entry.box });
    // Una pieza recién vista no cuenta como "movida": lo que ya se solapa al crearla (una zona apoyada en el piso)
    // no es un toque; los contactos empiezan cuando algo se mueve.
    if (!before) continue;
    if (before.x !== part.x || before.y !== part.y || before.z !== part.z) {
      moved.add(part.id);
      const dx = part.x - before.x, dy = part.y - before.y, dz = part.z - before.z;
      if (Math.hypot(dx, dy, dz) <= MAX_SWEEP) {
        velocity.set(part.id, { x: dx / dt, y: dy / dt, z: dz / dt });
        swept.set(part.id, unionBox(before.box, entry.box)); // caja barrida: no se "salta" piezas finas entre ticks
      } else velocity.set(part.id, { x: 0, y: 0, z: 0 }); // teletransporte
    }
  }
  ps.prev = nextPrev;

  // ── Contactos de las piezas observadas por algún script ──
  const watchedEntries = (room.watched && room.watched.size) ? entries.filter(entry => isWatched(room, entry.part)) : [];
  const nowContacts = new Map();
  const boxFor = entry => swept.get(entry.part.id) || entry.box;
  const playerKey = player => 'p:' + (player.userId || player.socketId || player.username);
  const playerList = Array.isArray(players) ? players : [];

  for (const we of watchedEntries) {
    const wbox = boxFor(we);
    for (const player of playerList) {
      const pbox = playerBox(player);
      if (!intersects(wbox, pbox, PART_PAD)) continue;
      nowContacts.set(pairKey(we.part.id, playerKey(player)), { part: we.part.id, player: playerKey(player), meta: { userId: String(player.userId || ''), username: String(player.username || 'Jugador') } });
    }
    for (const other of entries) {
      if (other === we) continue;
      const key = pairKey(we.part.id, other.part.id);
      if (!moved.has(we.part.id) && !moved.has(other.part.id)) {
        const previous = ps.contacts.get(key);
        if (previous && !nowContacts.has(key)) nowContacts.set(key, previous);
        continue;
      }
      if (intersects(wbox, boxFor(other), PAIR_PAD)) {
        if (!nowContacts.has(key)) nowContacts.set(key, { a: we.part.id, b: other.part.id });
      }
    }
  }

  const emit = (phase, key, contact) => {
    const sides = [];
    if (contact.player) {
      sides.push({ partId: contact.part, other: { kind: 'player', userId: contact.meta.userId, username: contact.meta.username, key: contact.player } });
    } else {
      sides.push({ partId: contact.a, other: { kind: 'part', id: contact.b } });
      sides.push({ partId: contact.b, other: { kind: 'part', id: contact.a } });
    }
    for (const side of sides) {
      const entry = byId.get(side.partId);
      if (!entry || !isWatched(room, entry.part)) continue;
      if (result.events.length >= MAX_EVENTS_PER_TICK) return;
      const event = { phase, part: { id: entry.part.id, name: entry.part.name, x: r3(entry.part.x), y: r3(entry.part.y), z: r3(entry.part.z) }, other: side.other, speed: 0, normal: { x: 0, y: 0, z: 0 } };
      let ownBox = entry.box, otherBox = null, otherVelocity = { x: 0, y: 0, z: 0 };
      if (side.other.kind === 'player') {
        const player = playerList.find(item => playerKey(item) === side.other.key);
        if (player) {
          Object.assign(side.other, { x: r3(player.x), y: r3(player.y), z: r3(player.z) });
          otherBox = playerBox(player); otherVelocity = { x: player.vx || 0, y: player.vy || 0, z: player.vz || 0 };
        }
        delete side.other.key;
      } else {
        const otherEntry = byId.get(side.other.id);
        if (otherEntry) {
          Object.assign(side.other, { name: otherEntry.part.name, x: r3(otherEntry.part.x), y: r3(otherEntry.part.y), z: r3(otherEntry.part.z) });
          otherBox = otherEntry.box; otherVelocity = velocity.get(side.other.id) || otherVelocity;
        }
      }
      if (phase === 'begin') {
        const own = velocity.get(entry.part.id) || { x: 0, y: 0, z: 0 };
        let speed = Math.hypot(own.x - otherVelocity.x, own.y - otherVelocity.y, own.z - otherVelocity.z);
        const landed = side.other.kind === 'part' ? ps.landing.get(pairKey(entry.part.id, side.other.id)) : undefined;
        if (landed !== undefined) speed = Math.max(speed, landed);
        event.speed = r3(speed);
        event.velocity = { x: r3(own.x - otherVelocity.x), y: r3(own.y - otherVelocity.y), z: r3(own.z - otherVelocity.z) };
        if (otherBox) event.normal = contactNormal(ownBox, otherBox);
      }
      result.events.push(event);
    }
  };

  for (const [key, contact] of nowContacts) if (!ps.contacts.has(key)) emit('begin', key, contact);
  for (const [key, contact] of ps.contacts) if (!nowContacts.has(key)) emit('end', key, contact);
  ps.contacts = nowContacts;
  ps.landing.clear();
  return result;
}

module.exports = { stepRoom, resetBody, partBox, playerBox, PLAYER, STEP };
