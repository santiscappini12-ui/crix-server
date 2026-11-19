'use strict';
// CrixJoints — uniones y restricciones estilo Roblox, compartido entre navegador y servidor.
//
// Clases: Weld, WeldConstraint, Motor6D, Hinge, BallSocket, Prismatic (cinemáticas: la Part1 sigue a la Part0)
//         Rod, Rope, Spring (dinámicas: integran la Part1/Part0 sueltas con su propia gravedad y colisión simple).
// Poses: x,y,z en studs; rx,ry,rz en radianes, orden de Euler XYZ (igual que three.js y que las piezas de Crix).
// Una unión: { id, class, name, part0, part1, c0:{x,y,z,rx,ry,rz}, c1:{...}, enabled, ...propias de cada clase }.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CrixJoints = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const GRAVITY = 64.8;               // studs/s² (0.018 por paso a 60 Hz, igual que world-physics)
  const KINEMATIC = ['Weld', 'WeldConstraint', 'Motor6D', 'Hinge', 'BallSocket', 'Prismatic'];
  const DYNAMIC = ['Rod', 'Rope', 'Spring'];
  const CLASSES = KINEMATIC.concat(DYNAMIC);

  // ── Matemática mínima (CFrame = posición + cuaternión) ─────────────────────
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function qFromEuler(x, y, z) {
    const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2), s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
  }
  function qToEuler(q) {
    const [x, y, z, w] = q;
    const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w), m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w), m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
    const ey = Math.asin(clamp(m13, -1, 1));
    if (Math.abs(m13) < 0.9999999) return [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)];
    return [Math.atan2(m32, m22), ey, 0];
  }
  function qMul(a, b) {
    return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  }
  const qConj = q => [-q[0], -q[1], -q[2], q[3]];
  function qRot(q, v) {
    const [x, y, z, w] = q, [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
  }
  const qAxis = (axis, angle) => { const s = Math.sin(angle / 2), c = Math.cos(angle / 2); return axis === 'x' ? [s, 0, 0, c] : axis === 'z' ? [0, 0, s, c] : [0, s, 0, c]; };
  const axisVec = axis => axis === 'x' ? [1, 0, 0] : axis === 'z' ? [0, 0, 1] : [0, 1, 0];
  const cfOf = o => ({ p: [num(o && o.x), num(o && o.y), num(o && o.z)], q: qFromEuler(num(o && o.rx), num(o && o.ry), num(o && o.rz)) });
  const cfMul = (a, b) => { const r = qRot(a.q, b.p); return { p: [a.p[0] + r[0], a.p[1] + r[1], a.p[2] + r[2]], q: qMul(a.q, b.q) }; };
  const cfInv = a => { const qi = qConj(a.q), r = qRot(qi, a.p); return { p: [-r[0], -r[1], -r[2]], q: qi }; };
  const partCf = p => cfOf(p);
  function writeCf(part, cf) {
    const e = qToEuler(cf.q);
    part.x = cf.p[0]; part.y = cf.p[1]; part.z = cf.p[2]; part.rx = e[0]; part.ry = e[1]; part.rz = e[2];
  }
  const cfToFields = cf => { const e = qToEuler(cf.q); return { x: cf.p[0], y: cf.p[1], z: cf.p[2], rx: e[0], ry: e[1], rz: e[2] }; };
  const IDENT = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };

  // ── Valores por defecto y validación ────────────────────────────────────────
  function defaults(cls) {
    const base = { class: cls, enabled: true, c0: { ...IDENT }, c1: { ...IDENT } };
    switch (cls) {
      case 'Motor6D': return { ...base, axis: 'y', transform: { ...IDENT }, mode: 'none', targetAngle: 0, angularVelocity: 0, maxVelocity: 6.28, angle: 0, limitsEnabled: false, minAngle: -3.14159, maxAngle: 3.14159 };
      case 'Hinge': return { ...base, axis: 'x', mode: 'none', targetAngle: 0, angularVelocity: 0, maxVelocity: 6.28, angle: 0, limitsEnabled: false, minAngle: -1.5708, maxAngle: 1.5708, damping: 0.4 };
      case 'Prismatic': return { ...base, axis: 'x', mode: 'none', targetPosition: 0, velocity: 0, maxVelocity: 8, position: 0, limitsEnabled: true, minPosition: 0, maxPosition: 8 };
      case 'BallSocket': return { ...base, rotation: { rx: 0, ry: 0, rz: 0 } };
      case 'Rod': return { ...base, length: 5 };
      case 'Rope': return { ...base, length: 8 };
      case 'Spring': return { ...base, freeLength: 5, stiffness: 120, damping: 4, maxForce: 1e6 };
      default: return base; // Weld, WeldConstraint
    }
  }
  function sanitize(src, fallbackId) {
    const s = src && typeof src === 'object' ? src : {};
    const cls = CLASSES.includes(s.class) ? s.class : 'Weld';
    const d = defaults(cls);
    const cf = o => ({ x: clamp(num(o && o.x), -1e5, 1e5), y: clamp(num(o && o.y), -1e5, 1e5), z: clamp(num(o && o.z), -1e5, 1e5), rx: clamp(num(o && o.rx), -1e3, 1e3), ry: clamp(num(o && o.ry), -1e3, 1e3), rz: clamp(num(o && o.rz), -1e3, 1e3) });
    const j = { ...d, id: String(s.id || fallbackId || 'j' + Math.random().toString(36).slice(2, 9)).slice(0, 120), name: String(s.name || cls).slice(0, 80), part0: String(s.part0 || '').slice(0, 120), part1: String(s.part1 || '').slice(0, 120), enabled: s.enabled !== false, c0: cf(s.c0), c1: cf(s.c1) };
    if (s.parent !== undefined) j.parent = String(s.parent).slice(0, 120);
    if (cls === 'WeldConstraint' && s.offset && typeof s.offset === 'object') j.offset = cf(s.offset);
    const axis = ['x', 'y', 'z'].includes(s.axis) ? s.axis : d.axis;
    const modes = ['none', 'servo', 'velocity'];
    if (cls === 'Motor6D' || cls === 'Hinge') {
      Object.assign(j, { axis, mode: modes.includes(s.mode) ? s.mode : 'none', targetAngle: num(s.targetAngle, 0), angularVelocity: clamp(num(s.angularVelocity, 0), -200, 200), maxVelocity: clamp(num(s.maxVelocity, d.maxVelocity), 0, 200), angle: num(s.angle, 0), limitsEnabled: s.limitsEnabled === true, minAngle: num(s.minAngle, d.minAngle), maxAngle: num(s.maxAngle, d.maxAngle) });
      if (cls === 'Motor6D') j.transform = cf(s.transform);
      else j.damping = clamp(num(s.damping, d.damping), 0, 100);
    }
    if (cls === 'Prismatic') Object.assign(j, { axis, mode: modes.includes(s.mode) ? s.mode : 'none', targetPosition: num(s.targetPosition, 0), velocity: clamp(num(s.velocity, 0), -500, 500), maxVelocity: clamp(num(s.maxVelocity, 8), 0, 500), position: num(s.position, 0), limitsEnabled: s.limitsEnabled !== false, minPosition: num(s.minPosition, 0), maxPosition: num(s.maxPosition, 8) });
    if (cls === 'BallSocket') j.rotation = { rx: num(s.rotation && s.rotation.rx), ry: num(s.rotation && s.rotation.ry), rz: num(s.rotation && s.rotation.rz) };
    if (cls === 'Rod' || cls === 'Rope') j.length = clamp(num(s.length, d.length), 0.01, 10000);
    if (cls === 'Spring') Object.assign(j, { freeLength: clamp(num(s.freeLength, 5), 0, 10000), stiffness: clamp(num(s.stiffness, 120), 0, 1e6), damping: clamp(num(s.damping, 4), 0, 1e5), maxForce: clamp(num(s.maxForce, 1e6), 0, 1e9) });
    return j;
  }
  // Une dos piezas SIN moverlas: calcula c0 para que la Part1 se quede exactamente donde está.
  function preserve(joint, part0, part1) {
    const rel = cfMul(cfInv(partCf(part0)), partCf(part1));
    joint.c0 = cfToFields(rel); joint.c1 = { ...IDENT };
    if (joint.class === 'WeldConstraint') joint.offset = cfToFields(rel);
    return joint;
  }

  // ── Qué piezas controla el solver (la física normal debe ignorarlas) ────────
  function drivenIds(joints, parts) {
    const ids = new Set();
    for (const j of joints || []) {
      if (!j || j.enabled === false) continue;
      if (KINEMATIC.includes(j.class)) { if (j.part1) ids.add(j.part1); }
      else {
        for (const id of [j.part0, j.part1]) { const p = parts && parts[id]; if (p && p.anchored === false) ids.add(id); }
      }
    }
    return ids;
  }

  const massOf = p => Math.max(0.01, (p.sx || 1) * (p.sy || 1) * (p.sz || 1) * (p.density > 0 ? p.density : 0.7));

  // ── Paso del solver ─────────────────────────────────────────────────────────
  // world = { parts:{id:part}, joints:[...], state:{}, vel:{}, partBox?(part)->[minx,maxx,miny,maxy,minz,maxz], onError?(joint,msg) }
  function step(world, dt) {
    dt = clamp(num(dt, 1 / 60), 1e-4, 0.1);
    const parts = world.parts || {}, joints = world.joints || [], state = world.state || (world.state = {}), changed = new Set(), errors = [];
    const fail = (j, msg) => { const st = state[j.id] || (state[j.id] = {}); if (st.err === msg) return; st.err = msg; errors.push({ id: j.id, name: j.name, message: msg }); if (world.onError) { try { world.onError(j, msg); } catch (_) { /* nunca romper el paso */ } } };
    const ok = j => { const st = state[j.id]; if (st && st.err) st.err = null; };

    const kin = [], dyn = [];
    for (const j of joints) {
      if (!j || j.enabled === false) continue;
      if (j.part0 === j.part1) { fail(j, `${j.class} «${j.name}»: Part0 y Part1 son la misma pieza`); continue; }
      const p0 = parts[j.part0], p1 = parts[j.part1];
      if (!p0 || !p1) { fail(j, `${j.class} «${j.name}»: no existe ${!p0 ? 'Part0' : 'Part1'} («${!p0 ? j.part0 : j.part1}»)`); continue; }
      ok(j);
      (KINEMATIC.includes(j.class) ? kin : dyn).push(j);
    }

    // Orden: primero las uniones cuya Part0 no depende de otra unión (cadenas Weld → Motor6D → Weld…).
    const parentOf = new Map();
    for (const j of kin) parentOf.set(j.part1, j.part0);
    const depthMemo = new Map();
    const depth = (id, seen = new Set()) => {
      if (depthMemo.has(id)) return depthMemo.get(id);
      if (seen.has(id)) return -1;
      seen.add(id);
      const par = parentOf.get(id);
      const d = par === undefined ? 0 : (depth(par, seen) < 0 ? -1 : 1 + depth(par, seen));
      depthMemo.set(id, d); return d;
    };
    const ordered = [];
    for (const j of kin) { const d = depth(j.part0); if (d < 0) { fail(j, `${j.class} «${j.name}»: hay un ciclo de uniones`); continue; } ordered.push({ j, d }); }
    ordered.sort((a, b) => a.d - b.d);

    for (const { j } of ordered) {
      const p0 = parts[j.part0], p1 = parts[j.part1];
      const st = state[j.id] || (state[j.id] = {});
      const P0 = partCf(p0), C0 = cfOf(j.c0), C1inv = cfInv(cfOf(j.c1));
      let target = null;
      switch (j.class) {
        case 'Weld': target = cfMul(cfMul(P0, C0), C1inv); break;
        case 'WeldConstraint': {
          if (!st.rel) st.rel = j.offset ? cfOf(j.offset) : cfMul(cfInv(P0), partCf(p1));
          target = cfMul(P0, st.rel); break;
        }
        case 'Motor6D': case 'Hinge': {
          driveAngle(j, st, dt, p1, P0, C0);
          const T = cfMul(j.transform ? cfOf(j.transform) : { p: [0, 0, 0], q: [0, 0, 0, 1] }, { p: [0, 0, 0], q: qAxis(j.axis, j.angle) });
          target = cfMul(cfMul(cfMul(P0, C0), T), C1inv); break;
        }
        case 'Prismatic': {
          drivePosition(j, dt);
          const off = axisVec(j.axis).map(v => v * j.position);
          target = cfMul(cfMul(cfMul(P0, C0), { p: off, q: [0, 0, 0, 1] }), C1inv); break;
        }
        case 'BallSocket': {
          const pivot = cfMul(P0, C0), r = j.rotation || {};
          const q1 = (r.rx || r.ry || r.rz) ? qFromEuler(r.rx || 0, r.ry || 0, r.rz || 0) : partCf(p1).q;
          const c1 = cfOf(j.c1), rp = qRot(q1, c1.p);
          target = { p: [pivot.p[0] - rp[0], pivot.p[1] - rp[1], pivot.p[2] - rp[2]], q: q1 }; break;
        }
      }
      if (target) {
        const before = [p1.x, p1.y, p1.z, p1.rx, p1.ry, p1.rz];
        writeCf(p1, target);
        if (Math.abs(before[0] - p1.x) + Math.abs(before[1] - p1.y) + Math.abs(before[2] - p1.z) + Math.abs(before[3] - p1.rx) + Math.abs(before[4] - p1.ry) + Math.abs(before[5] - p1.rz) > 1e-7) changed.add(p1.id);
      }
    }

    if (dyn.length) stepDynamic(world, dyn, dt, changed, fail);
    return { changed: [...changed], errors };
  }

  function wrapAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
  function driveAngle(j, st, dt, p1, P0, C0) {
    if (j.mode === 'velocity') j.angle += clamp(j.angularVelocity, -200, 200) * dt;
    else if (j.mode === 'servo') { const diff = j.targetAngle - j.angle, mx = Math.max(0, j.maxVelocity) * dt; j.angle += Math.abs(diff) <= mx ? diff : Math.sign(diff) * mx; }
    else if (j.class === 'Hinge' && p1.anchored === false) {
      // Bisagra libre: péndulo bajo gravedad alrededor del eje de la bisagra.
      const piv = cfMul(P0, C0), axis = qRot(piv.q, axisVec(j.axis)), r = [p1.x - piv.p[0], p1.y - piv.p[1], p1.z - piv.p[2]];
      const g = [0, -GRAVITY, 0], tq = [r[1] * g[2] - r[2] * g[1], r[2] * g[0] - r[0] * g[2], r[0] * g[1] - r[1] * g[0]];
      const torque = tq[0] * axis[0] + tq[1] * axis[1] + tq[2] * axis[2];
      const along = r[0] * axis[0] + r[1] * axis[1] + r[2] * axis[2], rp2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2] - along * along;
      const inertia = rp2 + ((p1.sx || 1) ** 2 + (p1.sy || 1) ** 2 + (p1.sz || 1) ** 2) / 12;
      st.w = (st.w || 0) + (torque / Math.max(0.05, inertia)) * dt;
      st.w *= Math.max(0, 1 - (j.damping || 0) * dt);
      j.angle += st.w * dt;
    }
    if (j.limitsEnabled) {
      const lo = Math.min(j.minAngle, j.maxAngle), hi = Math.max(j.minAngle, j.maxAngle);
      if (j.angle < lo) { j.angle = lo; if (st.w < 0) st.w = 0; } else if (j.angle > hi) { j.angle = hi; if (st.w > 0) st.w = 0; }
    }
    j.angle = wrapAngle(j.limitsEnabled ? j.angle : j.angle);
    if (!j.limitsEnabled && j.mode === 'servo') { /* el servo no se enrolla */ }
  }
  function drivePosition(j, dt) {
    if (j.mode === 'velocity') j.position += j.velocity * dt;
    else if (j.mode === 'servo') { const diff = j.targetPosition - j.position, mx = Math.max(0, j.maxVelocity) * dt; j.position += Math.abs(diff) <= mx ? diff : Math.sign(diff) * mx; }
    if (j.limitsEnabled) j.position = clamp(j.position, Math.min(j.minPosition, j.maxPosition), Math.max(j.minPosition, j.maxPosition));
  }

  // ── Rod / Rope / Spring: integración propia de las piezas sueltas ──────────
  function stepDynamic(world, dyn, dt, changed, fail) {
    const parts = world.parts, vel = world.vel || (world.vel = {});
    const bodies = new Set();
    for (const j of dyn) for (const id of [j.part0, j.part1]) if (parts[id] && parts[id].anchored === false) bodies.add(id);
    const SUB = 2, h = dt / SUB;
    for (let s = 0; s < SUB; s++) {
      for (const id of bodies) { const v = vel[id] || (vel[id] = [0, 0, 0]); v[1] -= GRAVITY * (parts[id].gravityScale === undefined ? 1 : parts[id].gravityScale) * h; }
      for (const j of dyn) {
        const a = parts[j.part0], b = parts[j.part1];
        const A = cfMul(partCf(a), cfOf(j.c0)).p, B = cfMul(partCf(b), cfOf(j.c1)).p;
        let dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
        const dist = Math.hypot(dx, dy, dz) || 1e-6; dx /= dist; dy /= dist; dz /= dist;
        const ima = a.anchored === false ? 1 / massOf(a) : 0, imb = b.anchored === false ? 1 / massOf(b) : 0, wsum = ima + imb;
        if (!wsum) continue;
        const va = vel[a.id] || [0, 0, 0], vb = vel[b.id] || [0, 0, 0];
        if (j.class === 'Spring') {
          const rel = (vb[0] - va[0]) * dx + (vb[1] - va[1]) * dy + (vb[2] - va[2]) * dz;
          const f = clamp(-j.stiffness * (dist - j.freeLength) - j.damping * rel, -j.maxForce, j.maxForce);
          if (ima) { va[0] -= dx * f * ima * h; va[1] -= dy * f * ima * h; va[2] -= dz * f * ima * h; vel[a.id] = va; }
          if (imb) { vb[0] += dx * f * imb * h; vb[1] += dy * f * imb * h; vb[2] += dz * f * imb * h; vel[b.id] = vb; }
        } else {
          const len = j.length, violated = j.class === 'Rod' ? dist !== len : dist > len;
          if (!violated) continue;
          const err = dist - len, ca = ima / wsum, cb = imb / wsum;
          if (ima) { a.x += dx * err * ca; a.y += dy * err * ca; a.z += dz * err * ca; changed.add(a.id); }
          if (imb) { b.x -= dx * err * cb; b.y -= dy * err * cb; b.z -= dz * err * cb; changed.add(b.id); }
          const rel = (vb[0] - va[0]) * dx + (vb[1] - va[1]) * dy + (vb[2] - va[2]) * dz;
          if (j.class === 'Rod' || rel > 0) {
            const imp = rel / wsum;
            if (ima) { va[0] += dx * imp * ima; va[1] += dy * imp * ima; va[2] += dz * imp * ima; vel[a.id] = va; }
            if (imb) { vb[0] -= dx * imp * imb; vb[1] -= dy * imp * imb; vb[2] -= dz * imp * imb; vel[b.id] = vb; }
          }
        }
      }
      for (const id of bodies) {
        const p = parts[id], v = vel[id]; if (!v) continue;
        v[0] *= 1 - 0.05 * h; v[2] *= 1 - 0.05 * h;
        p.x += v[0] * h; p.y += v[1] * h; p.z += v[2] * h; changed.add(id);
        if (p.y < -500) { v[0] = v[1] = v[2] = 0; p.y = -500; }
        collide(world, p, v);
      }
    }
  }
  function collide(world, p, v) {
    const box = world.partBox; if (!box || p.canCollide === false) return;
    const arr = b => Array.isArray(b) ? b : [b.minX, b.maxX, b.minY, b.maxY, b.minZ, b.maxZ];   // world-physics devuelve {minX,maxX,…}
    let mine; try { mine = arr(box(p)); } catch (_) { return; }
    for (const id in world.parts) {
      const o = world.parts[id];
      if (o === p || o.canCollide === false || o.anchored === false || o.type === 'Spawn' || o.isNPC) continue;
      if (p.collisionGroup && p.collisionGroup !== 'Default' && p.collisionGroup === o.collisionGroup) continue;
      let ob; try { ob = arr(box(o)); } catch (_) { continue; }
      const px = Math.min(mine[1], ob[1]) - Math.max(mine[0], ob[0]), py = Math.min(mine[3], ob[3]) - Math.max(mine[2], ob[2]), pz = Math.min(mine[5], ob[5]) - Math.max(mine[4], ob[4]);
      if (px <= 0 || py <= 0 || pz <= 0) continue;
      const cm = [(mine[0] + mine[1]) / 2, (mine[2] + mine[3]) / 2, (mine[4] + mine[5]) / 2], co = [(ob[0] + ob[1]) / 2, (ob[2] + ob[3]) / 2, (ob[4] + ob[5]) / 2];
      if (py <= px && py <= pz) { const s = cm[1] >= co[1] ? 1 : -1; p.y += s * py; if (v[1] * s < 0) v[1] = -v[1] * 0.1; v[0] *= 0.92; v[2] *= 0.92; }
      else if (px <= pz) { const s = cm[0] >= co[0] ? 1 : -1; p.x += s * px; if (v[0] * s < 0) v[0] = 0; }
      else { const s = cm[2] >= co[2] ? 1 : -1; p.z += s * pz; if (v[2] * s < 0) v[2] = 0; }
      mine = arr(box(p));
    }
  }

  // Comprobaciones para el editor / consola: devuelve una lista de textos.
  function diagnose(joints, parts) {
    const out = [], seen = new Map();
    for (const j of joints || []) {
      if (!j) continue;
      if (!parts[j.part0]) out.push(`${j.class} «${j.name}»: Part0 vacío o inexistente`);
      if (!parts[j.part1]) out.push(`${j.class} «${j.name}»: Part1 vacío o inexistente`);
      if (j.part0 && j.part0 === j.part1) out.push(`${j.class} «${j.name}»: Part0 y Part1 son la misma pieza`);
      if (KINEMATIC.includes(j.class) && j.enabled !== false && j.part1) { if (seen.has(j.part1)) out.push(`La pieza «${(parts[j.part1] || {}).name || j.part1}» es Part1 de dos uniones (${seen.get(j.part1)} y ${j.name}); solo la última manda`); seen.set(j.part1, j.name); }
    }
    return out;
  }

  return { CLASSES, KINEMATIC, DYNAMIC, GRAVITY, defaults, sanitize, preserve, step, drivenIds, diagnose, cfFromFields: cfOf, cfToFields, cfMul, cfInv, qFromEuler, qToEuler };
});
