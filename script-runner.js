'use strict';

// This process runs published ServerScripts in isolated V8 heaps. It has no
// access to the database or Socket.IO server; only validated JSON messages are
// exchanged with server.js over the child-process IPC channel.
let ivm;
try {
  ivm = require('isolated-vm');
} catch (error) {
    if (process.send) process.send({ type:'fatal', message:'No se pudo cargar isolated-vm: ' + error.message },()=>process.disconnect?.());
    else process.exit(1);
    process.exitCode = 1;
}

const { compileCrixScript, CRIXSCRIPT_PRELUDE } = require('./crixscript');
const worldPhysics = require('./world-physics');
const CRIX_ANIM_SRC = require('fs').readFileSync(require('path').join(__dirname, 'crix-anim.js'), 'utf8');

const rooms = new Map();
const MAX_ROOMS = Infinity;
const CrixAvatar = require('./crix-avatar.js');
const CrixObjects = require('./crix-objects.js');
const MAX_SCRIPTS_PER_ROOM = Infinity;
const MAX_SOURCE_CHARS = Infinity;
const MAX_PARTS = Infinity;
const MAX_COMMANDS_PER_SECOND = Infinity;
const MAX_RAYS_PER_TICK = Infinity;
const PLAYER_OPS = new Set(['teleport','launch','speed','jump','damage','heal','health','kill','message','coins','setCoins','checkpoint']);
const MAX_TICK_BUDGET_MS = 35;
const MAX_SCRIPT_CALL_MS = 25;
const TICK_MS = 50;
const PLAYER_HALF_W = 0.5;
const PLAYER_HEIGHT = 3.05;

function send(message) {
  if (process.connected) process.send(message);
}

function cloneJson(value, fallback = null) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch (_) { return fallback; }
}

function finite(value, fallback = 0, min = -10000, max = 10000) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function normalizePart(id, source = {}) {
  const position = source.position || {};
  const size = source.size || {};
  const types = ['Block','Sphere','Cylinder','Wedge','TrussPart','Spawn','ImportedMesh'];
  const materials = ['SmoothPlastic','Plastic','Brick','Wood','WoodPlanks','Metal','DiamondPlate','Neon','Glass','Ice','Grass','Sand','Concrete','Rock','Marble','Cobblestone','Fabric'];
  const type=types.includes(source.type)?source.type:'Block';
  const color = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(source.color || '')) ? String(source.color) : '#5b8def';
  const part={
    id:String(id).slice(0,120), name:String(source.name || 'Part').slice(0,80),
    type,
    x:finite(source.x ?? position.x ?? position.X),
    y:finite(source.y ?? position.y ?? position.Y),
    z:finite(source.z ?? position.z ?? position.Z),
    sx:finite(source.sx ?? size.x ?? size.X,4,0.1,1000),
    sy:finite(source.sy ?? size.y ?? size.Y,4,0.1,1000),
    sz:finite(source.sz ?? size.z ?? size.Z,4,0.1,1000),
    rx:finite(source.rx), ry:finite(source.ry), rz:finite(source.rz),
    color, material:materials.includes(source.material) ? source.material : 'SmoothPlastic',
    anchored:source.anchored === undefined ? true : source.anchored === true, canCollide:source.canCollide !== false,
    transparent:finite(source.transparent,0,0,1),
  };
  if (source.friction !== undefined && source.friction !== null) part.friction = finite(source.friction,0.15,0,1);
  if (source.bounce !== undefined && source.bounce !== null) part.bounce = finite(source.bounce,0.05,0,1);
  if (source.drag !== undefined && source.drag !== null) part.drag = finite(source.drag,0.003,0,1);
  if (source.gravityScale !== undefined && source.gravityScale !== null) part.gravityScale = finite(source.gravityScale,1,-5,5);
  if (Array.isArray(source.tags)) part.tags = source.tags.slice(0,8).map(tag => String(tag).slice(0,40));
  if (source.reflectance !== undefined) part.reflectance = finite(source.reflectance,0,0,1);
  if (source.density !== undefined) part.density = finite(source.density,0.7,0.01,100);
  for (const key of ['castShadow','canTouch','canQuery','massless','locked']) if (source[key] !== undefined) part[key] = source[key] !== false;
  if (source.collisionGroup !== undefined) part.collisionGroup = String(source.collisionGroup || 'Default').slice(0,40);
  if (source.parent !== undefined && source.parent !== null) part.parent = String(source.parent).slice(0,120);
  if (source.attributes && typeof source.attributes === 'object' && !Array.isArray(source.attributes)) {
    const attrs = {};
    for (const [k,v] of Object.entries(source.attributes).slice(0,32)) if (/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k) && ['string','number','boolean'].includes(typeof v)) attrs[k] = typeof v === 'string' ? v.slice(0,200) : v;
    part.attributes = attrs;
  }
  if(type==='ImportedMesh'&&typeof source.meshData==='string'&&source.meshData.length<=2*1024*1024)part.meshData=source.meshData;
  if(typeof source.avatarMesh==='string'&&/^[A-Za-z]{2,20}$/.test(source.avatarMesh))part.avatarMesh=source.avatarMesh;
  return part;
}

function normalizePlayers(players) {
  return (Array.isArray(players) ? players : []).slice(0,64).map(player => ({
    userId:String(player.userId || '').slice(0,100), username:String(player.username || 'Jugador').slice(0,30),
    x:finite(player.x), y:finite(player.y), z:finite(player.z), ry:finite(player.ry,-0,-1000,1000),
    position:{x:finite(player.x),y:finite(player.y),z:finite(player.z)}, rotationY:finite(player.ry),
    moving:!!player.moving, onGround:!!player.onGround,
    // Velocidad estimada (studs/s) y caja del jugador (el origen x,y,z está en los pies; mide 1 × 3.05 × 1).
    velocity:{x:finite(player.vx,0,-1e4,1e4),y:finite(player.vy,0,-1e4,1e4),z:finite(player.vz,0,-1e4,1e4)},
    height:PLAYER_HEIGHT, size:{x:2*PLAYER_HALF_W,y:PLAYER_HEIGHT,z:2*PLAYER_HALF_W},
    bounds:{min:{x:finite(player.x)-PLAYER_HALF_W,y:finite(player.y),z:finite(player.z)-PLAYER_HALF_W},max:{x:finite(player.x)+PLAYER_HALF_W,y:finite(player.y)+PLAYER_HEIGHT,z:finite(player.z)+PLAYER_HALF_W}},
  }));
}

function output(room, script, text, cls = '') {
  const now = Date.now();
  room.logs = room.logs.filter(time => now - time < 2000);
  if (room.logs.length >= 40) return;
  room.logs.push(now);
  send({ type:'output', roomId:room.id, script:String(script || 'Script').slice(0,80), text:String(text || '').slice(0,500), cls:cls === 'warn' ? 'warn' : cls === 'err' ? 'err' : '' });
}

function emitSceneCommand(room, command, payload) {
  const now = Date.now();
  room.commandTimes = room.commandTimes.filter(time => now - time < 1000);
  if (room.commandTimes.length >= MAX_COMMANDS_PER_SECOND) throw new Error('Límite de cambios del mundo alcanzado');
  room.commandTimes.push(now);
  const safePayload = cloneJson(payload, {});
  const seq = ++room.cmdSeq;
  if (command === 'createPart') {
    if (room.parts.size >= MAX_PARTS) throw new Error('La instancia alcanzó el máximo de piezas');
    const roomSuffix=room.instanceId.replace(/[^a-z0-9]/ig,'').slice(-12)||'room';
    const id = `server-${roomSuffix}-${++room.nextPartId}`;
    const data = normalizePart(id, safePayload.data || {});
    room.parts.set(id, data);
    room.partSeq.set(id, seq);
    send({ type:'sceneCommand', roomId:room.id, command, seq, payload:{ id, data } });
    return id;
  }
  if (command === 'jointCreate' || command === 'jointUpdate' || command === 'jointDestroy') {
    if (command === 'jointCreate') {
      const data = safePayload.data && typeof safePayload.data === 'object' ? safePayload.data : {};
      for (const key of ['part0','part1']) if (!room.parts.has(String(data[key] || ''))) throw new Error('Unión: no existe ' + key + ' («' + String(data[key] || '') + '»)');
      const suffix = room.instanceId.replace(/[^a-z0-9]/ig,'').slice(-12) || 'room';
      const jid = 'sjoint-' + suffix + '-' + (++room.nextJointId);
      room.joints.set(jid, { id:jid, class:String(data.class || 'Weld') });
      send({ type:'sceneCommand', roomId:room.id, command, seq:++room.cmdSeq, payload:{ id:jid, data } });
      return jid;
    }
    const jid = String(safePayload.id || '').slice(0,120);
    if (!room.joints.has(jid)) throw new Error('No existe la unión ' + jid);
    if (command === 'jointDestroy') room.joints.delete(jid);
    send({ type:'sceneCommand', roomId:room.id, command, seq:++room.cmdSeq, payload:{ id:jid, patch:cloneJson(safePayload.patch, {}) } });
    return true;
  }
  const id = String(safePayload.id || '').slice(0,120);
  if (!id || !room.parts.has(id)) throw new Error('No existe la pieza ' + id);
  if (command === 'physVelocity' || command === 'physImpulse') {
    const v = safePayload.v || {};
    const vector = { x:finite(v.x,0,-500,500), y:finite(v.y,0,-500,500), z:finite(v.z,0,-500,500) };
    send({ type:'sceneCommand', roomId:room.id, command, seq, payload:{ id, v:vector } });
    return true;
  }
  if (command === 'updatePart') {
    const current = room.parts.get(id);
    const patch = safePayload.patch && typeof safePayload.patch === 'object' ? safePayload.patch : {};
    const merged = { ...current, ...patch, id };
    if (patch.position) {
      for (const axis of ['x','y','z']) if (patch.position[axis] !== undefined || patch.position[axis.toUpperCase()] !== undefined) merged[axis] = patch.position[axis] ?? patch.position[axis.toUpperCase()];
    }
    if (patch.size) {
      for (const axis of ['x','y','z']) if (patch.size[axis] !== undefined || patch.size[axis.toUpperCase()] !== undefined) merged['s'+axis] = patch.size[axis] ?? patch.size[axis.toUpperCase()];
    }
    room.parts.set(id, normalizePart(id, merged));
    room.partSeq.set(id, seq);
    send({ type:'sceneCommand', roomId:room.id, command, seq, payload:{ id, patch:cloneJson(patch,{}) } });
    return true;
  }
  if (command === 'destroyPart') {
    room.parts.delete(id);
    room.partSeq.delete(id);
    send({ type:'sceneCommand', roomId:room.id, command, seq, payload:{ id } });
    return true;
  }
  throw new Error('Operación de mundo desconocida');
}


// Código que se evalúa dentro del aislamiento (no tiene acceso al servidor): Vector3, math ampliado, tweens, raycast,
// eventos de jugadores, eventos remotos cliente↔servidor y control de jugadores. No usar acentos graves ni ${} aquí.
// APIs que solo existen en el cliente (LocalScript). En un Script de servidor dan un error claro en vez de "x is not defined".
const CLIENT_ONLY_STUBS = String.raw`
    const __clientOnly = (what, hint) => new Error(what + ' es solo del cliente: este es un Script (corre en el servidor). Movelo a un LocalScript' + (hint ? ' o usá ' + hint : '') + '.');
    const __clientFn = (what, hint) => function () { throw __clientOnly(what, hint); };
    const __clientObj = (what, hint) => new Proxy({}, { get(_, key) { if (key === 'then' || typeof key === 'symbol') return undefined; throw __clientOnly(what + '.' + String(key), hint); }, set() { throw __clientOnly(what, hint); } });
    const gui = __clientObj('gui');
    const localPlayer = __clientObj('localPlayer', 'game.getPlayer()');
    const device = __clientObj('device');
    const time = () => Date.now() / 1000;
    game.findPart = name => __getParts().find(part => part.name === String(name)) || null;
    game.onKey = __clientFn('game.onKey');
    game.fireServer = __clientFn('game.fireServer', 'game.onClientEvent para recibir de los clientes');
    game.onServerEvent = __clientFn('game.onServerEvent', 'game.fireClient para avisarle al cliente');
    game.vibrate = __clientFn('game.vibrate');
    for (const key of ['player', 'gui', 'device']) Object.defineProperty(game, key, { enumerable:false, configurable:false, get() { throw __clientOnly('game.' + key); } });
`;

const ISOLATE_EXTRAS = String.raw`
    function __makeMath() {
      const m = {};
      for (const key of Object.getOwnPropertyNames(Math)) m[key] = Math[key];
      m.huge = Infinity;
      m.random = (min, max) => { if (min === undefined) return Math.random(); if (max === undefined) { max = min; min = 1; } return Math.floor(Math.random() * (max - min + 1)) + min; };
      m.lerp = (a, b, t) => a + (b - a) * t;
      m.clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      m.dist = (a, b) => Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0), (a.z || 0) - (b.z || 0));
      m.deg = r => r * 180 / Math.PI; m.rad = d => d * Math.PI / 180;
      m.fmod = (a, b) => a % b; m.mod = (a, b) => ((a % b) + b) % b;
      m.round = (n, digits) => { const k = Math.pow(10, digits || 0); return Math.round(n * k) / k; };
      return Object.freeze(m);
    }
    class Vector3 {
      constructor(x, y, z) { this.x = Number(x) || 0; this.y = Number(y) || 0; this.z = Number(z) || 0; }
      static new(x, y, z) { return new Vector3(x, y, z); }
      get magnitude() { return Math.hypot(this.x, this.y, this.z); }
      get unit() { const m = this.magnitude || 1; return new Vector3(this.x / m, this.y / m, this.z / m); }
      add(o) { return new Vector3(this.x + o.x, this.y + o.y, this.z + o.z); }
      sub(o) { return new Vector3(this.x - o.x, this.y - o.y, this.z - o.z); }
      mul(k) { return typeof k === 'number' ? new Vector3(this.x * k, this.y * k, this.z * k) : new Vector3(this.x * k.x, this.y * k.y, this.z * k.z); }
      div(k) { return new Vector3(this.x / k, this.y / k, this.z / k); }
      dot(o) { return this.x * o.x + this.y * o.y + this.z * o.z; }
      cross(o) { return new Vector3(this.y * o.z - this.z * o.y, this.z * o.x - this.x * o.z, this.x * o.y - this.y * o.x); }
      distance(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); }
      lerp(o, t) { return new Vector3(this.x + (o.x - this.x) * t, this.y + (o.y - this.y) * t, this.z + (o.z - this.z) * t); }
      toString() { return '(' + this.x + ', ' + this.y + ', ' + this.z + ')'; }
    }
    Vector3.zero = new Vector3(0, 0, 0); Vector3.one = new Vector3(1, 1, 1); Vector3.up = new Vector3(0, 1, 0);
    const __v3 = o => ({ x: Number(o && (o.x !== undefined ? o.x : o.X)) || 0, y: Number(o && (o.y !== undefined ? o.y : o.Y)) || 0, z: Number(o && (o.z !== undefined ? o.z : o.Z)) || 0 });
    const __uid = p => (p && typeof p === 'object') ? String(p.userId) : String(p);

    // ── Física de piezas ──
    game.setVelocity = (id, v) => __emit('physVelocity', { id: String(id), v: __v3(v) });
    game.applyImpulse = (id, v) => __emit('physImpulse', { id: String(id), v: __v3(v) });
    game.getVelocity = id => __getVelocity(String(id));
    game.setPhysics = (id, props) => { const patch = {}; for (const key of ['friction', 'bounce', 'drag', 'gravityScale', 'anchored', 'canCollide']) if (props && props[key] !== undefined) patch[key] = props[key]; return __emit('updatePart', { id: String(id), patch }); };
    game.raycast = (origin, direction, opts) => { const r = __raycast(JSON.stringify({ o: __v3(origin), d: __v3(direction), opts: opts || {} })); return r ? JSON.parse(r) : null; };

    // ── Uniones (Weld, WeldConstraint, Motor6D, Hinge, BallSocket, Prismatic, Rod, Rope, Spring) ──
    // game.createJoint('Motor6D', piezaA, piezaB, { axis:'y', mode:'velocity', angularVelocity:3 })  → id
    // game.updateJoint(id, { mode:'servo', targetAngle:1.2 })   game.destroyJoint(id)
    const __jid = p => (p && typeof p === 'object') ? String(p.id) : String(p);
    game.JOINT_CLASSES = ['Weld', 'WeldConstraint', 'Motor6D', 'Hinge', 'BallSocket', 'Prismatic', 'Rod', 'Rope', 'Spring'];
    game.createJoint = (cls, part0, part1, props) => {
      if (!game.JOINT_CLASSES.includes(String(cls))) throw new Error('Clase de unión desconocida: ' + cls + '. Usá una de: ' + game.JOINT_CLASSES.join(', '));
      return __emit('jointCreate', { data: Object.assign({}, props || {}, { class: String(cls), part0: __jid(part0), part1: __jid(part1) }) });
    };
    // Los jugadores también son un Model (mismos huesos que los NPC): sus uniones 'pj:<userId>:<Hueso>' giran el hueso del avatar.
    const __RIG = ${JSON.stringify(CrixObjects.rigSpec())};
    game.updateJoint = (id, patch) => {
      const sid = String(id);
      if (sid.slice(0, 3) === 'pj:') {
        const a = sid.split(':'), row = __RIG.find(r => r[0] === a[2]); if (!row) throw new Error('No existe la unión ' + sid);
        const pt = patch || {}, deg = v => Number(v) * 180 / Math.PI, rad = pt.targetAngle !== undefined ? pt.targetAngle : pt.angle; let rot;
        if (rad !== undefined) { rot = [0, 0, 0]; rot['xyz'.indexOf(row[2])] = deg(rad); }
        else if (pt.transform) rot = [deg(pt.transform.rx || 0), deg(pt.transform.ry || 0), deg(pt.transform.rz || 0)];
        else return false;
        const props = { rot: rot, mode: 'set' }; if (pt.duration !== undefined) props.duration = pt.duration;
        return game.setBone(a[1], a[2], props);
      }
      return __emit('jointUpdate', { id: sid, patch: patch || {} });
    };
    game.destroyJoint = id => __emit('jointDestroy', { id: String(id) });
    // game.getModel('Nombre') → { id, name, root (id de la pieza raíz), rootPart (estado actual), parts:{nombre:id}, joints:{nombre:id}, humanoid:{Health,…} }
    const __models = (() => { try { return JSON.parse(__crixModelsJson); } catch (_) { return []; } })();
    game.getModel = name => {
      const m = __models.find(x => x.name === String(name) || x.id === String(name));
      if (!m) {   // un jugador: su Model con Motor6D y Humanoid
        const pl = __getPlayers().find(p => p.username === String(name) || String(p.userId) === String(name) || 'player:' + p.userId === String(name)); if (!pl) return null;
        const k = String(pl.userId), parts = { HumanoidRootPart: 'pp:' + k + ':HumanoidRootPart' }, joints = {};
        for (const r of __RIG) { parts[r[0]] = 'pp:' + k + ':' + r[0]; joints[r[0]] = 'pj:' + k + ':' + r[0]; }
        return { id: 'player:' + k, name: pl.username, isPlayer: true, userId: pl.userId, root: parts.HumanoidRootPart, rootPart: { id: parts.HumanoidRootPart, name: 'HumanoidRootPart', x: pl.x, y: pl.y + 1.525, z: pl.z, position: { x: pl.x, y: pl.y + 1.525, z: pl.z } }, parts: parts, joints: joints, humanoid: { Health: pl.health !== undefined ? pl.health : 100, MaxHealth: pl.maxHealth !== undefined ? pl.maxHealth : 100, WalkSpeed: 16, JumpPower: 50, HipHeight: 1.05, DisplayName: pl.username } };
      }
      const out = JSON.parse(JSON.stringify(m)); out.rootPart = m.root ? __getPart(m.root) : null; return out;
    };
    game.weld = (a, b) => game.createJoint('WeldConstraint', a, b);
    game.motor6d = (a, b, props) => game.createJoint('Motor6D', a, b, props);
    game.setAttribute = (id, key, value) => { const part = __getPart(__jid(id)); if (!part) throw new Error('No existe la pieza ' + id); const attrs = Object.assign({}, part.attributes || {}); if (value === undefined || value === null) delete attrs[String(key)]; else attrs[String(key)] = value; return __emit('updatePart', { id: part.id, patch: { attributes: attrs } }); };
    game.getAttribute = (id, key) => { const part = __getPart(__jid(id)); return part && part.attributes ? part.attributes[String(key)] : undefined; };

    // ── Búsqueda ──
    game.findParts = filter => { const parts = __getParts(); if (typeof filter === 'function') return parts.filter(filter); if (filter === undefined) return parts; return parts.filter(part => part.name === String(filter)); };
    game.getPartsByTag = tag => __getParts().filter(part => Array.isArray(part.tags) && part.tags.includes(String(tag)));
    game.addTag = (id, tag) => { const part = __getPart(String(id)); if (!part) return false; const tags = (part.tags || []).filter(t => t !== String(tag)); tags.push(String(tag)); return __emit('updatePart', { id: part.id, patch: { tags } }); };
    game.removeTag = (id, tag) => { const part = __getPart(String(id)); if (!part) return false; return __emit('updatePart', { id: part.id, patch: { tags: (part.tags || []).filter(t => t !== String(tag)) } }); };
    game.hasTag = (id, tag) => { const part = __getPart(String(id)); return !!(part && Array.isArray(part.tags) && part.tags.includes(String(tag))); };
    game.getPartsInRadius = (center, radius) => { const c = __v3(center), r = Number(radius) || 0; return __getParts().filter(part => Math.hypot(part.x - c.x, part.y - c.y, part.z - c.z) <= r); };
    game.getPlayersInRadius = (center, radius) => { const c = __v3(center), r = Number(radius) || 0; return __getPlayers().filter(p => Math.hypot(p.x - c.x, p.y + 1.5 - c.y, p.z - c.z) <= r); };
    game.clonePart = (id, overrides) => { const part = __getPart(String(id)); if (!part) throw new Error('No existe la pieza ' + id); const copy = Object.assign({}, part, overrides || {}); delete copy.id; return __emit('createPart', { data: copy }); };
    game.destroyAfter = (id, seconds) => task.delay(seconds, () => { try { game.destroyPart(id); } catch (_) {} });

    // ── Tweens ──
    const __ease = {
      linear: t => t, quadIn: t => t * t, quadOut: t => 1 - (1 - t) * (1 - t), quadInOut: t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
      sine: t => 0.5 - Math.cos(Math.PI * t) / 2, cubicOut: t => 1 - Math.pow(1 - t, 3),
      back: t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
      bounce: t => { const n = 7.5625, d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375; return n * (t -= 2.625 / d) * t + 0.984375; }
    };
    const __tweens = [];
    function __advanceTweens(dt) {
      for (let i = __tweens.length - 1; i >= 0; i--) {
        const tw = __tweens[i]; tw.t += dt;
        const k = Math.min(1, tw.t / tw.seconds), e = tw.ease(k), patch = {};
        for (const key of Object.keys(tw.to)) patch[key] = tw.from[key] + (tw.to[key] - tw.from[key]) * e;
        try { __emit('updatePart', { id: tw.id, patch }); } catch (err) { __tweens.splice(i, 1); continue; }
        if (k >= 1) { __tweens.splice(i, 1); if (tw.done) { try { tw.done(); } catch (err) { error(err && err.message || err); } } }
      }
    }
    game.tween = (id, goal, seconds, easing, done) => {
      if (typeof easing === 'function') { done = easing; easing = 'quadInOut'; }
      const part = __getPart(String(id)); if (!part) throw new Error('No existe la pieza ' + id);
      const from = {}, to = {};
      const set = (key, value) => { if (Number.isFinite(Number(value))) { from[key] = Number(part[key]) || 0; to[key] = Number(value); } };
      if (goal.position) { const p = __v3(goal.position); set('x', p.x); set('y', p.y); set('z', p.z); }
      if (goal.size) { const sz = __v3(goal.size); set('sx', sz.x); set('sy', sz.y); set('sz', sz.z); }
      for (const key of ['x', 'y', 'z', 'sx', 'sy', 'sz', 'rx', 'ry', 'rz', 'transparent']) if (goal[key] !== undefined) set(key, goal[key]);
      if (!Object.keys(to).length) return null;
      for (let i = __tweens.length - 1; i >= 0; i--) if (__tweens[i].id === part.id) { for (const key of Object.keys(to)) delete __tweens[i].to[key]; if (!Object.keys(__tweens[i].to).length) __tweens.splice(i, 1); }
      const tween = { id: part.id, from, to, t: 0, seconds: Math.max(0.001, Number(seconds) || 1), ease: __ease[easing] || __ease.quadInOut, done };
      __tweens.push(tween);
      return { cancel: () => { const index = __tweens.indexOf(tween); if (index >= 0) __tweens.splice(index, 1); } };
    };


    // ── Animador (CrixAnim): capas con loop propio, símbolos, eventos y curvas por fotograma clave ──
    // game.animate(id | definición, { model, targets, speed, weight, loop, layerLoop:{capa:true|false}, startTime, channel,
    //                                   priority, layerPriority:{capa:'Action2'}, avatar })
    // TODO ES UNA PISTA SUELTA que el usuario pone en la capa que quiera (y la capa trae su prioridad): piezas (part), uniones (joint),
    // huesos del avatar (bone) y cada elemento de la cara por separado (face: Mouth, EyeL, EyeR, BrowL, BrowR, Expression).
    // bone y los face de un jugador/NPC con avatar necesitan avatar:jugador|'NombreNPC'; los face de un Model van a su pieza Head.
    //   → manejador { stop, pause, resume, seek, setSpeed, setWeight, setLoop, setLayerLoop, setLayerWeight, setLayerSpeed, setLayerEnabled,
    //                 setPriority, setLayerPriority, getLayerPriority, onEvent, onEnded }
    // PRIORIDADES (game.PRIORITIES): Core 0 · Idle 1 · Movement 2 · Action 3 · Action2 4 · Action3 5 · Action4 6 (o cualquier número).
    // Cada capa tiene la suya (se edita en el Animador) y como cada capa anima SUS piezas, la prioridad vale pieza por pieza: la capa de
    // más prioridad manda sobre las piezas/canales que anima y las demás piezas siguen con las animaciones de menor prioridad.
    // priority pisa la de TODAS las capas (como en Roblox); layerPriority pisa solo las capas que nombres.
    // Las animaciones del mapa se llaman por id; game.registerAnimation(id, def) agrega más en ejecución.
    const __animLib = new Map();
    (function () { try { for (const a of JSON.parse(__crixAnimsJson)) { const d = CrixAnim.sanitize(a); __animLib.set(d.id, d); } } catch (_) {} })();
    let __animSeq = 0;
    const __animPlayers = [], __animBus = new Map(), __ANIM_PART = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz', 'transparent'];
    game.registerAnimation = (idOrDef, def) => { const src = idOrDef && typeof idOrDef === 'object' ? idOrDef : Object.assign({}, def || {}, { id: String(idOrDef) }); const d = CrixAnim.sanitize(src); __animLib.set(d.id, d); return d.id; };
    game.getAnimation = id => __animLib.get(String(id)) || null;
    game.listAnimations = () => Array.from(__animLib.values()).map(a => ({ id: a.id, name: a.name, length: CrixAnim.animLength(a, __animLib), layers: a.layers.map(l => l.name), priorities: Object.fromEntries(a.layers.map(l => [l.name, CrixAnim.priorityName(l.priority)])) }));
    game.PRIORITIES = Object.assign({}, CrixAnim.PRIORITIES);
    game.onAnimationEvent = (name, fn) => { if (typeof fn !== 'function') throw new TypeError('onAnimationEvent necesita una función'); const key = String(name); if (!__animBus.has(key)) __animBus.set(key, []); __animBus.get(key).push(fn); return () => { const l = __animBus.get(key) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }; };
    function __animResolve(h, target, kind) {
      const key = kind + ':' + target; if (h.cache.has(key)) return h.cache.get(key);
      if (kind === 'bone') { const bid = h.avatar !== null ? 'a:' + h.avatar + '|' + target : null; h.cache.set(key, bid); return bid; }   // hueso del avatar de un jugador/NPC: requiere opts.avatar
      if (kind === 'face') {   // la cara va por el canal de avatares: «a:<jugador|NPC>» o «p:<pieza Head del Model>»
        let fid = null;
        if (h.avatar !== null) fid = 'a:' + h.avatar;
        else {
          let pid = null;
          if (h.targets && h.targets[target] !== undefined) pid = String(h.targets[target]);
          else if (h.model && (h.model.parts || {})[target]) pid = (h.model.parts || {})[target];
          else { const p = __getPart(String(target)); pid = p ? p.id : null; }
          if (pid) fid = 'p:' + pid;
        }
        h.cache.set(key, fid); return fid;
      }
      let id = null;
      if (h.targets && h.targets[target] !== undefined) id = String(h.targets[target]);
      else if (h.model) id = kind === 'joint' ? (h.model.joints || {})[target] : (h.model.parts || {})[target];
      if (!id) { if (kind === 'part') { const p = __getPart(String(target)); id = p ? p.id : null; } else id = String(target); }
      h.cache.set(key, id || null); return id || null;
    }
    // Mezcla TODAS las animaciones vivas a la vez: por cada pieza/unión/canal gana la capa de mayor prioridad (como en Roblox, pero
    // por pieza: una animación de «Action» sobre el brazo no toca las piernas, que siguen con la de «Movement»). A igual prioridad
    // manda la animación que empezó después. Las poses base se capturan al empezar a animar una pieza y se sueltan al dejar de animarla.
    const __animBase = new Map(), __faceSent = new Map(), __boneSent = new Map();
    let __animClock = 0;
    // Caras y huesos de avatares: se mandan los valores YA resueltos por prioridades como [v, w, rd, add] por canal (op faceAnim / boneAnim).
    // Solo si cambian (máx. ~15/s por destino, y un refresco cada 0,5 s por si el cliente recreó la pieza). Cuando nadie los anima, se manda
    // null y vuelven a su comportamiento automático.
    function __animSend(op, groups, sent) {
      const r3 = n => Math.round(n * 1000) / 1000, tgt = key => key.charAt(0) === 'a' ? key.slice(2) : key;
      const cv = e => [r3(e.v), r3(e.w), r3(e.rd), r3(e.add)];
      for (const [key, o] of groups) {
        const values = {};
        for (const c in o) { if (op === 'boneAnim') { values[c] = {}; for (const ch in o[c]) values[c][ch] = cv(o[c][ch]); } else values[c] = cv(o[c]); }
        const sig = JSON.stringify(values), last = sent.get(key);
        if (last && ((last.sig === sig && __animClock - last.at < 0.5) || (last.sig !== sig && __animClock - last.at < 0.066))) continue;
        sent.set(key, { sig, at: __animClock });
        try { __avatarCmd(tgt(key), JSON.stringify({ op, values })); } catch (_) {}
      }
      for (const key of Array.from(sent.keys())) if (!groups.has(key)) { sent.delete(key); try { __avatarCmd(tgt(key), JSON.stringify({ op, values: null })); } catch (_) {} }
    }
    function __animMix() {
      const acc = {};
      for (const h of __animPlayers) {
        if (h.dead) continue;
        const tmp = h.player.sampleInto({});
        for (const k in tmp) {
          const e = tmp[k], id = __animResolve(h, e.target, e.kind); if (!id) continue;
          const key = e.kind + '|' + id + '|' + e.ch; let g = acc[key];
          if (!g) g = acc[key] = { target: id, kind: e.kind, ch: e.ch, rel: false, v: 0, w: 0, rd: 0, add: 0, items: [] };
          for (const it of e.items) g.items.push(it);
          g.add += e.add;
        }
      }
      CrixAnim.resolve(acc);
      const parts = new Map(), joints = new Map(), faces = new Map(), bones = new Map();
      for (const k in acc) {
        const e = acc[k];
        if (e.kind === 'bone') { const i = e.target.lastIndexOf('|'), av = e.target.slice(0, i), bone = e.target.slice(i + 1); let o = bones.get(av); if (!o) bones.set(av, o = {}); (o[bone] = o[bone] || {})[e.ch] = e; continue; }
        const m = e.kind === 'joint' ? joints : e.kind === 'face' ? faces : parts; let o = m.get(e.target); if (!o) m.set(e.target, o = {}); o[e.ch] = e;
      }
      __animSend('faceAnim', faces, __faceSent); __animSend('boneAnim', bones, __boneSent);
      for (const id of Array.from(__animBase.keys())) if (!parts.has(id)) __animBase.delete(id);   // ya nadie la anima: queda en su última pose
      for (const [id, o] of parts) {
        let base = __animBase.get(id); if (!base) { const p = __getPart(id) || {}; base = {}; for (const c of __ANIM_PART) base[c] = Number(p[c]) || 0; __animBase.set(id, base); }
        const patch = {};
        for (const c in o) { if (__ANIM_PART.indexOf(c) < 0) continue; patch[c] = CrixAnim.apply(o[c], base[c]); }
        if (Object.keys(patch).length) game.updatePart(id, patch);
      }
      for (const [id, o] of joints) {
        const patch = {}, tf = {};
        for (const c in o) { const v = CrixAnim.apply(o[c], 0); if (c === 'angle') { patch.mode = 'servo'; patch.targetAngle = v; patch.maxVelocity = 200; } else if (['x', 'y', 'z', 'rx', 'ry', 'rz'].indexOf(c) >= 0) tf[c] = v; }
        if (Object.keys(tf).length) patch.transform = tf;
        if (Object.keys(patch).length) game.updateJoint(id, patch);
      }
    }
    function __animFire(h, ev) {
      const info = { name: ev.name, time: ev.t, layer: ev.layer, data: ev.data, animation: h.id, model: h.model, handle: h };
      const run = list => { for (const fn of (list || []).slice()) { try { fn(info); } catch (err) { error('Evento de animación ' + ev.name + ': ' + (err && err.message || err)); } } };
      run(h.evt.get(ev.name)); run(h.evt.get('*')); run(__animBus.get(ev.name)); run(__animBus.get('*'));
      try { game.emit('animation:' + ev.name, info); } catch (_) {}
    }
    function __advanceAnims(dt) {
      __animClock += dt;
      if (!__animPlayers.length) { if (__animBase.size) __animBase.clear(); if (__faceSent.size) __animSend('faceAnim', new Map(), __faceSent); if (__boneSent.size) __animSend('boneAnim', new Map(), __boneSent); return; }
      const fired = [], finished = [];
      for (const h of __animPlayers.slice()) {
        if (h.dead || !h.player.playing) continue;   // una animación en pausa sigue mandando con su pose, pero no avanza
        let r; try { r = h.player.update(dt, true); } catch (err) { error('Animación ' + h.name + ': ' + (err && err.message || err)); h.dead = true; continue; }
        for (const ev of r.events) fired.push([h, ev]);
        if (r.ended) finished.push(h);
      }
      try { __animMix(); } catch (err) { error('Animación: ' + (err && err.message || err)); }
      for (const [h, ev] of fired) __animFire(h, ev);
      for (const h of finished) { h.dead = true; for (const f of h.endedFns.slice()) { try { f(h); } catch (err) { error('Animación ' + h.name + ': ' + (err && err.message || err)); } } }
      for (let i = __animPlayers.length - 1; i >= 0; i--) if (__animPlayers[i].dead) __animPlayers.splice(i, 1);
    }
    game.animate = (anim, opts) => {
      opts = opts || {};
      const def = anim && typeof anim === 'object' ? CrixAnim.sanitize(anim) : __animLib.get(String(anim));
      if (!def) throw new Error('No existe la animación ' + anim);
      let model = null;
      if (opts.model !== undefined && opts.model !== null) { model = typeof opts.model === 'object' ? opts.model : game.getModel(opts.model); if (!model) throw new Error('No existe el Model ' + (typeof opts.model === 'object' ? opts.model.name : opts.model)); }
      if (opts.channel !== undefined) for (const o of __animPlayers) if (!o.dead && o.channel === String(opts.channel) && (o.model && model ? o.model.id === model.id : !o.model && !model)) o.dead = true;   // misma «ranura» (idle, caminar…) → reemplaza a la anterior
      const player = CrixAnim.createPlayer(def, { library: __animLib, speed: opts.speed, weight: opts.weight, loop: opts.loop, layerLoop: opts.layerLoop, priority: opts.priority, layerPriority: opts.layerPriority, order: ++__animSeq });
      if (opts.startTime !== undefined) player.seek(opts.startTime);
      const h = { id: def.id, name: def.name, player, model, targets: opts.targets || null, avatar: opts.avatar !== undefined && opts.avatar !== null ? __avT(opts.avatar) : null, channel: opts.channel === undefined ? null : String(opts.channel), cache: new Map(), evt: new Map(), endedFns: [], dead: false };
      const api = {
        id: def.id, name: def.name, length: player.length,
        get time() { return player.time; }, get isPlaying() { return player.playing && !h.dead; },
        stop: () => { h.dead = true; player.playing = false; try { __animMix(); } catch (_) {} }, pause: () => { player.playing = false; }, resume: () => { if (!h.dead) player.playing = true; },
        seek: t => { player.seek(t); try { __animMix(); } catch (_) {} },
        setSpeed: v => { player.speed = Number(v) || 0; }, setWeight: v => { player.weight = Number(v) || 0; }, setLoop: v => { player.loop = !!v; },
        setLayerLoop: (l, v) => player.setLayerLoop(l, v), setLayerWeight: (l, v) => player.setLayerWeight(l, v), setLayerSpeed: (l, v) => player.setLayerSpeed(l, v), setLayerEnabled: (l, v) => player.setLayerEnabled(l, v),
        setPriority: v => { player.setPriority(v); return api; }, setLayerPriority: (l, v) => player.setLayerPriority(l, v), getLayerPriority: l => player.getLayerPriority(l),
        onEvent: (name, fn) => { if (typeof fn !== 'function') throw new TypeError('onEvent necesita una función'); const k = String(name); if (!h.evt.has(k)) h.evt.set(k, []); h.evt.get(k).push(fn); return api; },
        onEnded: fn => { if (typeof fn !== 'function') throw new TypeError('onEnded necesita una función'); h.endedFns.push(fn); return api; }
      };
      h.api = api; __animPlayers.push(h);
      return api;
    };
    game.stopAnimate = (target) => { for (const h of __animPlayers) { if (h.dead) continue; if (target === undefined || h.id === String(target) || (h.model && (h.model.id === String(target) || h.model.name === String(target)))) { h.dead = true; h.player.playing = false; } } };
    game.stopAllAnimations = () => game.stopAnimate();

    // ── Eventos entre scripts ──
    const __bus = new Map();
    game.on = (name, fn) => { if (typeof fn !== 'function') throw new TypeError('game.on necesita una función'); const key = String(name); if (!__bus.has(key)) __bus.set(key, []); __bus.get(key).push(fn); return () => { const list = __bus.get(key) || []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }; };
    game.emit = (name, ...args) => { for (const fn of (__bus.get(String(name)) || []).slice()) { try { fn(...args); } catch (err) { error('Evento ' + name + ': ' + (err && err.message || err)); } } };

    // ── Jugadores: entradas, salidas y control desde el servidor ──
    const __playerHandlers = { added: [], removed: [] };
    game.onPlayerAdded = (fn, existing) => { if (typeof fn !== 'function') throw new TypeError('onPlayerAdded necesita una función'); __playerHandlers.added.push(fn); if (existing !== false) for (const p of __getPlayers()) { try { fn(p); } catch (err) { error('onPlayerAdded: ' + (err && err.message || err)); } } };
    game.onPlayerRemoved = fn => { if (typeof fn !== 'function') throw new TypeError('onPlayerRemoved necesita una función'); __playerHandlers.removed.push(fn); };
    function __crixPlayerEvent(kind, player) {
      for (const fn of __playerHandlers[kind].slice()) { try { fn(player); } catch (err) { error('Evento de jugador: ' + (err && err.message || err)); } }
      for (const script of __crixScripts) { const fn = kind === 'added' ? script.onPlayerAdded : script.onPlayerRemoved; if (typeof fn === 'function' && !script.disabled) { try { fn(player); } catch (err) { error(script.name + ': ' + (err && err.message || err)); } } }
    }
    const __pc = (p, op, payload) => __playerCmd(__uid(p), op, JSON.stringify(payload || {}));
    game.teleportPlayer = (p, pos) => __pc(p, 'teleport', __v3(pos));
    game.launchPlayer = (p, vel) => __pc(p, 'launch', __v3(vel));
    game.setPlayerSpeed = (p, percent) => __pc(p, 'speed', { value: Number(percent) || 100 });
    game.setPlayerJump = (p, percent) => __pc(p, 'jump', { value: Number(percent) || 100 });
    game.damagePlayer = (p, n) => __pc(p, 'damage', { value: Number(n) || 0 });
    game.healPlayer = (p, n) => __pc(p, 'heal', { value: Number(n) || 0 });
    game.setPlayerHealth = (p, n) => __pc(p, 'health', { value: Number(n) || 0 });
    game.killPlayer = p => __pc(p, 'kill', {});
    game.giveCoins = (p, n) => __pc(p, 'coins', { value: Number(n) || 0 });
    game.setPlayerCheckpoint = (p, pos) => __pc(p, 'checkpoint', __v3(pos));
    game.message = (p, text) => __pc(p, 'message', { text: String(text).slice(0, 200) });
    game.broadcast = text => { for (const p of __getPlayers()) __pc(p, 'message', { text: String(text).slice(0, 200) }); };

    // ── Avatares: huesos, animaciones, cara, aspecto y accesorios (se replican a todos los jugadores de la instancia) ──
    // target: un jugador (objeto o userId), '*' (todos los jugadores) o el nombre/id de un NPC. Rotaciones en GRADOS.
    const __AV = ${JSON.stringify({ bones: CrixAvatar.BONES, animations: CrixAvatar.ANIMATIONS, faces: CrixAvatar.FACES, hairs: CrixAvatar.HAIRS, shapes: CrixAvatar.SHAPES })};
    const __avT = t => (t && typeof t === 'object') ? String(t.userId !== undefined ? t.userId : (t.id !== undefined ? t.id : t.name)) : String(t);
    const __av = (t, cmd) => __avatarCmd(__avT(t), JSON.stringify(cmd));
    game.BONES = __AV.bones.slice(); game.ANIMATIONS = __AV.animations.slice(); game.FACES = __AV.faces.slice(); game.HAIRS = __AV.hairs.slice(); game.SHAPES = __AV.shapes.slice();
    game.playAnimation = (t, name, opts) => __av(t, Object.assign({ op:'anim', name:String(name) }, opts || {}));
    game.stopAnimation = (t, name) => __av(t, { op:'stop', name:name === undefined ? '' : String(name) });
    game.setBone = (t, bone, props) => __av(t, { op:'bone', bone:String(bone), props:props || {} });
    game.resetBone = (t, bone) => __av(t, { op:'resetBone', bone:String(bone) });
    game.resetAvatar = t => __av(t, { op:'reset' });
    game.setFace = (t, name, talking) => __av(t, { op:'face', name:name === null ? null : String(name), talk:!!talking });
    game.setLook = (t, look) => __av(t, { op:'look', look:look || {} });
    game.addAccessory = (t, id, bone, spec) => __av(t, { op:'addAcc', id:String(id), bone:String(bone), spec:spec || {} });
    game.removeAccessory = (t, id) => __av(t, { op:'removeAcc', id:String(id) });
    game.setNpcWander = (t, enabled) => __av(t, { op:'hold', value:enabled === false });
    // Pose completa de una vez: game.setPose(jugador, { Head:{x:20}, UpperArmR:[0,0,-90] }, { duration:0.4 })
    game.setPose = (t, bones, opts) => {
      const out = {}, shared = opts || {};
      for (const name of Object.keys(bones || {})) {
        const v = bones[name];
        const isRot = Array.isArray(v) || (v && typeof v === 'object' && (v.x !== undefined || v.y !== undefined || v.z !== undefined) && v.rotation === undefined && v.rot === undefined);
        out[name] = Object.assign({}, shared, isRot ? { rotation:v } : (v || {}));
      }
      return __av(t, { op:'pose', bones:out });
    };


    // ── Sonido: lo reproducen los clientes. target omitido o '*' = todos; o un jugador (objeto/userId). Volumen 0-10, velocidad 0.1-4. ──
    // game.sound.play('Explosión', { volume:0.8, loop:false, speed:1, part:'Caja', id:'mi-instancia' })  →  .stop('Explosión') · .pause · .resume · .setVolume · .stopAll()
    const __snd = (t, cmd) => __soundCmd(t === undefined || t === null || t === '*' ? '*' : __avT(t), JSON.stringify(cmd));
    game.sound = {
      play: (name, opts, target) => __snd(target, Object.assign({ op:'play', name:String(name) }, opts || {})),
      stop: (name, target) => __snd(target, { op:'stop', name:String(name) }),
      pause: (name, target) => __snd(target, { op:'pause', name:String(name) }),
      resume: (name, target) => __snd(target, { op:'resume', name:String(name) }),
      setVolume: (name, volume, target) => __snd(target, { op:'volume', name:String(name), value:Number(volume) }),
      setSpeed: (name, speed, target) => __snd(target, { op:'speed', name:String(name), value:Number(speed) }),
      stopAll: target => __snd(target, { op:'stopAll' })
    };
    game.playSound = game.sound.play; game.stopSound = game.sound.stop;

    // ── Eventos remotos (LocalScript ↔ Script de servidor) ──
    const __remote = new Map();
    game.onClientEvent = (name, fn) => { if (typeof fn !== 'function') throw new TypeError('onClientEvent necesita una función'); const key = String(name); if (!__remote.has(key)) __remote.set(key, []); __remote.get(key).push(fn); };
    game.fireClient = (p, name, data) => __remoteOut(__uid(p), String(name), JSON.stringify(data === undefined ? null : data));
    game.fireAllClients = (name, data) => __remoteOut('*', String(name), JSON.stringify(data === undefined ? null : data));
    function __crixRemoteIn(userId, name, dataJson) {
      const list = __remote.get(name); if (!list) return;
      const player = __getPlayers().find(p => p.userId === userId) || { userId };
      let data = null; try { data = JSON.parse(dataJson); } catch (_) {}
      for (const fn of list.slice()) { try { fn(player, data); } catch (err) { error('Evento remoto ' + name + ': ' + (err && err.message || err)); } }
    }
`;

function bootstrapSource(modules) {
  return `
    globalThis.__crixScripts = [];
    globalThis.__crixPlayers = [];
    globalThis.__crixParts = [];
    const __emit = __crixEmit;
    const __getPlayers = __crixGetPlayers;
    const __getParts = __crixGetParts;
    const __log = __crixLog;
    const __getPart = __crixGetPart;
    const __watch = __crixWatch;
    const __raycast = __crixRaycast;
    const __playerCmd = __crixPlayerCmd;
    const __remoteOut = __crixRemoteOut;
    const __avatarCmd = __crixAvatarCmd;
    const __soundCmd = __crixSoundCmd;
    const __getVelocity = __crixGetVelocity;
    ${CRIXSCRIPT_PRELUDE}
    const __handlers = { touched:new Map(), touchEnded:new Map(), impact:new Map() };
    function __on(kind, key, fn, minSpeed) {
      if (typeof fn !== 'function') throw new TypeError('El evento necesita una función');
      const name = String(key);
      if (!__handlers[kind].has(name)) __handlers[kind].set(name, []);
      __handlers[kind].get(name).push({ fn, minSpeed: Math.max(0, Number(minSpeed) || 0) });
      __watch(name);
    }
    const __moduleSources = ${JSON.stringify(modules)};
    const __moduleCache = new Map();
    const math = __makeMath();
    const game = {
      createPart: props => __emit('createPart', { data: props || {} }),
      updatePart: (id, patch) => __emit('updatePart', { id, patch: patch || {} }),
      destroyPart: id => __emit('destroyPart', { id }),
      getPlayer: () => __getPlayers()[0] || null,
      getPlayers: () => __getPlayers(),
      getPart: key => __getPart(String(key)),
      onTouched: (name, fn) => __on('touched', name, fn, 0),
      onTouchEnded: (name, fn) => __on('touchEnded', name, fn, 0),
      onImpact: (name, fn, minSpeed) => __on('impact', name, fn, minSpeed === undefined ? 2 : minSpeed)
    };
    game.CreatePart = game.createPart;
    game.UpdatePart = game.updatePart;
    game.DestroyPart = game.destroyPart;
    game.GetPlayer = game.getPlayer;
    game.GetPlayers = game.getPlayers;
    game.GetPart = game.getPart;
    game.OnTouched = game.onTouched;
    game.OnTouchEnded = game.onTouchEnded;
    game.OnImpact = game.onImpact;
    ${ISOLATE_EXTRAS}
    ${CLIENT_ONLY_STUBS}
    Object.freeze(game);
    const workspace = Object.freeze({
      getChildren: () => __getParts(),
      findFirstChild: name => __getParts().find(part => part.name === String(name)) || null,
      createPart: game.createPart, updatePart: game.updatePart, destroyPart: game.destroyPart,
      GetChildren: () => __getParts(), FindFirstChild: name => __getParts().find(part => part.name === String(name)) || null
    });
    const __waiters = [];
    let __timerId = 0;
    const task = Object.freeze({
      wait: seconds => new Promise(resolve => __waiters.push({ id:++__timerId, left: Math.max(0, Math.min(30, Number(seconds) || 0)), callback:resolve })),
      delay: (seconds, callback) => { if (typeof callback !== 'function') throw new TypeError('task.delay necesita una función'); const id = ++__timerId; __waiters.push({ id, left: Math.max(0, Math.min(30, Number(seconds) || 0)), callback }); return id; },
      every: (seconds, callback) => { if (typeof callback !== 'function') throw new TypeError('task.every necesita una función'); const every = Math.max(0.05, Math.min(3600, Number(seconds) || 1)); const id = ++__timerId; if (__waiters.filter(w => w.every).length >= 50) throw new Error('Demasiados temporizadores (máx. 50)'); __waiters.push({ id, left: every, every, callback }); return id; },
      cancel: id => { const index = __waiters.findIndex(w => w.id === id); if (index >= 0) __waiters.splice(index, 1); },
      spawn: fn => { if (typeof fn !== 'function') throw new TypeError('task.spawn necesita una función'); return task.delay(0, fn); }
    });
    const print = (...values) => __log('info', values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
    const warn = (...values) => __log('warn', values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
    const error = (...values) => __log('err', values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
    const env = { game, workspace, math, task, print, warn, error, Vector3, tonumber:value=>Number(value), tostring:value=>String(value) };
    function require(name) {
      const entry = __moduleSources.find(item => item.id === String(name) || item.name === String(name));
      if (!entry) throw new Error('No existe el ModuleScript: ' + name);
      if (__moduleCache.has(entry.id)) return __moduleCache.get(entry.id).exports;
      const module = { exports:{} };
      __moduleCache.set(entry.id, module);
      const result = new Function('env','game','workspace','math','task','print','warn','error','require','module','exports', entry.code + '\\n;return module.exports;')(env,game,workspace,math,task,print,warn,error,require,module,module.exports);
      if (result !== undefined) module.exports = result;
      return module.exports;
    }
    function __crixAdvance(dt) {
      __advanceTweens(dt);
      __advanceAnims(dt);
      for (let index=__waiters.length-1; index>=0; index--) {
        const waiter=__waiters[index]; if (!waiter) continue; waiter.left-=dt;
        if (waiter.left<=0) {
          if (waiter.every) waiter.left += waiter.every; else __waiters.splice(index,1);
          try { waiter.callback(); } catch (err) { error(err && err.message || err); }
        }
      }
    }
    function __runHandlers(kind, key, info, player) {
      const list = __handlers[kind].get(key); if (!list) return;
      for (const handler of list.slice()) {
        if (kind === 'impact' && info.speed < handler.minSpeed) continue;
        try { if (kind === 'impact') handler.fn(info); else handler.fn(player, info); }
        catch (err) { error('Evento ' + kind + ' (' + key + '): ' + (err && err.message || err)); }
      }
    }
    function __crixDispatch(events) {
      for (const ev of events) {
        const kind = ev.phase === 'end' ? 'touchEnded' : 'touched';
        const player = ev.other && ev.other.kind === 'player' ? (__getPlayers().find(item => item.userId === ev.other.userId) || ev.other) : null;
        const info = { phase: ev.phase, part: ev.part, other: ev.other, player, speed: ev.speed || 0, normal: ev.normal, velocity: ev.velocity };
        const keys = ev.part.id === ev.part.name ? [ev.part.id] : [ev.part.id, ev.part.name];
        for (const key of keys) {
          __runHandlers(kind, key, info, player);
          if (ev.phase === 'begin') __runHandlers('impact', key, info, player);
        }
      }
    }
    function __crixInvoke(eventName, dt, index) {
      const script=__crixScripts[index]; if (!script || script.disabled) return;
      try {
        const fn=script[eventName];
        if (typeof fn==='function') {
          const ret = eventName==='onUpdate' ? fn(dt,game.getPlayer(),game.getPlayers()) : fn(game.getPlayer(),game.getPlayers());
          if (ret && typeof ret.then==='function') ret.then(undefined, err => error(script.name+': '+(err && err.message || err)));
        }
        script.errors = 0;
      } catch (err) {
        script.errors = (script.errors || 0) + 1;
        if (script.errors >= 10) { script.disabled = true; error(script.name + ': desactivado tras 10 errores seguidos'); }
        error(script.name+': '+(err && err.message || err));
      }
    }
    delete globalThis.__crixRaycast; delete globalThis.__crixPlayerCmd; delete globalThis.__crixRemoteOut; delete globalThis.__crixAvatarCmd; delete globalThis.__crixSoundCmd; delete globalThis.__crixGetVelocity;
    delete globalThis.__crixEmit; delete globalThis.__crixGetPlayers; delete globalThis.__crixGetParts; delete globalThis.__crixLog; delete globalThis.__crixGetPart; delete globalThis.__crixWatch;
  `;
}

function createRoom(message) {
  if (!ivm) return null;
  if (rooms.has(message.roomId)) stopRoom(message.roomId);
  if (rooms.size >= MAX_ROOMS) throw new Error('El servidor llegó al límite de instancias con scripts activos');
  const scripts = (Array.isArray(message.scripts) ? message.scripts : [])
    .filter(script => script && script.type === 'Script' && typeof script.code === 'string')
    .slice(0, MAX_SCRIPTS_PER_ROOM);
  const modules = (Array.isArray(message.scripts) ? message.scripts : [])
    .filter(script => script && script.type === 'ModuleScript' && typeof script.code === 'string')
    .map(script => ({ id:String(script.id || script.name), name:String(script.name || 'ModuleScript'), code:(script.language === 'crixscript' ? compileCrixScript(script.code) : script.code).slice(0,MAX_SOURCE_CHARS) }));
  const isolate = new ivm.Isolate({ memoryLimit:Math.max(16, Number(process.env.CRIX_SCRIPT_MEMORY_MB) || 512) });
  const context = isolate.createContextSync();
  const room = {
    id:String(message.roomId), mapId:String(message.mapId), instanceId:String(message.instanceId),
    isolate, context, players:normalizePlayers(message.players), parts:new Map(), scripts,
    disabledScripts:new Set(), commandTimes:[], logs:[], nextPartId:0, busy:false, timer:null,
    cmdSeq:0, joints:new Map(), nextJointId:0, partSeq:new Map(), watchKeys:new Set(), velocity:new Map(), lastPos:new Map(), rays:0, remoteTimes:[],
  };
  for (const part of (Array.isArray(message.parts) ? message.parts : []).slice(0,MAX_PARTS)) {
    if (!part || part.type === 'Spawn' || part.isNPC) continue;
    const id=String(part.id || 'map-part'); room.parts.set(id,normalizePart(id,part));
  }
  for (const joint of (Array.isArray(message.joints) ? message.joints : [])) if (joint && joint.id) room.joints.set(String(joint.id), { id:String(joint.id), class:String(joint.class || 'Weld') });
  const jail=context.global;
  jail.setSync('global',jail.derefInto());
  try { jail.setSync('__crixAnimsJson', JSON.stringify(Array.isArray(message.animations) ? message.animations : [])); } catch (_) { jail.setSync('__crixAnimsJson', '[]'); }
  try { context.evalSync(CRIX_ANIM_SRC); } catch (e) { output(room,'Animador','No se pudo cargar el motor de animación: '+e.message,'err'); }
  try { jail.setSync('__crixModelsJson', JSON.stringify(Array.isArray(message.models) ? message.models : [])); } catch (_) { jail.setSync('__crixModelsJson', '[]'); }
  jail.setSync('__crixEmit',new ivm.Callback((command,payload)=>emitSceneCommand(room,String(command),payload),{sync:true}));
  jail.setSync('__crixGetPlayers',new ivm.Callback(()=>room.players,{sync:true}));
  jail.setSync('__crixGetParts',new ivm.Callback(()=>Array.from(room.parts.values()),{sync:true}));
  jail.setSync('__crixGetPart',new ivm.Callback(key=>{const name=String(key);return room.parts.get(name)||Array.from(room.parts.values()).find(part=>part.name===name)||null;},{sync:true}));
  jail.setSync('__crixWatch',new ivm.Callback(key=>{const name=String(key).slice(0,120);if(room.watchKeys.size>=200||room.watchKeys.has(name))return;room.watchKeys.add(name);send({type:'watch',roomId:room.id,key:name});},{sync:true}));
  jail.setSync('__crixRaycast',new ivm.Callback(json=>{
    if(room.rays>=MAX_RAYS_PER_TICK)throw new Error('Demasiados raycast en un mismo instante (máx. '+MAX_RAYS_PER_TICK+')');
    room.rays=(room.rays||0)+1;
    try{
      const query=JSON.parse(String(json)),opts=query.opts&&typeof query.opts==='object'?query.opts:{};
      const origin={x:finite(query.o.x),y:finite(query.o.y),z:finite(query.o.z)},dir={x:finite(query.d.x),y:finite(query.d.y),z:finite(query.d.z)};
      if(!dir.x&&!dir.y&&!dir.z)return null;
      const safe={maxDistance:finite(opts.maxDistance,500,0.01,2000),ignore:Array.isArray(opts.ignore)?opts.ignore.slice(0,50):[],includeNonCollidable:opts.includeNonCollidable===true};
      let best=worldPhysics.raycast(Array.from(room.parts.values()),origin,dir,safe);
      if(opts.players){
        const len=Math.hypot(dir.x,dir.y,dir.z),unit={x:dir.x/len,y:dir.y/len,z:dir.z/len};
        for(const player of room.players){
          const box=worldPhysics.playerBox({x:player.x,y:player.y,z:player.z});
          const hit=worldPhysics.rayBox(origin,unit,box,best?best.distance:safe.maxDistance);
          if(hit&&(!best||hit.t<best.distance))best={kind:'player',userId:player.userId,name:player.username,id:player.userId,distance:Math.round(hit.t*1000)/1000,normal:hit.normal,point:{x:origin.x+unit.x*hit.t,y:origin.y+unit.y*hit.t,z:origin.z+unit.z*hit.t}};
        }
      }
      return best?JSON.stringify(best):null;
    }catch(error){if(/Demasiados/.test(error.message))throw error;return null;}
  },{sync:true}));
  jail.setSync('__crixGetVelocity',new ivm.Callback(key=>{const id=String(key);const part=room.parts.get(id)||Array.from(room.parts.values()).find(item=>item.name===id);const v=part&&room.velocity.get(part.id);return v?{x:v.x,y:v.y,z:v.z}:{x:0,y:0,z:0};},{sync:true}));
  jail.setSync('__crixPlayerCmd',new ivm.Callback((userId,op,payloadJson)=>{
    op=String(op);if(!PLAYER_OPS.has(op))throw new Error('Operación de jugador desconocida: '+op);
    const now=Date.now();room.commandTimes=room.commandTimes.filter(time=>now-time<1000);
    if(room.commandTimes.length>=MAX_COMMANDS_PER_SECOND)throw new Error('Límite de cambios del mundo alcanzado');room.commandTimes.push(now);
    let payload={};try{payload=JSON.parse(String(payloadJson))||{};}catch(_){}
    const safe={x:finite(payload.x),y:finite(payload.y),z:finite(payload.z),value:finite(payload.value,0,-1e6,1e6)};
    if(op==='message')safe.text=String(payload.text||'').slice(0,200);
    send({type:'playerCommand',roomId:room.id,userId:String(userId).slice(0,100),op,payload:safe});
  },{sync:true}));
  jail.setSync('__crixRemoteOut',new ivm.Callback((userId,name,dataJson)=>{
    name=String(name);if(!/^[\w.:-]{1,40}$/.test(name))throw new Error('Nombre de evento inválido');
    if(String(dataJson).length>1e9)throw new Error('Los datos del evento superan 4 KB');
    const now=Date.now();room.remoteTimes=(room.remoteTimes||[]).filter(time=>now-time<1000);
    if(room.remoteTimes.length>=300)throw new Error('Límite de eventos remotos por segundo alcanzado');room.remoteTimes.push(now);
    let data=null;try{data=JSON.parse(String(dataJson));}catch(_){}
    send({type:'remoteOut',roomId:room.id,userId:String(userId).slice(0,100),name,data});
  },{sync:true}));
  jail.setSync('__crixAvatarCmd',new ivm.Callback((target,cmdJson)=>{
    if(String(cmdJson).length>1e9)throw new Error('La orden de avatar supera 8 KB');
    const now=Date.now();room.commandTimes=room.commandTimes.filter(time=>now-time<1000);
    if(room.commandTimes.length>=MAX_COMMANDS_PER_SECOND)throw new Error('Límite de cambios del mundo alcanzado');room.commandTimes.push(now);
    let cmd=null;try{cmd=JSON.parse(String(cmdJson));}catch(_){}
    if(!cmd||typeof cmd!=='object'||!CrixAvatar.sanitizeCommand(cmd))throw new Error('Orden de avatar inválida: '+String(cmd&&cmd.op));
    send({type:'avatarCommand',roomId:room.id,target:String(target).slice(0,120),cmd});
  },{sync:true}));
  jail.setSync('__crixSoundCmd',new ivm.Callback((target,cmdJson)=>{
    if(String(cmdJson).length>1e9)throw new Error('La orden de sonido supera 2 KB');
    const now=Date.now();room.commandTimes=room.commandTimes.filter(time=>now-time<1000);
    if(room.commandTimes.length>=MAX_COMMANDS_PER_SECOND)throw new Error('Límite de cambios del mundo alcanzado');room.commandTimes.push(now);
    let c=null;try{c=JSON.parse(String(cmdJson));}catch(_){}
    if(!c||typeof c!=='object'||!['play','stop','pause','resume','volume','speed','stopAll'].includes(c.op))throw new Error('Orden de sonido inválida');
    const num=(v,lo,hi,def)=>{v=Number(v);return Number.isFinite(v)?Math.max(lo,Math.min(hi,v)):def;};
    const cmd={op:c.op,name:String(c.name||'').slice(0,80)};
    if(c.op==='play'){cmd.volume=num(c.volume,0,10,1);cmd.speed=num(c.speed,0.1,4,1);cmd.loop=!!c.loop;cmd.part=c.part?String(c.part).slice(0,80):'';cmd.id=c.id?String(c.id).slice(0,40):'';cmd.maxDistance=num(c.maxDistance,1,10000,120);cmd.refDistance=num(c.refDistance,0.1,1000,8);}
    if(c.op==='volume')cmd.value=num(c.value,0,10,1);
    if(c.op==='speed')cmd.value=num(c.value,0.1,4,1);
    send({type:'soundCommand',roomId:room.id,target:String(target).slice(0,120),cmd});
  },{sync:true}));
  jail.setSync('__crixLog',new ivm.Callback((cls,text)=>output(room,room.currentScriptName || 'Servidor',text,cls),{sync:true}));
  context.evalSync(bootstrapSource(modules),{timeout:1000});
  const enabled = [];
  scripts.forEach((script,index)=>{
    if (String(script.code).length > MAX_SOURCE_CHARS) {
      output(room,script.name,'El script supera el límite de '+MAX_SOURCE_CHARS+' caracteres','err');
      context.evalSync(`globalThis.__crixScripts.push({name:${JSON.stringify(String(script.name||'ServerScript'))},disabled:true});`);
      return;
    }
    const code=script.language==='crixscript'?compileCrixScript(script.code):script.code;
    const name=JSON.stringify(String(script.name || 'ServerScript_'+index).slice(0,80));
    try {
      context.evalSync(`(function(){\n${code}\n;globalThis.__crixScripts.push({name:${name},onStart:typeof onStart==='function'?onStart:null,onUpdate:typeof onUpdate==='function'?onUpdate:null,onStop:typeof onStop==='function'?onStop:null,onPlayerAdded:typeof onPlayerAdded==='function'?onPlayerAdded:null,onPlayerRemoved:typeof onPlayerRemoved==='function'?onPlayerRemoved:null});\n})();`,{timeout:SCRIPT_LOAD_TIMEOUT_MS});
      enabled.push(index);
    } catch (error) { output(room,script.name,error.message,'err');context.evalSync(`globalThis.__crixScripts.push({name:${name},disabled:true});`); }
  });
  room.enabledScripts=enabled;
  rooms.set(room.id,room);
  room.started=true;
  for (const index of room.enabledScripts) invoke(room,'onStart',index,0);
  room.timer=setInterval(()=>tick(room),TICK_MS);
  send({type:'started',roomId:room.id,scriptCount:room.enabledScripts.length});
  return room;
}

// Un timeout o un error aislado (CPU del contenedor saturada, arranque en frío) ya no desactiva el script para siempre:
// solo se apaga tras varios fallos SEGUIDOS. Cualquier llamada correcta reinicia la cuenta.
const MAX_CONSECUTIVE_CALL_FAILS = 5;
const START_STOP_BUDGET_MS = 150;
const SCRIPT_LOAD_TIMEOUT_MS = 500;
function noteCallFailure(room,index,error) {
  room.callFails = room.callFails || new Map();
  const count=(room.callFails.get(index)||0)+1;
  room.callFails.set(index,count);
  const name=room.scripts[index]?.name;
  if (count>=MAX_CONSECUTIVE_CALL_FAILS) { room.disabledScripts.add(index); output(room,name,error.message+' — script desactivado tras '+count+' fallos seguidos','err'); }
  else if (count===1) output(room,name,error.message+' (se reintentará)','err');
}
function noteCallOk(room,index) { if (room.callFails) room.callFails.delete(index); }

function invoke(room,eventName,index,dt) {
  if (room.disabledScripts.has(index) || room.isolate.isDisposed) return;
  room.currentScriptName=room.scripts[index]?.name || 'ServerScript';
  try {
    const budget=eventName==='onStart'||eventName==='onStop' ? START_STOP_BUDGET_MS : Math.max(1,MAX_SCRIPT_CALL_MS);
    room.context.evalSync(`globalThis.__crixInvoke(${JSON.stringify(eventName)},${finite(dt,0,0,1)},${index});`,{timeout:budget});
    noteCallOk(room,index);
  } catch (error) {
    noteCallFailure(room,index,error);
  } finally { room.currentScriptName=''; }
}

function estimateVelocities(room,dt) {
  for (const part of room.parts.values()) {
    const before=room.lastPos.get(part.id);
    if (!part.anchored && before) room.velocity.set(part.id,{x:(part.x-before.x)/dt,y:(part.y-before.y)/dt,z:(part.z-before.z)/dt});
    else if (part.anchored && room.velocity.has(part.id)) room.velocity.delete(part.id);
    room.lastPos.set(part.id,{x:part.x,y:part.y,z:part.z});
  }
}

function tick(room) {
  if (room.busy || !room.players.length || room.isolate.isDisposed) return;
  room.busy=true;
  room.rays=0;
  try {
    estimateVelocities(room,TICK_MS/1000);
    room.context.evalSync(`globalThis.__crixPlayers=${JSON.stringify(room.players)};globalThis.__crixAdvance(${TICK_MS/1000});`,{timeout:MAX_SCRIPT_CALL_MS});
    const deadline=Date.now()+MAX_TICK_BUDGET_MS;
    for (const index of room.enabledScripts) {
      const remaining=deadline-Date.now();
      if (remaining<2) break;
      invokeWithTimeout(room,'onUpdate',index,TICK_MS/1000,Math.min(MAX_SCRIPT_CALL_MS,remaining));
    }
  } catch (error) { output(room,'Servidor','Error del entorno: '+error.message,'err'); }
  finally { room.busy=false; }
}

function invokeWithTimeout(room,eventName,index,dt,timeout) {
  if (room.disabledScripts.has(index) || room.isolate.isDisposed) return;
  room.currentScriptName=room.scripts[index]?.name || 'ServerScript';
  try {
    room.context.evalSync(`globalThis.__crixInvoke(${JSON.stringify(eventName)},${finite(dt,0,0,1)},${index});`,{timeout});
    noteCallOk(room,index);
  } catch (error) {
    noteCallFailure(room,index,error);
  } finally { room.currentScriptName=''; }
}

function playerEvent(room,kind,player) {
  if (room.isolate.isDisposed || !room.started) return;
  room.currentScriptName='Servidor';
  try { room.context.evalSync('globalThis.__crixPlayerEvent('+JSON.stringify(kind)+','+JSON.stringify(player)+');',{timeout:MAX_SCRIPT_CALL_MS}); }
  catch (error) { output(room,'Servidor','Error en evento de jugador: '+error.message,'err'); }
  finally { room.currentScriptName=''; }
}

function dispatchContacts(room,events) {
  if (room.isolate.isDisposed || !Array.isArray(events) || !events.length) return;
  room.currentScriptName='Servidor';
  try { room.context.evalSync('globalThis.__crixDispatch('+JSON.stringify(events.slice(0,60))+');',{timeout:MAX_SCRIPT_CALL_MS}); }
  catch (error) { output(room,'Servidor','Error en eventos de contacto: '+error.message,'err'); }
  finally { room.currentScriptName=''; }
}

function stopRoom(roomId) {
  const room=rooms.get(String(roomId)); if (!room) return;
  if (room.timer) clearInterval(room.timer);
  for (const index of room.enabledScripts || []) invoke(room,'onStop',index,0);
  rooms.delete(String(roomId));
  try { room.isolate.dispose(); } catch (_) {}
  send({type:'stopped',roomId:String(roomId)});
}

if (ivm) {
  process.on('message',message=>{
    if (!message || typeof message !== 'object') return;
    try {
      if (message.type==='start') createRoom(message);
      else if (message.type==='players') {
        const room=rooms.get(String(message.roomId));
        if (room) {
          const next=normalizePlayers(message.players),before=new Set(room.players.map(player=>player.userId)),after=new Set(next.map(player=>player.userId));
          const added=next.filter(player=>!before.has(player.userId)),removed=room.players.filter(player=>!after.has(player.userId));
          room.players=next;
          for (const player of added) playerEvent(room,'added',player);
          for (const player of removed) playerEvent(room,'removed',player);
        }
      } else if (message.type==='remote') {
        const room=rooms.get(String(message.roomId));
        if (room&&!room.isolate.isDisposed&&/^[\w.:-]{1,40}$/.test(String(message.name||''))) {
          const userId=String(message.userId||'').slice(0,100);
          room.currentScriptName='Servidor';
          try { room.context.evalSync('globalThis.__crixRemoteIn('+JSON.stringify(userId)+','+JSON.stringify(String(message.name))+','+JSON.stringify(JSON.stringify(message.data===undefined?null:message.data).slice(0,4096))+');',{timeout:MAX_SCRIPT_CALL_MS}); }
          catch (error) { output(room,'Servidor','Error en evento remoto: '+error.message,'err'); }
          finally { room.currentScriptName=''; }
        }
      } else if (message.type==='worldPart') {
        const room=rooms.get(String(message.roomId));
        // Si el script ya cambió esta pieza después de lo que el servidor alcanzó a aplicar, el mensaje llega viejo: se ignora.
        if (room && message.part?.id && (Number(message.appliedSeq)||0) >= (room.partSeq.get(String(message.part.id))||0)) room.parts.set(String(message.part.id),normalizePart(message.part.id,message.part));
      } else if (message.type==='worldPositions') {
        const room=rooms.get(String(message.roomId)),applied=Number(message.appliedSeq)||0;
        if (room) for (const update of Array.isArray(message.parts)?message.parts:[]) {
          const part=room.parts.get(String(update?.id||''));
          if (!part || applied < (room.partSeq.get(part.id)||0)) continue;
          part.x=finite(update.x,part.x);part.y=finite(update.y,part.y);part.z=finite(update.z,part.z);
        }
      } else if (message.type==='contacts') {
        const room=rooms.get(String(message.roomId)); if (room) dispatchContacts(room,message.events);
      } else if (message.type==='worldRemove') {
        const room=rooms.get(String(message.roomId)); if (room) room.parts.delete(String(message.id || ''));
      } else if (message.type==='stop') stopRoom(message.roomId);
      else if (message.type==='shutdown') { for (const id of [...rooms.keys()]) stopRoom(id); process.disconnect?.(); }
    } catch (error) { send({type:'roomError',roomId:String(message.roomId || ''),message:error.message || String(error)}); }
  });
  send({type:'ready'});
}

process.on('disconnect',()=>{ for (const id of [...rooms.keys()]) stopRoom(id); process.exit(0); });
