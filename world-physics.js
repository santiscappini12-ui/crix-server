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

// Propiedades físicas por material (fricción = fracción de velocidad horizontal que se pierde por paso al deslizar
// sobre él; rebote = fracción de velocidad que se conserva al chocar). Una pieza puede sobrescribirlas con
// `friction`, `bounce`, `drag` y `gravityScale`.
const MATERIALS = {
  Ice: { friction: 0.012, bounce: 0.02 }, Glass: { friction: 0.05, bounce: 0.05 }, SmoothPlastic: { friction: 0.09, bounce: 0.05 },
  Plastic: { friction: 0.1, bounce: 0.05 }, Neon: { friction: 0.09, bounce: 0.05 }, Metal: { friction: 0.08, bounce: 0.1 },
  DiamondPlate: { friction: 0.1, bounce: 0.1 }, Marble: { friction: 0.07, bounce: 0.08 }, Wood: { friction: 0.14, bounce: 0.1 },
  WoodPlanks: { friction: 0.14, bounce: 0.1 }, Brick: { friction: 0.2, bounce: 0.05 }, Concrete: { friction: 0.22, bounce: 0.03 },
  Rock: { friction: 0.25, bounce: 0.03 }, Cobblestone: { friction: 0.25, bounce: 0.03 }, Grass: { friction: 0.2, bounce: 0.02 },
  Sand: { friction: 0.4, bounce: 0 }, Fabric: { friction: 0.35, bounce: 0 },
};
const DEFAULT_MAT = { friction: 0.15, bounce: 0.05 };
const AIR_DRAG = 0.003;       // pérdida de velocidad por paso en el aire
const REST_SPEED = 0.002;     // por debajo de esto la velocidad horizontal se considera 0
const BOUNCE_MIN = 0.12;      // velocidad de impacto mínima (por paso) para que haya rebote
const MAX_SPEED = 3;          // límite de velocidad por paso (180 studs/s) para que nada atraviese el mundo
const PLAYER_PUSH = 0.35;     // fracción de la velocidad del jugador que transmite al empujar una pieza suelta

// Esferas sueltas: rodadura (giro libre en el aire, fricción de Coulomb en el punto de contacto, resistencia a la rodadura).
// La velocidad angular va en rad/paso, igual que la lineal va en studs/paso.
const SPHERE_I = 0.4;                // momento de inercia de una esfera maciza: 2/5 · m · r²
const ROLL_K = 1 + 1 / SPHERE_I;     // = 3.5: lo que cuesta anular el deslizamiento en el punto de contacto
const COULOMB_SCALE = 3.5;           // fricción del material (fracción por paso) → coeficiente de Coulomb (hielo ≈ 0.04, madera ≈ 0.5, roca ≈ 0.9)
const ROLL_RESIST = 0.1;             // resistencia a la rodadura: Crr = fricción del material · 0.1 (madera ≈ 0.014)
const ROLL_DRAG = 0.002;             // pérdida proporcional de velocidad por paso al rodar
const SPIN_EPS = 1e-4;              // por debajo de esto el giro se considera 0

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
  // Una esfera suelta ocupa lo mismo gire como gire: su caja ignora la rotación (si no, "respiraría" al rodar).
  const free = part.type === 'Sphere' && !part.anchored;
  if (cached && cached.type === part.type && cached.free === free && cached.sx === part.sx && cached.sy === part.sy && cached.sz === part.sz &&
      (free || (cached.rx === part.rx && cached.ry === part.ry && cached.rz === part.rz))) return cached;
  const [x0, x1, y0, y1, z0, z1] = localExtents(part);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  const hx = (x1 - x0) / 2, hy = (y1 - y0) / 2, hz = (z1 - z0) / 2;
  const shape = { type: part.type, free, sx: part.sx, sy: part.sy, sz: part.sz, rx: part.rx, ry: part.ry, rz: part.rz, ox: cx, oy: cy, oz: cz, ex: hx, ey: hy, ez: hz };
  if ((part.rx || part.ry || part.rz) && !free) {
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
  if (!room.phys) room.phys = { lastAt: 0, acc: 0, support: new Map(), prev: new Map(), contacts: new Map(), landing: new Map(), vel: new Map(), pendingCarry: new Map(), spin: new Map() };
  const ps = room.phys;
  if (!ps.vel) ps.vel = new Map();
  if (!ps.spin) ps.spin = new Map();
  if (!ps.pendingCarry) ps.pendingCarry = new Map();
  return ps;
}

// Para llamar cuando un script cambia a mano la posición de una pieza (teletransporte): se descarta su velocidad y apoyo.
function resetBody(room, id) {
  if (room.physicsVelocities) room.physicsVelocities[id] = 0;
  if (room.phys) { room.phys.support.delete(id); if (room.phys.vel) room.phys.vel.delete(id); if (room.phys.spin) room.phys.spin.delete(id); }
}

const clampSpeed = v => Math.max(-MAX_SPEED, Math.min(MAX_SPEED, Number(v) || 0));

// Velocidad actual de una pieza suelta en studs/s (para scripts).
function getVelocity(room, id) {
  const ps = stateOf(room), h = ps.vel.get(id) || { x: 0, z: 0 };
  return { x: h.x / STEP, y: ((room.physicsVelocities && room.physicsVelocities[id]) || 0) / STEP, z: h.z / STEP };
}
// Fija la velocidad (studs/s). Los ejes que no se pasan se conservan.
function setVelocity(room, id, v) {
  const ps = stateOf(room), h = ps.vel.get(id) || { x: 0, z: 0 };
  if (v.x !== undefined) h.x = clampSpeed(v.x * STEP);
  if (v.z !== undefined) h.z = clampSpeed(v.z * STEP);
  ps.vel.set(id, h);
  if (v.y !== undefined) { if (!room.physicsVelocities) room.physicsVelocities = {}; room.physicsVelocities[id] = clampSpeed(v.y * STEP); if (v.y > 0) ps.support.delete(id); }
}
// Suma un impulso (studs/s) a la velocidad actual.
function addImpulse(room, id, v) {
  const cur = getVelocity(room, id);
  setVelocity(room, id, { x: cur.x + (Number(v.x) || 0), y: cur.y + (Number(v.y) || 0), z: cur.z + (Number(v.z) || 0) });
}

function matOf(part) {
  const m = MATERIALS[part.material] || DEFAULT_MAT;
  return {
    friction: Number.isFinite(part.friction) ? Math.max(0, Math.min(1, part.friction)) : m.friction,
    bounce: Number.isFinite(part.bounce) ? Math.max(0, Math.min(1, part.bounce)) : m.bounce,
    drag: Number.isFinite(part.drag) ? Math.max(0, Math.min(1, part.drag)) : AIR_DRAG,
    gravityScale: Number.isFinite(part.gravityScale) ? Math.max(-5, Math.min(5, part.gravityScale)) : 1,
  };
}

// ── Rodadura de esferas ──────────────────────────────────────────────────────────────────────────

const sphereRadius = part => Math.min(part.sx, part.sy, part.sz) / 2;

function spinOf(ps, part) {
  let sp = ps.spin.get(part.id);
  if (!sp) { sp = { wx: 0, wy: 0, wz: 0, q: null, ex: NaN, ey: NaN, ez: NaN }; ps.spin.set(part.id, sp); }
  return sp;
}
const isSpinning = sp => !!sp && (Math.abs(sp.wx) > SPIN_EPS || Math.abs(sp.wy) > SPIN_EPS || Math.abs(sp.wz) > SPIN_EPS);

// Euler XYZ de three.js ↔ cuaternión (la orientación se integra en cuaternión para no tener bloqueo de ejes).
function eulerToQuat(x, y, z) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2), s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3, z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 };
}
function quatToEuler(q) {
  const m11 = 1 - 2 * (q.y * q.y + q.z * q.z), m12 = 2 * (q.x * q.y - q.z * q.w), m13 = 2 * (q.x * q.z + q.y * q.w);
  const m22 = 1 - 2 * (q.x * q.x + q.z * q.z), m23 = 2 * (q.y * q.z - q.x * q.w), m32 = 2 * (q.y * q.z + q.x * q.w), m33 = 1 - 2 * (q.x * q.x + q.y * q.y);
  const y = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) return { x: Math.atan2(-m23, m33), y, z: Math.atan2(-m12, m11) };
  return { x: Math.atan2(m32, m22), y, z: 0 };
}

// Gira la esfera según su velocidad angular (en el eje del mundo) y deja el resultado en part.rx/ry/rz.
function advanceSpin(ps, part) {
  const sp = ps.spin.get(part.id);
  if (!isSpinning(sp)) return;
  const rx = part.rx || 0, ry = part.ry || 0, rz = part.rz || 0;
  if (!sp.q || rx !== sp.ex || ry !== sp.ey || rz !== sp.ez) sp.q = eulerToQuat(rx, ry, rz); // alguien la rotó a mano: se parte de ahí
  const w = Math.hypot(sp.wx, sp.wy, sp.wz), k = Math.sin(w / 2) / w;
  const a = { x: sp.wx * k, y: sp.wy * k, z: sp.wz * k, w: Math.cos(w / 2) }, b = sp.q;
  const q = {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  q.x /= n; q.y /= n; q.z /= n; q.w /= n;
  sp.q = q;
  const e = quatToEuler(q);
  part.rx = sp.ex = e.x; part.ry = sp.ey = e.y; part.rz = sp.ez = e.z;
}

// Fricción de Coulomb en el punto de contacto con el suelo. El deslizamiento u = v + ω × (−r·ŷ) se va convirtiendo en giro
// (y el giro en avance) hasta que la esfera rueda sin deslizar (u = 0). `normalImpulse` limita la fuerza: μ · N.
function frictionContact(sp, hv, r, mu, normalImpulse) {
  const ux = hv.x + r * sp.wz, uz = hv.z - r * sp.wx, us = Math.hypot(ux, uz);
  if (us < 1e-7) return;
  const j = Math.min(us / ROLL_K, mu * normalImpulse), dx = -ux / us, dz = -uz / us;
  hv.x += j * dx; hv.z += j * dz;
  sp.wx -= j * dz / (SPHERE_I * r);
  sp.wz += j * dx / (SPHERE_I * r);
}

// Un paso de una esfera apoyada: fricción de contacto + resistencia a la rodadura. Modifica hv y el giro.
function rollOnSurface(sp, hv, r, surf, mat) {
  const fc = Math.sqrt(surf.friction * mat.friction);
  frictionContact(sp, hv, r, fc * COULOMB_SCALE, Math.max(0, GRAVITY * mat.gravityScale));
  const speed = Math.hypot(hv.x, hv.z);
  if (speed > 0) {
    const k = Math.max(0, speed - GRAVITY * fc * ROLL_RESIST - speed * ROLL_DRAG) / speed;
    hv.x *= k; hv.z *= k; sp.wx *= k; sp.wz *= k;
  }
  if (Math.hypot(hv.x, hv.z) < REST_SPEED && Math.hypot(sp.wx, sp.wz) * r < REST_SPEED) { hv.x = hv.z = 0; sp.wx = sp.wz = 0; }
  sp.wy *= 0.96; // el giro sobre el eje vertical se frena contra el suelo
  if (Math.abs(sp.wy) < SPIN_EPS) sp.wy = 0;
}

// ── Paso de simulación ───────────────────────────────────────────────────────────────────────────

function stepDynamicBody(room, ps, e, entries, byId, landings) {
  const part = e.part, id = part.id;
  const mat = matOf(part);
  const hv = ps.vel.get(id) || { x: 0, z: 0 };
  let vy = room.physicsVelocities[id] || 0;
  const moving = Math.abs(hv.x) > REST_SPEED || Math.abs(hv.z) > REST_SPEED;

  // 0) Plataforma móvil: si el soporte se desplazó entre ticks, la pieza lo acompaña (una sola vez por tick).
  const carry = ps.pendingCarry.get(id);
  if (carry) {
    ps.pendingCarry.delete(id);
    part.x += carry.x; part.z += carry.z; e.box.minX += carry.x; e.box.maxX += carry.x; e.box.minZ += carry.z; e.box.maxZ += carry.z;
  }

  // 1) Apoyada y quieta: acompaña a su soporte (ascensores) y no gasta más.
  const supportId = ps.support.get(id);
  if (supportId !== undefined) {
    const se = byId.get(supportId);
    if (se && se.part.canCollide && overlapXZ(e.box, se.box) && Math.abs(e.box.minY - se.box.maxY) <= CARRY_TOL && vy <= 0) {
      const dy = se.box.maxY - e.box.minY;
      if (Math.abs(dy) > 1e-9) { part.y += dy; e.box.minY += dy; e.box.maxY += dy; }
      room.physicsVelocities[id] = 0;
      const sphere = part.type === 'Sphere';
      if (!moving && !(sphere && isSpinning(ps.spin.get(id)))) return;
      if (sphere) rollOnSurface(spinOf(ps, part), hv, sphereRadius(part), matOf(se.part), mat); // rueda en vez de deslizar
      else {
        // desliza: se frena según la fricción del soporte (y de la propia pieza)
        const f = Math.min(0.95, Math.sqrt(matOf(se.part).friction * mat.friction) * 0.5);
        hv.x *= 1 - f; hv.z *= 1 - f;
        if (Math.abs(hv.x) < REST_SPEED) hv.x = 0;
        if (Math.abs(hv.z) < REST_SPEED) hv.z = 0;
      }
      ps.vel.set(id, hv);
      vy = 0;
    } else ps.support.delete(id);
  }

  // 2) Movimiento horizontal con colisión por eje.
  if (part.canCollide !== false && (hv.x !== 0 || hv.z !== 0)) {
    for (const axis of ['x', 'z']) {
      const d = hv[axis];
      if (!d) continue;
      const lo = axis === 'x' ? 'minX' : 'minZ', hi = axis === 'x' ? 'maxX' : 'maxZ';
      let move = d, hitId = null;
      for (const o of entries) {
        if (o === e || o.part.canCollide === false) continue;
        // Solo choca lo que está a la altura de la pieza (no lo que pisa ni lo que está por encima).
        if (!(o.box.maxY > e.box.minY + SNAP && o.box.minY < e.box.maxY - SNAP)) continue;
        const other = axis === 'x' ? 'z' : 'x';
        const olo = other === 'x' ? 'minX' : 'minZ', ohi = other === 'x' ? 'maxX' : 'maxZ';
        if (!(e.box[olo] < o.box[ohi] - 1e-4 && e.box[ohi] > o.box[olo] + 1e-4)) continue;
        if (d > 0 && e.box[hi] <= o.box[lo] + 1e-4 && e.box[hi] + d > o.box[lo]) { const m = o.box[lo] - e.box[hi]; if (m < move) { move = m; hitId = o.part.id; } }
        else if (d < 0 && e.box[lo] >= o.box[hi] - 1e-4 && e.box[lo] + d < o.box[hi]) { const m = o.box[hi] - e.box[lo]; if (m > move) { move = m; hitId = o.part.id; } }
      }
      if (move !== d) {
        const impact = Math.abs(d);
        const bounce = Math.min(mat.bounce, 0.95);
        hv[axis] = impact > BOUNCE_MIN && bounce > 0 ? -d * bounce : 0;
        if (part.type === 'Sphere') { // la pared absorbe el giro de ese eje: queda rodando acorde a la velocidad que le queda
          const sp = spinOf(ps, part), r = sphereRadius(part);
          if (axis === 'x') sp.wz = -hv.x / r; else sp.wx = hv.z / r;
        }
        if (impact > 0.02 && hitId) landings.push({ a: id, b: hitId, speed: impact / STEP, wall: true });
      }
      if (move) { part[axis] += move; e.box[lo] += move; e.box[hi] += move; }
    }
  }
  if (!ps.support.has(id)) { // en el aire: arrastre
    const k = 1 - mat.drag; hv.x *= k; hv.z *= k;
    if (Math.abs(hv.x) < REST_SPEED) hv.x = 0;
    if (Math.abs(hv.z) < REST_SPEED) hv.z = 0;
  }
  ps.vel.set(id, hv);
  if (ps.support.has(id)) return;

  // 3) Caída libre / salto con colisión vertical.
  const oldBottom = e.box.minY, oldTop = e.box.maxY;
  vy = Math.max(-MAX_FALL, vy - GRAVITY * mat.gravityScale);
  if (mat.gravityScale < 0) vy = Math.min(MAX_FALL, vy);
  let dy = vy;
  if (part.canCollide !== false) {
    let landTop = -Infinity, landOn = null, ceilBottom = Infinity, ceilOn = null;
    for (const o of entries) {
      if (o === e || o.part.canCollide === false || !overlapXZ(e.box, o.box)) continue;
      if (vy <= 0) {
        if (oldBottom >= o.box.maxY - SNAP && oldBottom + vy < o.box.maxY && o.box.maxY > landTop) { landTop = o.box.maxY; landOn = o; }
      } else if (oldTop <= o.box.minY + SNAP && oldTop + vy > o.box.minY && o.box.minY < ceilBottom) { ceilBottom = o.box.minY; ceilOn = o; }
    }
    if (landOn) {
      const speed = -vy / STEP, vyIn = vy;
      dy = landTop - oldBottom;
      const bounce = Math.min((mat.bounce + matOf(landOn.part).bounce) * 0.5 * 2, 0.95);
      if (-vy > BOUNCE_MIN && bounce > 0.02) vy = -vy * bounce;     // rebota: no queda apoyada
      else { vy = 0; ps.support.set(id, landOn.part.id); }
      if (part.type === 'Sphere') {
        // al tocar con velocidad horizontal (o con giro previo) la fricción del impacto convierte avance en giro y viceversa
        const sp = ps.spin.get(id);
        if (sp || hv.x || hv.z) frictionContact(sp || spinOf(ps, part), hv, sphereRadius(part), Math.sqrt(matOf(landOn.part).friction * mat.friction) * COULOMB_SCALE, vy - vyIn);
      } else if (ps.support.has(id)) { hv.x *= 0.8; hv.z *= 0.8; }
      landings.push({ a: id, b: landOn.part.id, speed });
    } else if (ceilOn) {
      const speed = vy / STEP;
      dy = ceilBottom - oldTop;
      vy = -vy * Math.min(mat.bounce, 0.95);
      landings.push({ a: id, b: ceilOn.part.id, speed });
    }
  }
  room.physicsVelocities[id] = vy;
  if (dy !== 0) { part.y += dy; e.box.minY += dy; e.box.maxY += dy; }
}

function stepDynamic(room, ps, e, entries, byId, landings) {
  stepDynamicBody(room, ps, e, entries, byId, landings);
  if (e.part.type === 'Sphere') advanceSpin(ps, e.part); // el giro sigue en el aire, apoyada o rebotando
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
    const entry = { part, box: partBox(part), dyn: !part.anchored, startY: part.y, startX: part.x, startZ: part.z, startRx: part.rx || 0, startRy: part.ry || 0, startRz: part.rz || 0 };
    entries.push(entry); byId.set(part.id, entry);
  }
  const dynamics = entries.filter(entry => entry.dyn && entry.part.y > VOID_Y);
  const landings = [];

  // Plataformas móviles: si el soporte se movió desde el tick anterior (script o física), lo que está encima va con él.
  for (const entry of dynamics) {
    const supportId = ps.support.get(entry.part.id);
    if (supportId === undefined) continue;
    const before = ps.prev.get(supportId), se = byId.get(supportId);
    if (!before || !se) continue;
    const dx = se.part.x - before.x, dz = se.part.z - before.z;
    if ((dx || dz) && Math.hypot(dx, dz) <= MAX_SWEEP) ps.pendingCarry.set(entry.part.id, { x: dx, z: dz });
  }
  // Empujar piezas sueltas caminando contra ellas.
  for (const player of (Array.isArray(players) ? players : [])) {
    const pvx = (Number(player.vx) || 0) * STEP, pvz = (Number(player.vz) || 0) * STEP;
    if (Math.abs(pvx) < 1e-3 && Math.abs(pvz) < 1e-3) continue;
    const pb = playerBox(player);
    for (const entry of dynamics) {
      const part = entry.part;
      if (part.canCollide === false || !intersects(pb, entry.box, 0.04)) continue;
      if ((Number(player.y) || 0) >= entry.box.maxY - 0.25) continue; // está parado encima, no empuja
      const volume = Math.max(1, part.sx * part.sy * part.sz);
      const factor = PLAYER_PUSH * Math.min(1, 30 / volume);
      const hv = ps.vel.get(part.id) || { x: 0, z: 0 };
      const cx = (entry.box.minX + entry.box.maxX) / 2, cz = (entry.box.minZ + entry.box.maxZ) / 2;
      const toX = cx - (Number(player.x) || 0), toZ = cz - (Number(player.z) || 0);
      if (Math.abs(toX) >= Math.abs(toZ)) { if (Math.sign(toX) === Math.sign(pvx) && Math.abs(pvx * factor) > Math.abs(hv.x)) hv.x = clampSpeed(pvx * factor); }
      else if (Math.sign(toZ) === Math.sign(pvz) && Math.abs(pvz * factor) > Math.abs(hv.z)) hv.z = clampSpeed(pvz * factor);
      ps.vel.set(part.id, hv);
      ps.support.delete(part.id);
    }
  }
  for (let s = 0; s < steps; s++) for (const entry of dynamics) stepDynamic(room, ps, entry, entries, byId, landings);

  for (const entry of dynamics) {
    const part = entry.part, sphere = part.type === 'Sphere';
    const rotated = sphere && (Math.abs((part.rx || 0) - entry.startRx) > 1e-4 || Math.abs((part.ry || 0) - entry.startRy) > 1e-4 || Math.abs((part.rz || 0) - entry.startRz) > 1e-4);
    if (rotated || Math.abs(part.y - entry.startY) > 1e-4 || Math.abs(part.x - entry.startX) > 1e-4 || Math.abs(part.z - entry.startZ) > 1e-4) {
      const update = { id: part.id, x: r3(part.x), y: r3(part.y), z: r3(part.z) };
      if (sphere) { update.rx = r3(part.rx || 0); update.ry = r3(part.ry || 0); update.rz = r3(part.rz || 0); } // solo las esferas mandan rotación
      result.changed.push(update);
    }
  }
  for (const landing of landings) {
    if (landing.a === landing.b) continue;
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

  // Choques que ocurrieron dentro del tick (la pieza ya rebotó y se alejó): se registran igual como contacto.
  for (const landing of landings) {
    if (landing.a === landing.b) continue;
    const ea = byId.get(landing.a), eb = byId.get(landing.b);
    if (!ea || !eb || !(isWatched(room, ea.part) || isWatched(room, eb.part))) continue;
    const key = pairKey(landing.a, landing.b);
    if (!nowContacts.has(key)) nowContacts.set(key, { a: landing.a, b: landing.b });
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

// ── Raycast ──────────────────────────────────────────────────────────────────────────────────────
// Rayo contra las cajas de las piezas. origin/dir: {x,y,z} (dir no necesita estar normalizado).
// opts: { ignore: [id|nombre…], includeNonCollidable: bool, maxDistance }
// Devuelve { id, name, distance, point, normal } o null.
function rayBox(o, d, box, maxDist) {
  let tmin = 0, tmax = maxDist, nx = 0, ny = 0, nz = 0;
  const axes = [['x', 'minX', 'maxX'], ['y', 'minY', 'maxY'], ['z', 'minZ', 'maxZ']];
  for (const [axis, lo, hi] of axes) {
    const dir = d[axis], org = o[axis];
    if (Math.abs(dir) < 1e-12) { if (org < box[lo] || org > box[hi]) return null; continue; }
    let t1 = (box[lo] - org) / dir, t2 = (box[hi] - org) / dir, sign = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sign = 1; }
    if (t1 > tmin) { tmin = t1; nx = ny = nz = 0; if (axis === 'x') nx = sign; else if (axis === 'y') ny = sign; else nz = sign; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return { t: tmin, normal: { x: nx, y: ny, z: nz } };
}
function raycast(parts, origin, direction, opts = {}) {
  const len = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const d = { x: direction.x / len, y: direction.y / len, z: direction.z / len };
  const max = Math.max(0.01, Math.min(2000, Number(opts.maxDistance) || 500));
  const ignore = new Set((opts.ignore || []).map(String));
  let best = null;
  for (const part of parts) {
    if (!part || part.type === 'Spawn' || part.isNPC) continue;
    if (part.canCollide === false && !opts.includeNonCollidable) continue;
    if (ignore.has(part.id) || ignore.has(part.name)) continue;
    const hit = rayBox(origin, d, partBox(part), best ? best.t : max);
    if (hit && (!best || hit.t < best.t)) best = { t: hit.t, normal: hit.normal, part };
  }
  if (!best) return null;
  return {
    id: best.part.id, name: best.part.name, distance: r3(best.t), normal: best.normal,
    point: { x: r3(origin.x + d.x * best.t), y: r3(origin.y + d.y * best.t), z: r3(origin.z + d.z * best.t) },
  };
}

module.exports = { stepRoom, resetBody, partBox, playerBox, PLAYER, STEP, getVelocity, setVelocity, addImpulse, raycast, rayBox, MATERIALS };
