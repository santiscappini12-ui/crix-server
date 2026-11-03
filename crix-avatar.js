/* ──────────────────────────────────────────────────────────────────────────────────────────────
 *  CrixAvatar — esqueleto, diseño y animación de avatares (cliente)
 *
 *  Un único módulo que construye el MISMO avatar para el jugador local, los jugadores remotos y los NPC.
 *  El origen del grupo está en los PIES (y = 0 es el suelo) y mide ~3.05 studs, igual que la caja de colisión.
 *
 *  Esqueleto (24 huesos, jerarquía real: cada hueso rota alrededor de su articulación):
 *
 *     Root ─ Hips ─┬─ Spine ─ Chest ─┬─ Neck ─ Head ─┬─ Jaw
 *                  │                 │               ├─ EyeL / EyeR
 *                  │                 │               └─ BrowL / BrowR (en la cara)
 *                  │                 ├─ ShoulderL ─ UpperArmL ─ LowerArmL ─ HandL
 *                  │                 └─ ShoulderR ─ UpperArmR ─ LowerArmR ─ HandR
 *                  ├─ UpperLegL ─ LowerLegL ─ FootL ─ ToesL
 *                  └─ UpperLegR ─ LowerLegR ─ FootR ─ ToesR
 *
 *  Estilos: 'cartoon' (muñeco blando de colores) y 'stick' (el mismo muñeco en arcilla de un solo color, sin articulaciones).
 *  Ambos comparten silueta, esqueleto, cara y animaciones: se puede cambiar de estilo en caliente.
 *
 *  Animación: poses procedurales por capas (locomoción + gesto + overrides de script) mezcladas con
 *  cuaterniones y suavizado exponencial. Los scripts pueden rotar/mover/escalar/ocultar/pintar cualquier hueso.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';
  const DEG = Math.PI / 180;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const num = (v, d = 0) => { v = Number(v); return Number.isFinite(v) ? v : d; };

  // ══ PARTE COMPARTIDA (corre igual en el navegador y en Node: el servidor valida con estas mismas reglas) ══════
  // [nombre, padre, posición local de la articulación respecto al padre]
  const BONES = [
    ['Hips',       'Root',      [0, 1.30, 0]],
    ['Spine',      'Hips',      [0, 0.12, 0]],
    ['Chest',      'Spine',     [0, 0.42, 0]],
    ['Neck',       'Chest',     [0, 0.56, 0]],
    ['Head',       'Neck',      [0, 0.16, 0]],
    ['Jaw',        'Head',      [0, 0.08, 0.20]],
    ['EyeL',       'Head',      [-0.17, 0.40, 0.42]],
    ['EyeR',       'Head',      [0.17, 0.40, 0.42]],
    ['ShoulderL',  'Chest',     [-0.42, 0.46, 0]],
    ['ShoulderR',  'Chest',     [0.42, 0.46, 0]],
    ['UpperArmL',  'ShoulderL', [-0.14, 0, 0]],
    ['UpperArmR',  'ShoulderR', [0.14, 0, 0]],
    ['LowerArmL',  'UpperArmL', [0, -0.52, 0]],
    ['LowerArmR',  'UpperArmR', [0, -0.52, 0]],
    ['HandL',      'LowerArmL', [0, -0.44, 0]],
    ['HandR',      'LowerArmR', [0, -0.44, 0]],
    ['UpperLegL',  'Hips',      [-0.24, -0.04, 0]],
    ['UpperLegR',  'Hips',      [0.24, -0.04, 0]],
    ['LowerLegL',  'UpperLegL', [0, -0.56, 0]],
    ['LowerLegR',  'UpperLegR', [0, -0.56, 0]],
    ['FootL',      'LowerLegL', [0, -0.54, 0]],
    ['FootR',      'LowerLegR', [0, -0.54, 0]],
    ['ToesL',      'FootL',     [0, -0.06, 0.30]],
    ['ToesR',      'FootR',     [0, -0.06, 0.30]],
  ];
  const BONE_NAMES = BONES.map(b => b[0]);
  const BONE_SET = new Set(BONE_NAMES);
  const BONE_ALIAS = {
    pelvis: 'Hips', cadera: 'Hips', torso: 'Chest', pecho: 'Chest', espalda: 'Spine', cuello: 'Neck', cabeza: 'Head', mandibula: 'Jaw',
    brazoizq: 'UpperArmL', brazoder: 'UpperArmR', antebrazoizq: 'LowerArmL', antebrazoder: 'LowerArmR', manoizq: 'HandL', manoder: 'HandR',
    piernaizq: 'UpperLegL', piernader: 'UpperLegR', pantorrillaizq: 'LowerLegL', pantorrillader: 'LowerLegR', pieizq: 'FootL', pieder: 'FootR',
    hombroizq: 'ShoulderL', hombroder: 'ShoulderR', ojoizq: 'EyeL', ojoder: 'EyeR',
    leftarm: 'UpperArmL', rightarm: 'UpperArmR', leftforearm: 'LowerArmL', rightforearm: 'LowerArmR', lefthand: 'HandL', righthand: 'HandR',
    leftleg: 'UpperLegL', rightleg: 'UpperLegR', leftshin: 'LowerLegL', rightshin: 'LowerLegR', leftfoot: 'FootL', rightfoot: 'FootR',
    lefttoes: 'ToesL', righttoes: 'ToesR', root: 'Root',
  };
  function resolveBone(name) {
    const s = String(name || '').replace(/[\s_\-.]/g, ''); if (!s) return null;
    if (BONE_SET.has(s)) return s;
    const low = s.toLowerCase();
    for (const b of BONE_NAMES) if (b.toLowerCase() === low) return b;
    return BONE_ALIAS[low] || null;
  }
  const ANIM_NAMES = ['wave', 'cheer', 'point', 'clap', 'dance', 'attack', 'punch', 'shrug', 'salute', 'sit', 'crouch', 'sleep', 'dead', 'swim', 'tpose', 'think', 'laugh'];
  const ANIM_ALIAS = { saludar: 'wave', saludo: 'wave', celebrar: 'cheer', festejar: 'cheer', apuntar: 'point', aplaudir: 'clap', bailar: 'dance', golpear: 'punch', ataque: 'attack', sentarse: 'sit', sentado: 'sit', agacharse: 'crouch', dormir: 'sleep', muerto: 'dead', nadar: 'swim', pensar: 'think', reir: 'laugh', reirse: 'laugh', encoger: 'shrug' };
  function resolveAnim(name) { const s = String(name || '').toLowerCase(); return ANIM_NAMES.includes(s) ? s : (ANIM_ALIAS[s] || null); }
  const FACES = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'sleepy', 'wink', 'smug', 'scared', 'talk', 'dead'];
  const HAIRS = ['none', 'short', 'spiky', 'long', 'bun', 'cap', 'mohawk'];
  const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'capsule'];
  const DEFAULT_LOOK = { style: 'cartoon', skin: '#ffd9b3', shirt: null, pants: '#3a4668', shoes: '#22262e', hair: 'short', hairColor: '#3b2a1e', eyes: '#1b1f2a', face: 'happy', scale: 1 };
  const MAX_ACCESSORIES = 24;

  const normalizeHex = (v, fallback) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : fallback;
  function sanitizeLook(src, base) {
    const o = Object.assign({}, base || DEFAULT_LOOK);
    if (!src || typeof src !== 'object') return o;
    if (src.style === 'cartoon' || src.style === 'stick') o.style = src.style;
    for (const k of ['skin', 'shirt', 'pants', 'shoes', 'hairColor', 'eyes']) if (src[k] !== undefined) o[k] = src[k] === null ? null : normalizeHex(src[k], o[k]);
    if (HAIRS.includes(src.hair)) o.hair = src.hair;
    if (FACES.includes(src.face)) o.face = src.face;
    if (src.scale !== undefined) o.scale = clamp(num(src.scale, 1), 0.25, 4);
    return o;
  }
  const vec3 = (v, lo, hi, d = 0) => { const a = Array.isArray(v) ? v : (v && typeof v === 'object' ? [v.x, v.y, v.z] : null); return a ? [clamp(num(a[0], d), lo, hi), clamp(num(a[1], d), lo, hi), clamp(num(a[2], d), lo, hi)] : null; };
  // Propiedades de un hueso (rotación en GRADOS). Devuelve null si no hay nada válido.
  function sanitizeBoneProps(p) {
    if (!p || typeof p !== 'object') return null; const o = {};
    const rot = vec3(p.rot !== undefined ? p.rot : p.rotation, -3600, 3600); if (rot) o.rot = rot;
    const pos = vec3(p.pos !== undefined ? p.pos : (p.position !== undefined ? p.position : p.offset), -20, 20); if (pos) o.pos = pos;
    const sc = p.scale !== undefined ? p.scale : p.scl;
    if (sc !== undefined) { if (typeof sc === 'number') { const k = clamp(num(sc, 1), 0.01, 20); o.scale = [k, k, k]; } else { const v = vec3(sc, 0.01, 20, 1); if (v) o.scale = v; } }
    if (p.weight !== undefined) o.weight = clamp(num(p.weight, 1), 0, 1);
    if (p.mode === 'add' || p.mode === 'set') o.mode = p.mode;
    if (p.duration !== undefined || p.time !== undefined) o.duration = clamp(num(p.duration !== undefined ? p.duration : p.time, 0), 0, 30);
    if (p.visible !== undefined) o.visible = !!p.visible;
    const c = normalizeHex(p.color, null); if (c) o.color = c;
    if (p.reset === true) o.reset = true;
    return Object.keys(o).length ? o : null;
  }
  function sanitizeAccessory(bone, spec) {
    const b = resolveBone(bone); if (!b || b === 'Root') return null; spec = spec && typeof spec === 'object' ? spec : {};
    const o = { bone: b, shape: SHAPES.includes(spec.shape) ? spec.shape : 'box' };
    o.size = vec3(spec.size, 0.01, 12, 0.3) || [0.3, 0.3, 0.3];
    o.offset = vec3(spec.offset !== undefined ? spec.offset : spec.position, -12, 12) || [0, 0, 0];
    o.rotation = vec3(spec.rotation, -3600, 3600) || [0, 0, 0];
    o.color = normalizeHex(spec.color, '#c0c8d6');
    if (spec.opacity !== undefined) o.opacity = clamp(num(spec.opacity, 1), 0.05, 1);
    const em = normalizeHex(spec.emissive, null); if (em) o.emissive = em;
    return o;
  }
  const accId = v => String(v || '').replace(/[^\w.-]/g, '').slice(0, 40);
  // Orden recibida (de un script o de un cliente) → diferencia validada, en el formato que entiende applyState.
  //   cmd: { op, ... }.  ops: anim, stop, bone, pose, reset, resetBone, face, look, addAcc, removeAcc, hold
  function sanitizeCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return null; const op = String(cmd.op || '');
    switch (op) {
      case 'anim': { const n = resolveAnim(cmd.name); if (!n) return null; const a = { name: n }; if (cmd.speed !== undefined) a.speed = clamp(num(cmd.speed, 1), 0.1, 5); if (cmd.loop === false) { a.loop = false; a.duration = clamp(num(cmd.duration, 2), 0.2, 30); } return { anim: a }; }
      case 'stop': { if (!cmd.name) return { stop: true }; const n = resolveAnim(cmd.name); return n ? { stop: n } : null; }
      case 'bone': { const b = resolveBone(cmd.bone), p = sanitizeBoneProps(cmd.props); if (!b || b === 'Root' || !p) return null; return { bones: { [b]: p } }; }
      case 'pose': { const out = {}; if (cmd.bones && typeof cmd.bones === 'object') for (const k of Object.keys(cmd.bones).slice(0, 40)) { const b = resolveBone(k), p = sanitizeBoneProps(cmd.bones[k]); if (b && b !== 'Root' && p) out[b] = p; } return Object.keys(out).length ? { bones: out } : null; }
      case 'resetBone': { const b = resolveBone(cmd.bone); return b && b !== 'Root' ? { bones: { [b]: { reset: true } } } : null; }
      case 'reset': return { reset: true };
      case 'face': { if (cmd.name === null || cmd.name === 'auto') return { face: null, talk: !!cmd.talk }; if (!FACES.includes(cmd.name)) return null; return { face: cmd.name, talk: !!cmd.talk }; }
      case 'look': { if (!cmd.look || typeof cmd.look !== 'object') return null; const full = sanitizeLook(cmd.look, {}), l = {}; for (const k of Object.keys(cmd.look)) if (k in full) l[k] = full[k]; return Object.keys(l).length ? { look: l } : null; }
      case 'addAcc': { const id = accId(cmd.id), a = sanitizeAccessory(cmd.bone, cmd.spec); return id && a ? { acc: { [id]: a } } : null; }
      case 'removeAcc': { const id = accId(cmd.id); return id ? { acc: { [id]: null } } : null; }
      case 'hold': return { hold: !!cmd.value };
      default: return null;
    }
  }
  // Mezcla una diferencia en el estado completo (el que el servidor guarda para quien entra tarde).
  function mergeState(full, diff) {
    if (!diff) return full;
    if (diff.reset) { delete full.anim; delete full.face; delete full.talk; delete full.hold; full.bones = {}; full.acc = {}; }
    if (diff.stop) { if (diff.stop === true || (full.anim && full.anim.name === diff.stop)) delete full.anim; }
    if (diff.anim) full.anim = diff.anim;
    if (diff.face !== undefined) { if (diff.face === null) delete full.face; else full.face = diff.face; full.talk = !!diff.talk; }
    if (diff.hold !== undefined) full.hold = diff.hold;
    if (diff.look) full.look = Object.assign(full.look || {}, diff.look);
    if (diff.bones) { full.bones = full.bones || {}; for (const k of Object.keys(diff.bones)) { const p = diff.bones[k]; if (p.reset) delete full.bones[k]; else full.bones[k] = Object.assign(full.bones[k] || {}, p); } }
    if (diff.acc) { full.acc = full.acc || {}; for (const k of Object.keys(diff.acc)) { if (diff.acc[k] === null) delete full.acc[k]; else if (Object.keys(full.acc).length < MAX_ACCESSORIES || full.acc[k]) full.acc[k] = diff.acc[k]; } }
    return full;
  }
  const Shared = { BONES: BONE_NAMES, BONE_TREE: BONES, ANIMATIONS: ANIM_NAMES, FACES, HAIRS, SHAPES, DEFAULT_LOOK, MAX_ACCESSORIES, resolveBone, resolveAnim, sanitizeLook, sanitizeBoneProps, sanitizeAccessory, sanitizeCommand, mergeState };
  if (typeof module !== 'undefined' && module.exports) module.exports = Shared;

  // ══ PARTE GRÁFICA (solo navegador, necesita THREE r128) ══════════════════════════════════════════════════════
  const THREE = global.THREE;
  if (!THREE) { global.CrixAvatarShared = Shared; return; }
  const CLAY = 0xe9e8e4;      // color del estilo 'stick' (muñeco de arcilla de un solo color)
  const BASE_SCALE = 0.83;   // el rig completo mide ~3.1 studs (caja de colisión del juego: 3.05)

  // ── Geometría (r128: no hay CapsuleGeometry) ──────────────────────────────────────────────────
  function capsuleGeo(radius, length, seg = 10) {
    // Perfil de abajo hacia arriba (y ascendente, x: 0 → r → 0): así las normales de LatheGeometry salen hacia afuera.
    const pts = [], half = Math.max(0, length) / 2, rs = Math.max(3, seg >> 1);
    for (let i = 0; i <= rs; i++) { const a = (i / rs) * Math.PI / 2; pts.push(new THREE.Vector2(Math.sin(a) * radius, -half - Math.cos(a) * radius)); }
    for (let i = 0; i <= rs; i++) { const a = (i / rs) * Math.PI / 2; pts.push(new THREE.Vector2(Math.cos(a) * radius, half + Math.sin(a) * radius)); }
    return new THREE.LatheGeometry(pts, seg);
  }
  function roundedBoxGeo(w, h, d, r, seg = 3) {
    const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg), p = g.attributes.position, v = new THREE.Vector3(), inner = new THREE.Vector3(w / 2 - r, h / 2 - r, d / 2 - r);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const c = new THREE.Vector3(clamp(v.x, -inner.x, inner.x), clamp(v.y, -inner.y, inner.y), clamp(v.z, -inner.z, inner.z));
      const dir = v.clone().sub(c); if (dir.lengthSq() > 1e-9) dir.normalize().multiplyScalar(r);
      p.setXYZ(i, c.x + dir.x, c.y + dir.y, c.z + dir.z);
    }
    g.computeVertexNormals(); return g;
  }
  const geoCache = {};
  function G(key, make) { return geoCache[key] || (geoCache[key] = make()); }

  // ── Construcción ──────────────────────────────────────────────────────────────────────────────
  // Cada hueso lleva un hijo "visual" (Group) donde viven las mallas; así se puede escalar/ocultar/pintar sin tocar la jerarquía.
  function buildAvatar(look, opts) {
    look = sanitizeLook(look);
    const root = new THREE.Group(); root.name = 'CrixAvatar';
    const bones = { Root: root }, visuals = {}, mats = {};
    for (const [name, parent, pos] of BONES) {
      const b = new THREE.Group(); b.name = name; b.position.set(pos[0], pos[1], pos[2]); bones[parent].add(b); bones[name] = b;
      const v = new THREE.Group(); v.name = name + '_vis'; b.add(v); visuals[name] = v;
      b.userData.rest = { p: b.position.clone(), q: b.quaternion.clone() };
    }
    const av = { root, bones, visuals, look, mats, parts: {}, accessories: {}, face: null, hair: null, joints: [], style: null };
    av.mats.skin = new THREE.MeshPhongMaterial({ color: 0xffd9b3, shininess: 20 });
    av.mats.shirt = new THREE.MeshPhongMaterial({ color: 0x5b8def, shininess: 25 });
    av.mats.pants = new THREE.MeshPhongMaterial({ color: 0x3a4668, shininess: 15 });
    av.mats.shoes = new THREE.MeshPhongMaterial({ color: 0x22262e, shininess: 30 });
    av.mats.hair = new THREE.MeshPhongMaterial({ color: 0x3b2a1e, shininess: 40 });
    av.mats.white = new THREE.MeshPhongMaterial({ color: CLAY, shininess: 8 });
    av.mats.joint = new THREE.MeshPhongMaterial({ color: 0xb9c2d0, shininess: 40 });
    av.mats.eyeW = new THREE.MeshBasicMaterial({ color: 0xffffff });
    av.mats.eye = new THREE.MeshBasicMaterial({ color: 0x1b1f2a });
    av.mats.line = new THREE.MeshBasicMaterial({ color: 0x1b1f2a });
    av.mats.mouthIn = new THREE.MeshBasicMaterial({ color: 0x6a1d2a, side: THREE.DoubleSide });
    av.mats.blush = new THREE.MeshBasicMaterial({ color: 0xff8a8a, transparent: true, opacity: 0.45 });
    av.pose = {}; av.target = {}; av.layers = { anim: null, emote: null, over: {} };
    av.state = { t: Math.random() * 10, blinkT: 2 + Math.random() * 3, blink: 0, face: look.face, faceT: 0, talk: 0, loco: 'idle', locoBlend: 0, phase: 0, landT: 0, lastGround: true, lastVy: 0, sitting: false };
    for (const n of BONE_NAMES) { av.pose[n] = { q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(1, 1, 1) }; }
    buildFace(av);
    applyLook(av, look);
    if (opts && opts.shadows !== false) root.traverse(o => { if (o.isMesh && !o.userData.noShadow) { o.castShadow = true; o.receiveShadow = false; } });
    root.userData.avatar = av;
    return av;
  }

  function addMesh(av, boneName, geo, mat, pos, rot, scl, tag) {
    const m = new THREE.Mesh(geo, mat); if (pos) m.position.set(pos[0], pos[1], pos[2]); if (rot) m.rotation.set(rot[0], rot[1], rot[2]); if (scl) m.scale.set(scl[0], scl[1], scl[2]);
    m.userData.tag = tag || 'body'; av.visuals[boneName].add(m); return m;
  }
  function clearTag(av, tag) {
    for (const n of BONE_NAMES) { const v = av.visuals[n]; for (let i = v.children.length - 1; i >= 0; i--) { const c = v.children[i]; if (c.userData.tag === tag) v.remove(c); } }
  }

  // Cuerpo: se vuelve a generar al cambiar de estilo.
  // Ambos estilos comparten la MISMA silueta de muñeco blando (cabeza grande y redonda, torso en forma de pera, brazos y
  // piernas gruesos que terminan en manoplas y pies redondos, sin cuello visible). Solo cambia el color:
  //   'cartoon' → piel / camisa / pantalón / zapatos          'stick' → todo de un solo color de arcilla, sin articulaciones.
  // Cada pieza es un elipsoide o una cápsula que nace en la articulación de su hueso, así que al doblarse las uniones
  // quedan redondeadas y sin huecos.
  function buildBody(av, style) {
    clearTag(av, 'body'); clearTag(av, 'joint'); clearTag(av, 'hair');
    const M = av.mats, clay = style === 'stick';
    const C = clay ? { skin: M.white, shirt: M.white, pants: M.white, shoes: M.white } : { skin: M.skin, shirt: M.shirt, pants: M.pants, shoes: M.shoes };
    const ell = (bone, mat, pos, r) => addMesh(av, bone, G('uSph', () => new THREE.SphereGeometry(1, 28, 20)), mat, pos, null, r);   // elipsoide de radios r
    // cápsula colgando de la articulación: el cilindro baja `len` y las dos tapas redondeadas la suavizan
    const cap = (bone, mat, r, len) => addMesh(av, bone, G('pc' + r + 'x' + len, () => capsuleGeo(r, len, 14)), mat, [0, -len / 2, 0]);
    // tronco: tres elipsoides muy solapados para que no se note el "estrangulamiento" entre ellos al doblar la espalda
    ell('Hips',  C.pants, [0, 0.00, 0],  [0.50, 0.34, 0.40]);
    ell('Spine', C.shirt, [0, 0.24, 0],  [0.52, 0.44, 0.40]);
    ell('Chest', C.shirt, [0, 0.26, 0],  [0.52, 0.46, 0.40]);
    ell('Neck',  C.skin,  [0, 0.06, 0],  [0.26, 0.20, 0.24]);       // cuello corto y ancho: la cabeza casi se apoya en el torso
    addMesh(av, 'Head', G('cHead', () => new THREE.SphereGeometry(0.52, 32, 24)), C.skin, [0, 0.52, 0], null, [1.06, 1.0, 1.02]);
    for (const s of ['L', 'R']) {
      ell('Shoulder' + s, C.shirt, [0, 0, 0], [0.23, 0.23, 0.23]);
      cap('UpperArm' + s, C.shirt, 0.20, 0.32);
      cap('LowerArm' + s, C.skin,  0.185, 0.255);
      ell('Hand' + s, C.skin, [0, -0.12, 0], [0.20, 0.23, 0.18]);   // manopla redondeada
      cap('UpperLeg' + s, C.pants, 0.225, 0.56);
      cap('LowerLeg' + s, C.pants, 0.20, 0.34);
      ell('Foot' + s, C.shoes, [0, -0.02, 0.06], [0.215, 0.15, 0.30]);
      ell('Toes' + s, C.shoes, [0, 0.0, 0.02],   [0.19, 0.10, 0.16]);
    }
    buildHair(av, av.look.hair);
  }

  // ── Cara: ojos con párpados y pupilas, cejas, boca deformable, rubor ─────────────────────────
  function buildFace(av) {
    const M = av.mats, head = av.visuals.Head, F = new THREE.Group(); F.name = 'Face'; head.add(F); F.userData.noShadow = true;
    const eyes = {}, brows = {};
    for (const s of ['L', 'R']) {
      const sx = s === 'L' ? -1 : 1, eyeBone = av.visuals['Eye' + s];
      const white = new THREE.Mesh(G('eyeW', () => new THREE.SphereGeometry(0.13, 14, 12)), M.eyeW); white.scale.set(1, 1.18, 0.55); white.userData.tag = 'face'; eyeBone.add(white);
      const pupil = new THREE.Mesh(G('eyeP', () => new THREE.SphereGeometry(0.078, 12, 10)), M.eye); pupil.position.set(0, 0, 0.05); pupil.scale.set(1, 1.1, 0.5); pupil.userData.tag = 'face'; eyeBone.add(pupil);
      const glint = new THREE.Mesh(G('eyeG', () => new THREE.SphereGeometry(0.02, 6, 6)), M.eyeW); glint.position.set(0.025, 0.03, 0.075); glint.userData.tag = 'face'; eyeBone.add(glint);
      const lid = new THREE.Mesh(G('lid', () => new THREE.SphereGeometry(0.122, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)), M.skin); // párpado: media esfera que baja
      lid.scale.set(1, 1.2, 0.6); lid.userData.tag = 'face'; lid.position.z = 0.012; lid.rotation.x = -0.0; eyeBone.add(lid); lid.visible = false;
      eyes[s] = { white, pupil, glint, lid, bone: eyeBone };
      const brow = new THREE.Mesh(G('brow', () => capsuleGeo(0.032, 0.15, 6)), M.hair); brow.rotation.z = Math.PI / 2; brow.position.set(sx * 0.17, 0.60, 0.455); brow.userData.tag = 'face'; F.add(brow); brows[s] = brow;
      const blush = new THREE.Mesh(G('blush', () => new THREE.CircleGeometry(0.07, 12)), M.blush); blush.position.set(sx * 0.29, 0.24, 0.43); blush.lookAt(sx * 0.5, 0.2, 1.2); blush.userData.tag = 'face'; F.add(blush); av.parts['blush' + s] = blush;
    }
    // Boca: línea (tubo) con curva editable + interior oscuro para abierta
    const mouthGroup = new THREE.Group(); mouthGroup.position.set(0, 0.15, 0.475); F.add(mouthGroup);
    const mouthLine = new THREE.Mesh(new THREE.BufferGeometry(), M.line); mouthLine.userData.tag = 'face'; mouthGroup.add(mouthLine);
    const mouthIn = new THREE.Mesh(new THREE.BufferGeometry(), M.mouthIn); mouthIn.userData.tag = 'face'; mouthGroup.add(mouthIn);
    const nose = new THREE.Mesh(G('nose', () => new THREE.SphereGeometry(0.035, 8, 6)), M.skin); nose.position.set(0, 0.29, 0.51); nose.scale.set(1, 0.9, 0.8); nose.userData.tag = 'face'; F.add(nose);
    av.face = { group: F, eyes, brows, mouthLine, mouthIn, mouthGroup, cur: { open: 0, curve: 0.3, width: 0.12, browA: 0, browY: 0, browR: 0, lid: 0, look: [0, 0], blushA: 0.3 } };
    updateMouth(av);
  }
  const FACE_PRESETS = {
    neutral:   { open: 0, curve: 0.0,  width: 0.09, browA: 0,    browY: 0,    lid: 0,    blushA: 0.2 },
    happy:     { open: 0.04, curve: 0.55, width: 0.14, browA: 0.1, browY: 0.02, lid: 0,   blushA: 0.5 },
    sad:       { open: 0, curve: -0.5, width: 0.10, browA: -0.45, browY: 0.0,  lid: 0.25, blushA: 0.1 },
    angry:     { open: 0, curve: -0.35, width: 0.12, browA: 0.55, browY: -0.04, lid: 0.3, blushA: 0.1 },
    surprised: { open: 0.55, curve: 0.0, width: 0.08, browA: 0.2, browY: 0.07, lid: -0.2, blushA: 0.1 },
    sleepy:    { open: 0, curve: 0.05, width: 0.08, browA: -0.1, browY: -0.01, lid: 0.8, blushA: 0.3 },
    wink:      { open: 0.1, curve: 0.65, width: 0.15, browA: 0.1, browY: 0.02, lid: 0,   blushA: 0.5 },
    smug:      { open: 0, curve: 0.35, width: 0.13, browA: 0.3, browY: 0.0,  lid: 0.35, blushA: 0.2 },
    scared:    { open: 0.35, curve: -0.2, width: 0.10, browA: -0.3, browY: 0.06, lid: -0.15, blushA: 0.0 },
    talk:      { open: 0.2, curve: 0.2, width: 0.11, browA: 0.05, browY: 0.01, lid: 0,   blushA: 0.3 },
    dead:      { open: 0.15, curve: -0.3, width: 0.10, browA: -0.2, browY: 0,   lid: 0,   blushA: 0.0 },
  };
  function updateMouth(av) {
    const f = av.face, c = f.cur, w = c.width, cv = c.curve * 0.09, op = c.open * 0.16, N = 14, pts = [];
    // curva > 0: sonrisa (el centro baja respecto de las comisuras); curva < 0: boca triste
    for (let i = 0; i <= N; i++) { const t = i / N * 2 - 1; pts.push(new THREE.Vector3(t * w, -cv * (1 - t * t), 0)); }
    f.mouthLine.geometry.dispose(); f.mouthLine.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.018, 5, false);
    if (op > 0.01) { // interior abierto con forma de lente
      const shape = new THREE.Shape(); shape.moveTo(-w, 0);
      shape.quadraticCurveTo(0, -op * 2 - Math.abs(cv) * 0.5, w, 0); shape.quadraticCurveTo(0, Math.abs(cv) * 0.5 + 0.005, -w, 0);
      f.mouthIn.geometry.dispose(); f.mouthIn.geometry = new THREE.ShapeGeometry(shape, 8); f.mouthIn.visible = true; f.mouthIn.position.z = 0.002;
    } else f.mouthIn.visible = false;
  }

  // ── Pelo / accesorios de cabeza ──────────────────────────────────────────────────────────────
  function buildHair(av, kind) {
    clearTag(av, 'hair'); const M = av.mats, add = (geo, pos, rot, scl, mat) => addMesh(av, 'Head', geo, mat || M.hair, pos, rot, scl, 'hair');
    // Cúpula del pelo: solo cubre la parte alta de la cabeza (la cara queda libre) y queda un poco más grande que el cráneo.
    const dome = G('hDome', () => new THREE.SphereGeometry(0.575, 26, 14, 0, Math.PI * 2, 0, Math.PI * 0.46));
    const DP = [0, 0.55, -0.035], DR = [-0.16, 0, 0];
    switch (kind) {
      case 'short': add(dome, DP, DR); break;
      case 'spiky': add(dome, DP, DR); for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2; add(G('spk', () => new THREE.ConeGeometry(0.12, 0.34, 6)), [Math.cos(a) * 0.34, 1.0 + (i % 2) * 0.03, Math.sin(a) * 0.30 - 0.06], [Math.sin(a) * 0.45, 0, -Math.cos(a) * 0.45]); } add(G('spk2', () => new THREE.ConeGeometry(0.15, 0.42, 6)), [0, 1.12, -0.04]); break;
      case 'long': add(dome, DP, DR, [1.04, 1.02, 1.04]); add(G('hLong', () => roundedBoxGeo(1.08, 1.0, 0.30, 0.15)), [0, 0.26, -0.36]); break;
      case 'bun': add(dome, DP, DR); add(G('bun', () => new THREE.SphereGeometry(0.24, 14, 12)), [0, 1.10, -0.14]); break;
      case 'mohawk': for (let i = 0; i < 5; i++) add(G('mh', () => roundedBoxGeo(0.12, 0.34, 0.26, 0.05)), [0, 1.0 + (i === 2 ? 0.05 : 0) - Math.abs(i - 2) * 0.03, 0.30 - i * 0.15], [(i - 2) * 0.12, 0, 0]); break;
      case 'cap': add(dome, DP, DR, [1.03, 1.03, 1.03], M.shirt); add(G('visor', () => roundedBoxGeo(0.72, 0.06, 0.46, 0.03)), [0, 0.74, 0.50], [0.12, 0, 0], null, M.shirt); break;
      default: break;
    }
    av.mats.hair.needsUpdate = true;
    // cejas del color del pelo salvo "none"
    av.mats.brow = av.mats.hair;
  }

  function applyLook(av, look) {
    av.look = sanitizeLook(look, av.look);
    const L = av.look, M = av.mats;
    M.skin.color.set(L.style === 'stick' ? CLAY : L.skin); M.pants.color.set(L.pants); M.shoes.color.set(L.shoes); M.hair.color.set(L.hairColor); M.eye.color.set(L.eyes);
    const shirt = L.shirt || (av.userColor || '#5b8def'); M.shirt.color.set(shirt);
    if (av.style !== L.style) { av.style = L.style; buildBody(av, L.style); }
    else buildHair(av, L.hair);
    // Monigote: cabeza y cejas visibles; cejas siempre en oscuro
    M.hair.color.set(L.style === 'stick' && L.hair === 'none' ? '#1b1f2a' : L.hairColor);
    av.root.scale.setScalar(L.scale * BASE_SCALE);
    av.state.face = L.face; av.state.faceT = 0;
    av.root.traverse(o => { if (o.isMesh && !o.userData.noShadow && o.userData.tag !== 'face') o.castShadow = true; });
  }
  function setUserColor(av, color) { av.userColor = color; if (!av.look.shirt) av.mats.shirt.color.set(color); }

  // ── Animación ────────────────────────────────────────────────────────────────────────────────
  // Una pose = { Bone: [rx, ry, rz] (radianes), Hips_y: offset vertical, Hips_z... }. Se arma por funciones puras de (t, ctx).
  const E = new THREE.Euler(), Q = new THREE.Quaternion();
  const sin = Math.sin, cos = Math.cos, PI = Math.PI;
  const smooth = (a, b, t) => a + (b - a) * t;

  function poseIdle(t, c) {
    const b = sin(t * 1.8), k = sin(t * 0.9);
    return { Hips: [0, 0, 0], _y: b * 0.015, Spine: [0.03 + b * 0.015, 0, 0], Chest: [0.02 + b * 0.02, k * 0.03, 0], Neck: [-0.03, k * 0.06, 0], Head: [0.02, -k * 0.05, 0],
      ShoulderL: [0, 0, 0.04 + b * 0.01], ShoulderR: [0, 0, -0.04 - b * 0.01],
      UpperArmL: [0.05 + b * 0.02, 0, 0.27], UpperArmR: [0.05 + b * 0.02, 0, -0.27], LowerArmL: [-0.14, 0, 0], LowerArmR: [-0.14, 0, 0], HandL: [0, 0, 0.05], HandR: [0, 0, -0.05],
      UpperLegL: [0, 0, 0.02], UpperLegR: [0, 0, -0.02], LowerLegL: [0.02, 0, 0], LowerLegR: [0.02, 0, 0], FootL: [0, 0, 0], FootR: [0, 0, 0] };
  }
  // Ciclo de marcha/carrera: fase p en [0, 2π). amp y lean dependen de la velocidad (0..1 caminar, 1..2 correr).
  function poseLocomotion(p, run, c) {
    const s = sin(p), s2 = sin(p + PI), cc = cos(p), c2 = cos(p + PI), r = clamp(run, 0, 1.6);
    const legAmp = smooth(0.62, 1.05, r), kneeAmp = smooth(0.7, 1.5, r), armAmp = smooth(0.55, 1.0, r), lean = smooth(0.04, 0.26, r);
    const kneeL = Math.max(0, cc) * kneeAmp + 0.08, kneeR = Math.max(0, c2) * kneeAmp + 0.08; // la rodilla se flexiona al levantar la pierna
    const bob = Math.abs(cos(p)) * smooth(0.05, 0.14, r);
    return { _y: -0.02 + bob - smooth(0.0, 0.05, r), Hips: [lean * 0.4, sin(p) * 0.12 * smooth(1, 0.6, r), cc * 0.05],
      Spine: [lean * 0.5, -sin(p) * 0.16, -cc * 0.03], Chest: [lean * 0.7, -sin(p) * 0.18, 0], Neck: [-lean * 0.6, sin(p) * 0.06, 0], Head: [-lean * 0.4, sin(p) * 0.05, 0],
      ShoulderL: [0, 0, 0.03], ShoulderR: [0, 0, -0.03],
      UpperArmL: [s2 * armAmp, 0, 0.16], UpperArmR: [s * armAmp, 0, -0.16],
      LowerArmL: [-(0.35 + Math.max(0, -s2) * 0.7 * r + r * 0.5), 0, 0], LowerArmR: [-(0.35 + Math.max(0, -s) * 0.7 * r + r * 0.5), 0, 0], HandL: [0, 0, 0], HandR: [0, 0, 0],
      UpperLegL: [s * legAmp, 0, 0.02], UpperLegR: [s2 * legAmp, 0, -0.02],
      LowerLegL: [kneeL * (cc > 0 ? 1 : 0.35), 0, 0], LowerLegR: [kneeR * (c2 > 0 ? 1 : 0.35), 0, 0],
      FootL: [-s * 0.3 - kneeL * 0.2, 0, 0], FootR: [-s2 * 0.3 - kneeR * 0.2, 0, 0], ToesL: [Math.max(0, -cc) * 0.3, 0, 0], ToesR: [Math.max(0, -c2) * 0.3, 0, 0] };
  }
  function poseJump(vy) { // subiendo: brazos arriba, piernas recogidas
    const k = clamp(vy * 2.5, 0, 1);
    return { _y: 0.04, Hips: [0.05, 0, 0], Spine: [-0.05, 0, 0], Chest: [-0.12 * k, 0, 0], Neck: [0.05, 0, 0], Head: [-0.1, 0, 0],
      UpperArmL: [-(1.2 + 0.9 * k), 0, 0.55], UpperArmR: [-(1.2 + 0.9 * k), 0, -0.55], LowerArmL: [-0.3, 0, 0], LowerArmR: [-0.3, 0, 0],
      UpperLegL: [-0.55, 0, 0.05], UpperLegR: [0.1, 0, -0.05], LowerLegL: [0.9, 0, 0], LowerLegR: [0.25, 0, 0], FootL: [0.2, 0, 0], FootR: [0.1, 0, 0] };
  }
  function poseFall(t) { // cayendo: brazos abiertos, piernas ligeramente separadas
    const f = sin(t * 9) * 0.06;
    return { _y: 0, Hips: [0.04, 0, 0], Spine: [-0.06, 0, 0], Chest: [-0.05, 0, 0], Head: [-0.12, 0, 0],
      UpperArmL: [-1.2 + f, 0, 0.95], UpperArmR: [-1.2 - f, 0, -0.95], LowerArmL: [-0.5, 0, 0], LowerArmR: [-0.5, 0, 0],
      UpperLegL: [-0.25, 0, 0.18], UpperLegR: [0.18, 0, -0.18], LowerLegL: [0.5, 0, 0], LowerLegR: [0.35, 0, 0], FootL: [0.35, 0, 0], FootR: [0.3, 0, 0] };
  }
  function poseLand(k) { // amortiguación al aterrizar (k: 1 → 0)
    return { _y: -0.34 * k, Hips: [0.18 * k, 0, 0], Spine: [0.2 * k, 0, 0], Chest: [0.18 * k, 0, 0], Head: [-0.2 * k, 0, 0],
      UpperArmL: [0.4 * k, 0, 0.3 * k], UpperArmR: [0.4 * k, 0, -0.3 * k],
      UpperLegL: [-0.95 * k, 0, 0.1], UpperLegR: [-0.95 * k, 0, -0.1], LowerLegL: [1.5 * k, 0, 0], LowerLegR: [1.5 * k, 0, 0], FootL: [-0.5 * k, 0, 0], FootR: [-0.5 * k, 0, 0] };
  }
  function poseSit() { return { _y: -0.58, Hips: [-0.05, 0, 0], Spine: [0.08, 0, 0], Head: [-0.05, 0, 0], UpperArmL: [-0.5, 0, 0.1], UpperArmR: [-0.5, 0, -0.1], LowerArmL: [-0.9, 0, 0], LowerArmR: [-0.9, 0, 0], UpperLegL: [-1.5, 0, 0.12], UpperLegR: [-1.5, 0, -0.12], LowerLegL: [1.5, 0, 0], LowerLegR: [1.5, 0, 0], FootL: [0, 0, 0], FootR: [0, 0, 0] }; }
  function poseCrouch(t) { const b = sin(t * 2) * 0.01; return { _y: -0.5, Hips: [0.35, 0, 0], Spine: [0.35, 0, 0], Chest: [0.2, 0, 0], Head: [-0.4 + b, 0, 0], UpperArmL: [-0.6, 0, 0.2], UpperArmR: [-0.6, 0, -0.2], LowerArmL: [-0.9, 0, 0], LowerArmR: [-0.9, 0, 0], UpperLegL: [-1.25, 0, 0.14], UpperLegR: [-1.25, 0, -0.14], LowerLegL: [1.9, 0, 0], LowerLegR: [1.9, 0, 0], FootL: [-0.55, 0, 0], FootR: [-0.55, 0, 0] }; }
  function poseSwim(t) { const s = sin(t * 5); return { _y: -0.6, Hips: [1.2, 0, 0], Spine: [0.1, 0, 0], Chest: [0, s * 0.2, 0], Head: [-1.0, 0, 0], UpperArmL: [-2.8 + s * 0.8, 0, 0.3], UpperArmR: [-2.8 - s * 0.8, 0, -0.3], LowerArmL: [-0.3, 0, 0], LowerArmR: [-0.3, 0, 0], UpperLegL: [-s * 0.5, 0, 0.1], UpperLegR: [s * 0.5, 0, -0.1], LowerLegL: [0.3 + s * 0.2, 0, 0], LowerLegR: [0.3 - s * 0.2, 0, 0] }; }
  function poseDead() { return { _y: -1.1, Hips: [-1.45, 0, 0], Spine: [0.1, 0, 0.1], Head: [0.2, 0.3, 0], UpperArmL: [-0.3, 0, 1.2], UpperArmR: [0.4, 0, -1.3], LowerArmL: [-0.4, 0, 0], LowerArmR: [-0.2, 0, 0], UpperLegL: [0.1, 0, 0.2], UpperLegR: [-0.1, 0, -0.35], LowerLegL: [0.2, 0, 0], LowerLegR: [0.5, 0, 0] }; }

  // Gestos / emotes: cada uno es (t) → pose parcial. Se mezclan sobre la locomoción con peso (los huesos no listados siguen a la capa base).
  const EMOTES = {
    wave:   { loop: true,  fn: t => ({ UpperArmR: [-2.7, 0, -0.45 + sin(t * 9) * 0.0], LowerArmR: [-0.6 + sin(t * 9) * 0.5, 0, 0], HandR: [0, 0, sin(t * 9) * 0.3], Head: [0, 0.15, 0.06], Chest: [0, -0.1, 0], _face: 'happy' }) },
    cheer:  { loop: true,  fn: t => ({ _y: Math.abs(sin(t * 6)) * 0.12, UpperArmL: [-2.9, 0, 0.35 + sin(t * 6) * 0.1], UpperArmR: [-2.9, 0, -0.35 - sin(t * 6) * 0.1], LowerArmL: [-0.3, 0, 0], LowerArmR: [-0.3, 0, 0], Head: [-0.25, 0, 0], Chest: [-0.1, 0, 0], UpperLegL: [-0.1 * sin(t * 6), 0, 0.1], UpperLegR: [0.1 * sin(t * 6), 0, -0.1], _face: 'happy' }) },
    point:  { loop: true,  fn: t => ({ UpperArmR: [-1.57, -0.15, -0.05], LowerArmR: [0, 0, 0], HandR: [0, 0, 0], Chest: [0, -0.2, 0], Head: [0, 0.2, 0] }) },
    clap:   { loop: true,  fn: t => { const k = (sin(t * 12) + 1) * 0.5; return { UpperArmL: [-1.2, 0.55 - k * 0.2, 0.15], UpperArmR: [-1.2, -0.55 + k * 0.2, -0.15], LowerArmL: [-1.2, 0.3, 0], LowerArmR: [-1.2, -0.3, 0], _face: 'happy' }; } },
    dance:  { loop: true,  fn: t => { const b = sin(t * 8), s = sin(t * 4); return { _y: Math.abs(b) * 0.1 - 0.05, Hips: [0, s * 0.45, b * 0.1], Spine: [0.05, -s * 0.3, -b * 0.08], Chest: [0, -s * 0.3, 0], Head: [b * 0.06, s * 0.3, -b * 0.12], UpperArmL: [-1.9 + b * 0.5, 0, 0.4 + s * 0.4], UpperArmR: [-1.9 - b * 0.5, 0, -0.4 + s * 0.4], LowerArmL: [-0.9, 0, 0], LowerArmR: [-0.9, 0, 0], UpperLegL: [-b * 0.4, 0, 0.18 + s * 0.12], UpperLegR: [b * 0.4, 0, -0.18 + s * 0.12], LowerLegL: [Math.max(0, b) * 0.9, 0, 0], LowerLegR: [Math.max(0, -b) * 0.9, 0, 0], _face: 'happy' }; } },
    attack: { loop: false, dur: 0.45, fn: (t, d) => { const k = clamp(t / d, 0, 1), w = k < 0.35 ? k / 0.35 : 1 - (k - 0.35) / 0.65, hit = k < 0.35 ? -w * 0.9 : w * 1.1; return { Chest: [0, -0.6 * (k < 0.35 ? w : -w * 0.4), 0], Spine: [0.1, -0.3 * (k < 0.35 ? w : -w * 0.4), 0], UpperArmR: [-1.0 - hit * 1.2, -0.3, -0.2], LowerArmR: [-0.5 + (k < 0.35 ? 0 : 0.5 * w), 0, 0], UpperArmL: [-0.5, 0, 0.5], LowerArmL: [-1.0, 0, 0], _face: 'angry' }; } },
    punch:  { loop: false, dur: 0.4, fn: (t, d) => { const k = clamp(t / d, 0, 1), e = k < 0.4 ? k / 0.4 : 1 - (k - 0.4) / 0.6; return { Chest: [0, 0.5 * e, 0], UpperArmR: [-1.57 * e, 0, -0.1], LowerArmR: [-0.3 + 0.3 * e, 0, 0], UpperArmL: [-0.8, 0, 0.3], LowerArmL: [-1.6, 0, 0], _face: 'angry' }; } },
    shrug:  { loop: false, dur: 1.2, fn: (t, d) => { const k = sin(clamp(t / d, 0, 1) * PI); return { ShoulderL: [0, 0, 0.45 * k], ShoulderR: [0, 0, -0.45 * k], UpperArmL: [-0.5 * k, 0, 0.5 * k], UpperArmR: [-0.5 * k, 0, -0.5 * k], LowerArmL: [-1.0 * k, 0, 0], LowerArmR: [-1.0 * k, 0, 0], Head: [0, 0, 0.15 * k], _face: 'smug' }; } },
    salute: { loop: true,  fn: t => ({ UpperArmR: [-1.0, 0.7, -1.5], LowerArmR: [-2.1, 0, 0], HandR: [0, 0, 0], Head: [-0.05, 0, 0] }) },
    sit:    { loop: true,  base: true, fn: t => poseSit() },
    crouch: { loop: true,  base: true, fn: t => poseCrouch(t) },
    sleep:  { loop: true,  base: true, fn: t => Object.assign(poseDead(), { _face: 'sleepy' }) },
    dead:   { loop: true,  base: true, fn: t => Object.assign(poseDead(), { _face: 'dead' }) },
    swim:   { loop: true,  base: true, fn: t => poseSwim(t) },
    tpose:  { loop: true,  base: true, fn: t => ({ UpperArmL: [0, 0, PI / 2], UpperArmR: [0, 0, -PI / 2] }) },
    think:  { loop: true,  fn: t => ({ UpperArmR: [-1.0, 0.5, -0.2], LowerArmR: [-2.2, 0, 0], Head: [0.1, 0.25, 0.1], _face: 'neutral' }) },
    laugh:  { loop: true,  fn: t => ({ Chest: [-0.15 + sin(t * 18) * 0.05, 0, 0], Head: [-0.25 + sin(t * 18) * 0.05, 0, 0], UpperArmL: [-0.5, 0, 0.3], UpperArmR: [-0.5, 0, -0.3], LowerArmL: [-1.4, 0, 0], LowerArmR: [-1.4, 0, 0], _face: 'happy', _talk: 1 }) },
  };

  // update(av, dt, ctx): avanza la animación.
  //   ctx.speed    velocidad horizontal en studs/s (13.8 = velocidad normal del juego)
  //   ctx.onGround ¿apoyado en el suelo?        ctx.vy  velocidad vertical en studs por tick de 60 Hz (como gVelY)
  //   ctx.lookX/lookY (opcional) mirada de los ojos −1..1        ctx.snap (opcional) sin suavizado
  const IDENT = new THREE.Quaternion();
  const LEGS = /Leg|Foot|Toes/;
  function blendInto(av, name, q, w) { // mezcla q en el objetivo del hueso con peso w (w=1 reemplaza)
    const T = av.target[name] || (av.target[name] = { q: new THREE.Quaternion(), has: false });
    if (!T.has) { T.q.copy(q); T.has = true; } else T.q.slerp(q, clamp(w, 0, 1));
  }
  function addInto(av, name, q, w) { // compone q ENCIMA de la pose actual del hueso (aditivo)
    const T = av.target[name] || (av.target[name] = { q: new THREE.Quaternion(), has: false });
    const qq = IDENT.clone().slerp(q, clamp(w, 0, 1)); if (!T.has) { T.q.copy(qq); T.has = true; } else T.q.multiply(qq);
  }
  const eulerQ = (a) => { E.set(a[0] || 0, a[1] || 0, a[2] || 0, 'XYZ'); return new THREE.Quaternion().setFromEuler(E); };

  function update(av, dt, ctx) {
    dt = clamp(dt, 0, 0.1); const S = av.state; S.t += dt; ctx = ctx || {};
    const speed = Math.max(0, num(ctx.speed)), onGround = ctx.onGround !== false, vy = num(ctx.vy);
    if (onGround && !S.lastGround && S.lastVy < -0.12) S.landT = 1;           // aterrizaje
    S.landT = Math.max(0, S.landT - dt * 4.2); S.lastGround = onGround; S.lastVy = vy;
    let loco = 'idle';
    if (!onGround) loco = vy > 0.02 ? 'jump' : 'fall'; else if (speed > 0.6) loco = 'move';
    S.loco = loco;
    const run = clamp((speed - 6) / 12, 0, 1.5);                              // 0 = caminar, ~0.65 = velocidad normal, 1+ = sprint
    if (loco === 'move') S.phase += dt * clamp(6 + speed * 0.75, 8, 24) * (ctx.reverse ? -1 : 1);

    // — pose base —
    const anim = av.layers.anim, animDef = anim && EMOTES[anim.name], held = !!(animDef && animDef.base);
    let base;
    if (held) base = animDef.fn((S.t - anim.t0) * (anim.speed || 1), anim.dur || 1);
    else if (loco === 'jump') base = poseJump(vy); else if (loco === 'fall') base = poseFall(S.t);
    else if (loco === 'move') base = poseLocomotion(S.phase, run, ctx); else base = poseIdle(S.t, ctx);
    av.target = {};
    for (const n of BONE_NAMES) if (base[n]) blendInto(av, n, eulerQ(base[n]), 1);
    let y = base._y || 0;
    if (S.landT > 0.01 && !held && loco !== 'fall' && loco !== 'jump') {      // amortiguación al aterrizar
      const lp = poseLand(S.landT * S.landT), m = clamp(1 - speed * 0.04, 0.4, 1), w = clamp(S.landT * 1.4, 0, 1) * m;
      for (const n of BONE_NAMES) if (lp[n]) blendInto(av, n, eulerQ(lp[n]), w);
      y += (lp._y || 0) * m;
    }

    // — gestos: capa superior con fundido de entrada/salida —
    let faceHint = null, talk = 0; const em = av.layers.emote;
    if (em) {
      const def = EMOTES[em.name], el = S.t - em.t0, dur = em.dur || def.dur || 1.4;
      if (!def.loop && el > dur) av.layers.emote = null;
      else {
        const w = clamp(el / 0.18, 0, 1) * (def.loop ? 1 : clamp((dur - el) / 0.2, 0, 1)), pp = def.fn(el * (em.speed || 1), dur);
        const moving = loco === 'move';
        for (const n of Object.keys(pp)) { if (!BONE_SET.has(n)) continue; if (moving && (LEGS.test(n) || n === 'Hips')) continue; blendInto(av, n, eulerQ(pp[n]), w); }
        if (pp._y && !moving) y += pp._y * w;
        if (pp._face) faceHint = pp._face; if (pp._talk) talk = pp._talk;
      }
    }

    // — overrides de script: cada hueso puede reemplazar (set) o sumarse (add) a lo anterior, con peso y transición —
    for (const name of Object.keys(av.layers.over)) {
      const o = av.layers.over[name]; if (!o || !o.rot) continue;
      if (o.dur > 0 && o.k < 1) o.k = clamp(o.k + dt / o.dur, 0, 1);
      const k = o.dur > 0 ? o.k : 1, e = k * k * (3 - 2 * k);
      const rr = [smooth(o.fromRot[0], o.rot[0], e), smooth(o.fromRot[1], o.rot[1], e), smooth(o.fromRot[2], o.rot[2], e)];
      if (o.mode === 'add') addInto(av, name, eulerQ(rr), o.w); else blendInto(av, name, eulerQ(rr), o.w);
    }

    // — aplicar a los huesos (suavizado exponencial → transiciones fluidas entre cualquier par de poses) —
    const lerpK = 1 - Math.exp(-dt * (ctx.snap ? 200 : 18));
    for (const n of BONE_NAMES) {
      const b = av.bones[n], P = av.pose[n], T = av.target[n], o = av.layers.over[n], rp = b.userData.rest.p;
      P.q.slerp(T && T.has ? T.q : IDENT, lerpK);
      b.quaternion.copy(b.userData.rest.q).multiply(P.q);
      if (o && o.pos) b.position.set(rp.x + o.pos[0], rp.y + o.pos[1], rp.z + o.pos[2]); else if (b.position.x !== rp.x || b.position.y !== rp.y || b.position.z !== rp.z) b.position.copy(rp);
      if (o && o.scl) b.scale.set(o.scl[0], o.scl[1], o.scl[2]); else if (b.scale.x !== 1 || b.scale.y !== 1 || b.scale.z !== 1) b.scale.set(1, 1, 1);
    }
    S._y = S._y === undefined ? y : S._y + (y - S._y) * (1 - Math.exp(-dt * 14));
    av.bones.Hips.position.y += S._y;
    updateFace(av, dt, faceHint, talk, ctx);
  }

  function updateFace(av, dt, hint, talk, ctx) {
    const S = av.state, f = av.face, cur = f.cur; S.faceT += dt;
    let name = av.layers.face || hint || (av.layers.anim && EMOTES[av.layers.anim.name] && EMOTES[av.layers.anim.name].fn(0, 1)._face) || (S.loco === 'fall' ? 'scared' : S.face);
    if (!FACE_PRESETS[name]) name = 'neutral';
    const pr = FACE_PRESETS[name], k = 1 - Math.exp(-dt * 12);
    let open = pr.open;
    if (talk || av.layers.talk || name === 'talk') { open = 0.15 + Math.abs(sin(S.t * 14)) * 0.35 * Math.max(talk, av.layers.talk ? 1 : 0, name === 'talk' ? 1 : 0); }
    cur.open += (open - cur.open) * k; cur.curve += (pr.curve - cur.curve) * k; cur.width += (pr.width - cur.width) * k;
    cur.browA += (pr.browA - cur.browA) * k; cur.browY += (pr.browY - cur.browY) * k; cur.lid += (pr.lid - cur.lid) * k; cur.blushA += (pr.blushA - cur.blushA) * k;
    // parpadeo
    S.blinkT -= dt; if (S.blinkT <= 0) { S.blink = 1; S.blinkT = 2 + Math.random() * 4; }
    if (S.blink > 0) S.blink = Math.max(0, S.blink - dt * 7);
    const blinkK = Math.sin(S.blink * Math.PI);
    // mirada (hacia dirección de movimiento si se indica)
    const lx = clamp(num(ctx && ctx.lookX), -1, 1) * 0.04, ly = clamp(num(ctx && ctx.lookY), -1, 1) * 0.03;
    for (const s of ['L', 'R']) {
      const e = f.eyes[s], sx = s === 'L' ? -1 : 1;
      const closeAmt = clamp(Math.max(blinkK, cur.lid, name === 'wink' && s === 'R' ? 1 : 0, name === 'dead' ? 1 : 0), 0, 1);
      e.bone.scale.set(1, Math.max(0.08, 1 - closeAmt * 0.92 + Math.max(0, -cur.lid) * 0.25), 1);
      e.pupil.position.x = lx; e.pupil.position.y = ly; e.glint.position.x = 0.025 + lx; e.glint.position.y = 0.03 + ly;
      f.brows[s].position.y = 0.60 + cur.browY + (name === 'wink' && s === 'R' ? -0.03 : 0); f.brows[s].rotation.z = Math.PI / 2 + sx * cur.browA * 0.55;   // browA > 0 (enojo): extremo interior hacia abajo
      av.parts['blush' + s].material.opacity = 0.45 * clamp(cur.blushA * 2, 0, 1);
    }
    if (Math.abs(cur.open - (f._lo ?? -1)) > 0.01 || Math.abs(cur.curve - (f._lc ?? -9)) > 0.01 || Math.abs(cur.width - (f._lw ?? -1)) > 0.003) { f._lo = cur.open; f._lc = cur.curve; f._lw = cur.width; updateMouth(av); }
  }

  // ── API de control (la usan scripts, servidor y editor) ─────────────────────────────────────
  function playAnimation(av, name, opts) {
    const n = resolveAnim(name); if (!n) return false; opts = opts || {};
    const def = EMOTES[n], layer = { name: n, t0: av.state.t, speed: num(opts.speed, 1) || 1, dur: def.dur };
    if (opts.loop === false && def.loop && !def.base) layer.dur = clamp(num(opts.duration, 2), 0.2, 30);   // gesto cíclico que se corta solo
    if (def.base) av.layers.anim = layer; else av.layers.emote = layer;
    return true;
  }
  function stopAnimation(av, name) {
    if (!name) { av.layers.anim = null; av.layers.emote = null; return; }
    const n = resolveAnim(name); if (av.layers.anim && av.layers.anim.name === n) av.layers.anim = null; if (av.layers.emote && av.layers.emote.name === n) av.layers.emote = null;
  }
  // Rotación en GRADOS. mode 'set' (por defecto: reemplaza la animación en ese hueso) o 'add' (se suma a ella).
  // Acepta { rotation|rot, position|offset, scale, weight, mode, duration, visible, color, reset }.
  function setBone(av, bone, rawProps) {
    const n = resolveBone(bone); if (!n || n === 'Root') return false;
    const props = sanitizeBoneProps(rawProps); if (!props) return false;
    if (props.reset) { resetBone(av, n); if (Object.keys(props).length === 1) return true; }
    const o = av.layers.over[n] || (av.layers.over[n] = { rot: null, pos: null, scl: null, w: 1, mode: 'set', k: 1, dur: 0, fromRot: [0, 0, 0] });
    if (props.rot) { o.fromRot = o.rot ? o.rot.slice() : [0, 0, 0]; o.rot = props.rot.map(v => v * DEG); o.dur = props.duration || 0; o.k = o.dur > 0 ? 0 : 1; }
    if (props.pos) o.pos = props.pos;
    if (props.scale) o.scl = props.scale;
    if (props.weight !== undefined) o.w = props.weight;
    if (props.mode) o.mode = props.mode;
    if (props.visible !== undefined) av.visuals[n].visible = props.visible;
    if (props.color) setBoneColor(av, n, props.color);
    return true;
  }
  function setBoneColor(av, n, color) {
    const c = normalizeHex(color, null); if (!c) return;
    av.visuals[n].traverse(m => { if (m.isMesh && m.userData.tag === 'body') { if (!m.userData.ownMat) { m.material = m.material.clone(); m.userData.ownMat = true; } m.material.color.set(c); } });
  }
  function resetBone(av, n) {
    if (n) { delete av.layers.over[n]; av.visuals[n].visible = true; av.visuals[n].traverse(m => { if (m.isMesh && m.userData.ownMat) { m.userData.ownMat = false; } }); return; }
    av.layers.over = {}; for (const b of BONE_NAMES) av.visuals[b].visible = true;
    av.style = null; applyLook(av, av.look); // restablece materiales por hueso
  }
  function setLook(av, look) { applyLook(av, look); }
  function setFace(av, name, talk) { if (name === null || name === undefined || name === 'auto') av.layers.face = null; else if (FACE_PRESETS[name]) av.layers.face = name; if (talk !== undefined) av.layers.talk = !!talk; }

  // ── Accesorios pegados a un hueso (espada, sombrero, mochila…) — solo visuales, sin colisión ──
  const ACC_SHAPES = { box: () => new THREE.BoxGeometry(1, 1, 1), sphere: () => new THREE.SphereGeometry(0.5, 14, 10), cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 14), cone: () => new THREE.ConeGeometry(0.5, 1, 14), capsule: () => capsuleGeo(0.5, 0.0001, 10) };
  function addAccessory(av, id, bone, rawSpec) {
    id = accId(id); const sp = sanitizeAccessory(bone, rawSpec); if (!id || !sp) return false;
    removeAccessory(av, id); if (Object.keys(av.accessories).length >= MAX_ACCESSORIES) return false;
    const mat = new THREE.MeshPhongMaterial({ color: new THREE.Color(sp.color), shininess: 40, transparent: sp.opacity !== undefined && sp.opacity < 1, opacity: sp.opacity !== undefined ? sp.opacity : 1 });
    if (sp.emissive) mat.emissive = new THREE.Color(sp.emissive);
    const m = new THREE.Mesh(G('acc_' + sp.shape, ACC_SHAPES[sp.shape]), mat); m.castShadow = true; m.userData.tag = 'acc';
    m.scale.set(sp.size[0], sp.size[1], sp.size[2]); m.position.set(sp.offset[0], sp.offset[1], sp.offset[2]); m.rotation.set(sp.rotation[0] * DEG, sp.rotation[1] * DEG, sp.rotation[2] * DEG);
    av.visuals[sp.bone].add(m); av.accessories[id] = { mesh: m, bone: sp.bone }; return true;
  }
  function removeAccessory(av, id) { const a = av.accessories[id]; if (!a) return false; a.mesh.parent && a.mesh.parent.remove(a.mesh); a.mesh.material.dispose(); delete av.accessories[id]; return true; }

  // ── Estado serializable (para replicar por red y para jugadores que entran tarde) ────────────
  // Estructura: { look?, anim?, emote?, face?, talk?, bones?: {Name: {rot,pos,scale,weight,mode,visible,color}}, acc?: {id: {bone,...spec}} }
  function applyState(av, st) {
    if (!st || typeof st !== 'object') return;
    if (st.look) setLook(av, st.look);
    if (st.hold !== undefined) av.hold = !!st.hold;
    if (st.reset) { stopAnimation(av); av.layers.face = null; av.layers.talk = false; av.hold = false; for (const id of Object.keys(av.accessories)) removeAccessory(av, id); resetBone(av); }
    if (st.stop) stopAnimation(av, st.stop === true ? null : st.stop);
    if (st.anim) playAnimation(av, st.anim.name, st.anim);
    if (st.face !== undefined) setFace(av, st.face, st.talk);
    if (st.bones) for (const k of Object.keys(st.bones)) setBone(av, k, st.bones[k]);
    if (st.acc) for (const id of Object.keys(st.acc)) { const a = st.acc[id]; if (a === null) removeAccessory(av, id); else addAccessory(av, id, a.bone, a); }
  }

  function dispose(av) { av.root.traverse(o => { if (o.isMesh) { if (o.userData.ownMat || o.userData.tag === 'acc') o.material.dispose(); } }); }

  global.CrixAvatar = Object.assign({}, Shared, { ANIMATIONS: Object.keys(EMOTES),
    build: buildAvatar, update, applyLook, setUserColor, setLook, playAnimation, stopAnimation, setBone, resetBone, setFace, addAccessory, removeAccessory, applyState, dispose, capsuleGeo, roundedBoxGeo });
  global.CrixAvatarShared = Shared;
})(typeof window !== 'undefined' ? window : globalThis);
