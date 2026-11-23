'use strict';

// Física de cuerpos rígidos «realista» para las piezas sueltas (anchored:false) de Crix.
//
// Es un adaptador sobre Rapier (motor de física de Dimforge, compilado a WebAssembly). El MISMO archivo corre en el
// servidor (Node) y en el navegador (pruebas desde el Hub). Lo que añade respecto al motor clásico de world-physics.js:
//   · rotación completa en 3D: las cajas vuelcan, ruedan y se apoyan en cualquier cara (el clásico solo las deslizaba);
//   · masa real = densidad del material × volumen; los choques reparten el impulso según la masa;
//   · fricción de Coulomb y restitución por material, apilamiento estable, sueño de cuerpos en reposo;
//   · detección continua de colisiones (nada atraviesa paredes finas aunque vaya rápido);
//   · formas: Block, Sphere, Cylinder, Cone, Wedge (casco convexo), TrussPart e ImportedMesh (caja de su tamaño);
//   · piezas ancladas que se mueven por script (plataformas, ascensores) arrastran y empujan lo que tienen encima.
//
// Si Rapier no está cargado todavía (o el mapa pide physicsMode:'classic'), world-physics.js usa el motor clásico.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CrixRigid = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const STEP = 1 / 60;
  const GRAVITY = 64.8;              // studs/s² (0.018 por paso, igual que el motor clásico)
  const MAX_SPEED = 180;             // studs/s
  const VOID_Y = -500;
  const MIN_SIZE = 0.05;
  const PLAYER_PUSH_MASS = 80;       // masa máxima que un jugador puede empujar «a pulso»
  const PLAYER_PUSH_GAIN = 0.45;
  const MAX_SUB = 3;                 // subpasos de Rapier por tick del servidor

  let R = null;                      // librería Rapier
  const isReady = () => !!R;

  // ── Materiales: [fricción μ, restitución, densidad] ────────────────────────────────────────────
  const MAT = {
    Ice: [0.06, 0.05, 0.9], Glass: [0.25, 0.35, 2.5], SmoothPlastic: [0.3, 0.25, 1], Plastic: [0.4, 0.3, 1], Neon: [0.3, 0.25, 1],
    Metal: [0.35, 0.3, 4], DiamondPlate: [0.5, 0.25, 4], Marble: [0.3, 0.2, 2.7], Wood: [0.5, 0.35, 0.7], WoodPlanks: [0.5, 0.35, 0.7],
    Brick: [0.65, 0.15, 1.9], Concrete: [0.75, 0.1, 2.4], Rock: [0.8, 0.1, 2.7], Cobblestone: [0.8, 0.1, 2.7], Grass: [0.7, 0.05, 1.2],
    Sand: [0.9, 0, 1.6], Fabric: [0.85, 0.05, 0.3],
  };
  const DEF_MAT = [0.5, 0.2, 1];
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function materialOf(part) {
    const m = MAT[part.material] || DEF_MAT;
    // `friction` de una pieza usa la escala antigua (fracción de velocidad perdida por paso); se traduce a μ.
    const mu = Number.isFinite(part.friction) ? clamp(0.03 + part.friction * 3.2, 0, 1.5) : m[0];
    const e = Number.isFinite(part.bounce) ? clamp(part.bounce, 0, 0.98) : m[1];
    const rho = Number.isFinite(part.density) ? clamp(part.density, 0.01, 50) : m[2];
    return { mu, e, rho };
  }

  // ── Orientación: Euler XYZ de three.js ↔ cuaternión ────────────────────────────────────────────
  function eulerToQuat(x, y, z) {
    const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2), s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    return { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3, z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 };
  }
  function quatToEuler(q) {
    const { x, y, z, w } = q;
    const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - w * z), m13 = 2 * (x * z + w * y);
    const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - w * x), m32 = 2 * (y * z + w * x), m33 = 1 - 2 * (x * x + y * y);
    const ry = Math.asin(clamp(m13, -1, 1));
    if (Math.abs(m13) < 0.9999999) return { x: Math.atan2(-m23, m33), y: ry, z: Math.atan2(-m12, m11) };
    return { x: Math.atan2(m32, m22), y: ry, z: 0 };
  }
  function rotate(q, v) {   // q · v
    const { x, y, z, w } = q, ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  }

  // Centro de la forma respecto al origen de la pieza (la cuña tiene el origen en la base).
  function centerOffset(part) {
    return part.type === 'Wedge' ? [0, part.sy / 2, 0] : [0, 0, 0];
  }

  function colliderDesc(part) {
    const sx = Math.max(MIN_SIZE, num(part.sx, 4)), sy = Math.max(MIN_SIZE, num(part.sy, 4)), sz = Math.max(MIN_SIZE, num(part.sz, 4));
    switch (part.type) {
      case 'Sphere': return R.ColliderDesc.ball(Math.max(MIN_SIZE / 2, Math.min(sx, sy, sz) / 2));
      case 'Cylinder': return R.ColliderDesc.cylinder(sy / 2, Math.max(MIN_SIZE / 2, Math.min(sx, sz) / 2));
      case 'Cone': return R.ColliderDesc.cone(sy / 2, Math.max(MIN_SIZE / 2, Math.min(sx, sz) / 2));
      case 'Wedge': {
        const w = sx / 2, h = sy, d = sz / 2, c = h / 2;
        const v = new Float32Array([-w, -c, -d, w, -c, -d, w, -c, d, -w, -c, d, -w, h - c, d, w, h - c, d]);
        return R.ColliderDesc.convexHull(v) || R.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2);
      }
      case 'TrussPart': return R.ColliderDesc.cuboid(Math.max(MIN_SIZE / 2, sx * 0.125), sy / 2, Math.max(MIN_SIZE / 2, sz * 0.125));
      default: return R.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2);   // Block, ImportedMesh, desconocidos
    }
  }

  const SIG_KEYS = ['type', 'sx', 'sy', 'sz', 'material', 'friction', 'bounce', 'density', 'drag', 'gravityScale'];
  const signature = part => SIG_KEYS.map(k => part[k]);
  const sameSig = (sig, part) => { for (let i = 0; i < SIG_KEYS.length; i++) if (sig[i] !== part[SIG_KEYS[i]]) return false; return true; };

  // ── Estado por sala ────────────────────────────────────────────────────────────────────────────
  function stateOf(room) {
    if (!room.rigid) {
      const world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
      world.timestep = STEP;
      try { world.integrationParameters.numSolverIterations = 6; } catch (_) { /* versiones sin esta propiedad */ }
      room.rigid = { world, queue: new R.EventQueue(true), bodies: new Map(), byHandle: new Map(), pendingPush: new Map() };
    }
    return room.rigid;
  }

  function dispose(room) {
    if (!room || !room.rigid) return;
    try { room.rigid.world.free(); room.rigid.queue.free(); } catch (_) { /* ya liberado */ }
    room.rigid = null;
  }

  function removeBody(rs, id) {
    const rec = rs.bodies.get(id); if (!rec) return;
    try { rs.byHandle.delete(rec.collider.handle); rs.world.removeRigidBody(rec.body); } catch (_) { /* ya no existe */ }
    rs.bodies.delete(id);
  }

  function createBody(rs, part, kind) {
    const mat = materialOf(part), off = centerOffset(part), q = eulerToQuat(num(part.rx, 0), num(part.ry, 0), num(part.rz, 0));
    const o = rotate(q, off);
    const pos = { x: num(part.x, 0) + o[0], y: num(part.y, 0) + o[1], z: num(part.z, 0) + o[2] };
    let bd = kind === 'dynamic' ? R.RigidBodyDesc.dynamic() : R.RigidBodyDesc.fixed();
    bd = bd.setTranslation(pos.x, pos.y, pos.z).setRotation(q);
    if (kind === 'dynamic') {
      const drag = Number.isFinite(part.drag) ? clamp(part.drag, 0, 0.99) : 0.003;
      bd = bd.setCcdEnabled(true).setCanSleep(true).setLinearDamping(-Math.log(1 - drag) * 60 * 0.5).setAngularDamping(0.25)
        .setGravityScale(Number.isFinite(part.gravityScale) ? clamp(part.gravityScale, -5, 5) : 1);
    }
    const body = rs.world.createRigidBody(bd);
    const cd = colliderDesc(part).setFriction(mat.mu).setRestitution(mat.e).setDensity(mat.rho)
      .setRestitutionCombineRule(R.CoefficientCombineRule.Max).setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    const collider = rs.world.createCollider(cd, body);
    const rec = { id: part.id, body, collider, kind, sig: signature(part), off, pose: { x: part.x, y: part.y, z: part.z, rx: num(part.rx, 0), ry: num(part.ry, 0), rz: num(part.rz, 0) }, v: { x: 0, y: 0, z: 0 }, moved: false, written: false };
    rs.bodies.set(part.id, rec); rs.byHandle.set(collider.handle, part.id);
    return rec;
  }

  const poseDiffers = (part, p) => Math.abs(part.x - p.x) + Math.abs(part.y - p.y) + Math.abs(part.z - p.z) > 1e-3 ||
    Math.abs(num(part.rx, 0) - p.rx) + Math.abs(num(part.ry, 0) - p.ry) + Math.abs(num(part.rz, 0) - p.rz) > 1e-3;

  function placeBody(rec, part, mode) {   // teletransporte o movimiento de una pieza anclada
    const q = eulerToQuat(num(part.rx, 0), num(part.ry, 0), num(part.rz, 0)), o = rotate(q, rec.off);
    const t = { x: num(part.x, 0) + o[0], y: num(part.y, 0) + o[1], z: num(part.z, 0) + o[2] };
    if (mode === 'kinematic') { rec.body.setNextKinematicTranslation(t); rec.body.setNextKinematicRotation(q); }
    else { rec.body.setTranslation(t, true); rec.body.setRotation(q, true); rec.body.setLinvel({ x: 0, y: 0, z: 0 }, true); rec.body.setAngvel({ x: 0, y: 0, z: 0 }, true); }
    rec.pose = { x: part.x, y: part.y, z: part.z, rx: num(part.rx, 0), ry: num(part.ry, 0), rz: num(part.rz, 0) };
  }

  // ── Paso de simulación ─────────────────────────────────────────────────────────────────────────
  // entries: [{ part, dyn }] de TODAS las piezas del mundo. Devuelve el conjunto de ids que este motor simula.
  function step(room, entries, steps, players, landings, helpers) {
    const rs = stateOf(room), handled = new Set(), seen = new Set();

    for (const e of entries) {
      const part = e.part, id = part.id;
      if (part.type === 'Spawn' || part.isNPC) continue;
      if (part.canCollide === false) { if (rs.bodies.has(id)) removeBody(rs, id); continue; }   // las piezas sin colisión no estorban
      const dynamic = !!e.dyn && part.y > VOID_Y;
      if (e.dyn && !dynamic) { if (rs.bodies.has(id)) removeBody(rs, id); continue; }
      seen.add(id);
      const kind = dynamic ? 'dynamic' : 'fixed';
      let rec = rs.bodies.get(id);
      if (rec && (!sameSig(rec.sig, part) || (rec.kind === 'dynamic') !== dynamic)) { removeBody(rs, id); rec = null; }
      if (!rec) rec = createBody(rs, part, kind);
      // Piezas de un mismo ensamblaje (unidas) no chocan entre sí: cada ensamblaje tiene su bit de grupo (1..15) y el mundo normal usa el bit 0.
      const gb = (helpers && helpers.groupOf ? helpers.groupOf(id) : undefined);
      const want = gb === undefined ? 0x0001FFFF : gb;
      if (rec.cg !== want) { try { rec.collider.setCollisionGroups(want); rec.cg = want; } catch (_) { /* versión sin grupos */ } }
      if (dynamic) {
        handled.add(id);
        if (poseDiffers(part, rec.pose)) { placeBody(rec, part, 'teleport'); rec.written = true; }   // un script la movió a mano
      } else if (poseDiffers(part, rec.pose)) {
        if (rec.kind !== 'kinematic') { rec.body.setBodyType(R.RigidBodyType.KinematicPositionBased, true); rec.kind = 'kinematic'; }
        placeBody(rec, part, 'kinematic');
      }
    }
    for (const id of [...rs.bodies.keys()]) if (!seen.has(id)) removeBody(rs, id);

    // Jugadores que empujan piezas sueltas: la fuerza que logran depende de la masa de la pieza.
    for (const pl of (Array.isArray(players) ? players : [])) {
      const vx = num(pl.vx, 0), vz = num(pl.vz, 0), sp = Math.hypot(vx, vz);
      if (sp < 0.5) continue;
      const hx = 0.5 + 0.12, hz = 0.5 + 0.12, px = num(pl.x, 0), py = num(pl.y, 0), pz = num(pl.z, 0);
      for (const [id, rec] of rs.bodies) {
        if (rec.kind !== 'dynamic') continue;
        const t = rec.body.translation(), ext = helpers && helpers.extentsOf ? helpers.extentsOf(room.worldParts[id]) : null;
        const ex = ext ? ext.ex : 1, ey = ext ? ext.ey : 1, ez = ext ? ext.ez : 1;
        if (Math.abs(t.x - px) > ex + hx || Math.abs(t.z - pz) > ez + hz || py > t.y + ey - 0.25 || py + 3.05 < t.y - ey) continue;
        const dx = t.x - px, dz = t.z - pz;
        if (dx * vx + dz * vz <= 0) continue;                       // se aleja de la dirección en que camina: no la empuja
        const m = Math.min(rec.body.mass(), PLAYER_PUSH_MASS);
        const k = m * PLAYER_PUSH_GAIN * steps * STEP;
        rec.body.applyImpulse({ x: vx * k, y: 0, z: vz * k }, true);
      }
    }

    // Velocidades antes de chocar (para el «speed» de los eventos de aterrizaje/choque).
    for (const rec of rs.bodies.values()) if (rec.kind === 'dynamic') { const v = rec.body.linvel(); rec.v.x = v.x; rec.v.y = v.y; rec.v.z = v.z; }

    // Tiempo real aunque el servidor vaya justo: como mucho MAX_SUB subpasos por tick, cada uno con el dt que haga falta.
    // (Antes se descartaba el tiempo que no daba abasto y todo caía en cámara lenta.)
    const sub = Math.min(steps, MAX_SUB), subDt = sub > 0 ? (steps * STEP) / sub : STEP;
    rs.world.timestep = subDt;
    for (let s = 0; s < sub; s++) {
      rs.world.step(rs.queue);
      rs.queue.drainCollisionEvents((h1, h2, started) => {
        if (!started || !landings) return;
        const a = rs.byHandle.get(h1), b = rs.byHandle.get(h2); if (a === undefined || b === undefined) return;
        const ra = rs.bodies.get(a), rb = rs.bodies.get(b);
        const va = ra && ra.kind === 'dynamic' ? ra.v : { x: 0, y: 0, z: 0 }, vb = rb && rb.kind === 'dynamic' ? rb.v : { x: 0, y: 0, z: 0 };
        landings.push({ a, b, speed: Math.hypot(va.x - vb.x, va.y - vb.y, va.z - vb.z) * STEP });   // en studs/paso, como el clásico
      });
    }

    // Volcar el resultado a las piezas.
    for (const [id, rec] of rs.bodies) {
      if (rec.kind !== 'dynamic') continue;
      const part = room.worldParts[id]; if (!part) continue;
      if (rec.body.isSleeping() && !rec.written) {
        if (!rec.slept) { rec.slept = true; if (room.physicsVelocities) room.physicsVelocities[id] = 0; if (room.phys && room.phys.vel) room.phys.vel.set(id, { x: 0, z: 0 }); }
        continue;
      }
      rec.slept = false;
      let lv = rec.body.linvel();
      const sp = Math.hypot(lv.x, lv.y, lv.z);
      if (sp > MAX_SPEED) { const f = MAX_SPEED / sp; rec.body.setLinvel({ x: lv.x * f, y: lv.y * f, z: lv.z * f }, true); lv = rec.body.linvel(); }
      if (room.physicsVelocities) room.physicsVelocities[id] = lv.y * STEP;
      if (room.phys && room.phys.vel) room.phys.vel.set(id, { x: lv.x * STEP, z: lv.z * STEP });
      if (rec.body.isSleeping() && !rec.written) continue;
      rec.written = false;
      const t = rec.body.translation(), q = rec.body.rotation(), o = rotate(q, rec.off), e = quatToEuler(q);
      part.x = t.x - o[0]; part.y = t.y - o[1]; part.z = t.z - o[2]; part.rx = e.x; part.ry = e.y; part.rz = e.z;
      rec.pose = { x: part.x, y: part.y, z: part.z, rx: e.x, ry: e.y, rz: e.z };
      if (part.y < VOID_Y) { rs.world.removeRigidBody(rec.body); rs.byHandle.delete(rec.collider.handle); rs.bodies.delete(id); }
    }
    return handled;
  }

  // ── API para scripts (studs/s) ─────────────────────────────────────────────────────────────────
  const bodyOf = (room, id) => { const rec = room && room.rigid && room.rigid.bodies.get(id); return rec && rec.kind === 'dynamic' ? rec : null; };
  function getVelocity(room, id) { const r = bodyOf(room, id); if (!r) return null; const v = r.body.linvel(); return { x: v.x, y: v.y, z: v.z }; }
  function setVelocity(room, id, v) {
    const r = bodyOf(room, id); if (!r) return false;
    const c = r.body.linvel(), f = (n, d) => (n === undefined ? d : clamp(num(n, d), -MAX_SPEED, MAX_SPEED));
    r.body.setLinvel({ x: f(v.x, c.x), y: f(v.y, c.y), z: f(v.z, c.z) }, true); return true;
  }
  function addImpulse(room, id, v) {   // v en studs/s de cambio de velocidad (como en el clásico), independiente de la masa
    const r = bodyOf(room, id); if (!r) return false;
    const c = r.body.linvel();
    r.body.setLinvel({ x: clamp(c.x + num(v.x, 0), -MAX_SPEED, MAX_SPEED), y: clamp(c.y + num(v.y, 0), -MAX_SPEED, MAX_SPEED), z: clamp(c.z + num(v.z, 0), -MAX_SPEED, MAX_SPEED) }, true); return true;
  }
  function setAngularVelocity(room, id, w) { const r = bodyOf(room, id); if (!r) return false; r.body.setAngvel({ x: num(w.x, 0), y: num(w.y, 0), z: num(w.z, 0) }, true); return true; }
  function getAngularVelocity(room, id) { const r = bodyOf(room, id); if (!r) return null; const w = r.body.angvel(); return { x: w.x, y: w.y, z: w.z }; }
  function getMass(room, id) { const r = bodyOf(room, id); return r ? r.body.mass() : null; }
  function reset(room, id) { const r = room && room.rigid && room.rigid.bodies.get(id); if (r) { r.body.setLinvel({ x: 0, y: 0, z: 0 }, true); r.body.setAngvel({ x: 0, y: 0, z: 0 }, true); } }

  // ── Carga de Rapier ────────────────────────────────────────────────────────────────────────────
  async function init(lib) {
    if (R) return true;
    if (!lib) throw new Error('CrixRigid.init: falta la librería Rapier');
    await lib.init(); R = lib; return true;
  }
  // Navegador: carga /crix-rapier.js (el servidor lo genera a partir del paquete npm) y la inicia. Devuelve una promesa.
  let loading = null;
  function load() {
    if (R) return Promise.resolve(true);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      if (typeof document === 'undefined') return reject(new Error('sin documento'));
      const s = document.createElement('script'); s.src = '/crix-rapier.js'; s.async = true;
      s.onload = () => (self.CrixRapierLib ? init(self.CrixRapierLib).then(resolve, reject) : reject(new Error('Rapier no se cargó')));
      s.onerror = () => reject(new Error('No se pudo descargar /crix-rapier.js'));
      document.head.appendChild(s);
    }).catch(err => { loading = null; try { console.warn('[Crix] física realista no disponible:', err.message); } catch (_) { /* sin consola */ } return false; });
    return loading;
  }

  return { init, load, isReady, step, dispose, getVelocity, setVelocity, addImpulse, setAngularVelocity, getAngularVelocity, getMass, reset, eulerToQuat, quatToEuler, GRAVITY, MAT };
});
