'use strict';
// CrixObjects — catálogo de clases y propiedades estilo Roblox Studio (los nombres pueden variar; ver `es`).
// Todo lo que está acá es DATOS + esquema para el inspector. El comportamiento lo escriben los scripts:
// ningún objeto trae IA, vida ni reglas propias (un Humanoid es un contenedor de valores; un NPC es un Model).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./crix-joints.js'));
  else root.CrixObjects = factory(root.CrixJoints);
})(typeof self !== 'undefined' ? self : this, function (CrixJoints) {
  const MATERIALS = ['SmoothPlastic', 'Plastic', 'Brick', 'Wood', 'WoodPlanks', 'Metal', 'DiamondPlate', 'Neon', 'Glass', 'Ice', 'Grass', 'Sand', 'Concrete', 'Rock', 'Marble', 'Cobblestone', 'Fabric'];
  const SHAPES = ['Block', 'Sphere', 'Cylinder', 'Wedge', 'TrussPart'];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

  // ── Propiedades de las piezas (BasePart) ─────────────────────────────────
  // t: bool | num | int | str | color | enum | strlist | attrs ; group: sección del inspector
  const PART_PROPS = [
    { k: 'type', label: 'Shape', t: 'enum', opts: SHAPES, group: 'Apariencia', rebuild: true, hint: 'Forma de la pieza' },
    { k: 'reflectance', label: 'Reflectance', t: 'num', min: 0, max: 1, step: 0.05, def: 0, group: 'Apariencia', hint: 'Brillo especular (0–1)' },
    { k: 'castShadow', label: 'CastShadow', t: 'bool', def: true, group: 'Apariencia' },
    { k: 'canCollide', label: 'CanCollide', t: 'bool', def: true, group: 'Colisión' },
    { k: 'canTouch', label: 'CanTouch', t: 'bool', def: true, group: 'Colisión', hint: 'Si es false no dispara onTouched' },
    { k: 'canQuery', label: 'CanQuery', t: 'bool', def: true, group: 'Colisión', hint: 'Si es false los raycast la atraviesan' },
    { k: 'collisionGroup', label: 'CollisionGroup', t: 'str', def: 'Default', max: 40, group: 'Colisión', hint: 'Dos piezas del mismo grupo (distinto de Default) no chocan entre sí en cuerdas/resortes' },
    { k: 'density', label: 'Density', t: 'num', min: 0.01, max: 100, step: 0.1, def: 0.7, group: 'Física', hint: 'Masa = volumen × densidad (resortes, cuerdas)' },
    { k: 'friction', label: 'Friction', t: 'num', min: 0, max: 1, step: 0.01, group: 'Física', optional: true },
    { k: 'bounce', label: 'Elasticity', t: 'num', min: 0, max: 1, step: 0.01, group: 'Física', optional: true },
    { k: 'drag', label: 'Drag', t: 'num', min: 0, max: 1, step: 0.001, group: 'Física', optional: true },
    { k: 'gravityScale', label: 'GravityScale', t: 'num', min: -5, max: 5, step: 0.1, group: 'Física', optional: true },
    { k: 'massless', label: 'Massless', t: 'bool', def: false, group: 'Física', hint: 'Guardada para tus scripts (la física actual no la usa)' },
    { k: 'locked', label: 'Locked', t: 'bool', def: false, group: 'Editor', hint: 'No se puede seleccionar con el visor 3D' },
    { k: 'tags', label: 'Tags', t: 'strlist', group: 'Datos', hint: 'Separadas por coma · game.getPartsByTag()' },
    { k: 'attributes', label: 'Attributes', t: 'attrs', group: 'Datos', hint: 'clave=valor por línea · game.getAttribute(id, clave)' },
  ];

  // ── Esquemas de otras clases ────────────────────────────────────────────
  const AXES = ['x', 'y', 'z'];
  const cfFields = (k, label) => ({ k, label, t: 'cf', group: 'Unión', hint: 'Desplazamiento (studs) y rotación (grados) respecto de la pieza' });
  const jointCommon = [
    { k: 'name', label: 'Name', t: 'str', max: 80, group: 'Datos' },
    { k: 'enabled', label: 'Enabled', t: 'bool', def: true, group: 'Datos' },
    { k: 'part0', label: 'Part0', t: 'part', group: 'Unión' },
    { k: 'part1', label: 'Part1', t: 'part', group: 'Unión', hint: 'La pieza que sigue a Part0' },
  ];
  const drive = (angle) => [
    { k: 'axis', label: 'Axis', t: 'enum', opts: AXES, group: 'Movimiento' },
    { k: 'mode', label: 'ActuatorType', t: 'enum', opts: ['none', 'servo', 'velocity'], group: 'Movimiento', hint: 'none = libre · servo = va a un objetivo · velocity = gira sin parar' },
    angle ? { k: 'targetAngle', label: 'TargetAngle (rad)', t: 'num', step: 0.1, group: 'Movimiento' } : { k: 'targetPosition', label: 'TargetPosition', t: 'num', step: 0.5, group: 'Movimiento' },
    angle ? { k: 'angularVelocity', label: 'AngularVelocity (rad/s)', t: 'num', step: 0.5, group: 'Movimiento' } : { k: 'velocity', label: 'Velocity (studs/s)', t: 'num', step: 0.5, group: 'Movimiento' },
    { k: 'maxVelocity', label: 'MaxVelocity', t: 'num', min: 0, step: 0.5, group: 'Movimiento' },
    { k: 'limitsEnabled', label: 'LimitsEnabled', t: 'bool', group: 'Límites' },
    angle ? { k: 'minAngle', label: 'LowerAngle (rad)', t: 'num', step: 0.1, group: 'Límites' } : { k: 'minPosition', label: 'LowerLimit', t: 'num', step: 0.5, group: 'Límites' },
    angle ? { k: 'maxAngle', label: 'UpperAngle (rad)', t: 'num', step: 0.1, group: 'Límites' } : { k: 'maxPosition', label: 'UpperLimit', t: 'num', step: 0.5, group: 'Límites' },
  ];
  const JOINT_PROPS = {
    Weld: [...jointCommon, cfFields('c0', 'C0'), cfFields('c1', 'C1')],
    WeldConstraint: [...jointCommon],
    Motor6D: [...jointCommon, cfFields('c0', 'C0'), cfFields('c1', 'C1'), cfFields('transform', 'Transform'), ...drive(true)],
    Hinge: [...jointCommon, cfFields('c0', 'Attachment0'), cfFields('c1', 'Attachment1'), ...drive(true), { k: 'damping', label: 'Damping (libre)', t: 'num', min: 0, step: 0.1, group: 'Movimiento' }],
    Prismatic: [...jointCommon, cfFields('c0', 'Attachment0'), cfFields('c1', 'Attachment1'), ...drive(false)],
    BallSocket: [...jointCommon, cfFields('c0', 'Attachment0'), cfFields('c1', 'Attachment1')],
    Rod: [...jointCommon, cfFields('c0', 'Attachment0'), cfFields('c1', 'Attachment1'), { k: 'length', label: 'Length', t: 'num', min: 0.01, step: 0.5, group: 'Movimiento' }],
    Rope: [...jointCommon, cfFields('c0', 'Attachment0'), cfFields('c1', 'Attachment1'), { k: 'length', label: 'Length', t: 'num', min: 0.01, step: 0.5, group: 'Movimiento' }],
    Spring: [...jointCommon, cfFields('c0', 'Attachment0'), cfFields('c1', 'Attachment1'), { k: 'freeLength', label: 'FreeLength', t: 'num', min: 0, step: 0.5, group: 'Movimiento' }, { k: 'stiffness', label: 'Stiffness', t: 'num', min: 0, step: 5, group: 'Movimiento' }, { k: 'damping', label: 'Damping', t: 'num', min: 0, step: 0.5, group: 'Movimiento' }, { k: 'maxForce', label: 'MaxForce', t: 'num', min: 0, step: 100, group: 'Movimiento' }],
  };

  const nameProp = { k: 'name', label: 'Name', t: 'str', max: 80, group: 'Datos' };
  const lightProps = (spot) => [nameProp, { k: 'enabled', label: 'Enabled', t: 'bool', def: true, group: 'Luz' }, { k: 'color', label: 'Color', t: 'color', def: '#ffffff', group: 'Luz' }, { k: 'brightness', label: 'Brightness', t: 'num', min: 0, max: 20, step: 0.1, def: 1, group: 'Luz' }, { k: 'range', label: 'Range (studs)', t: 'num', min: 1, max: 200, step: 1, def: 16, group: 'Luz' }].concat(spot ? [{ k: 'angle', label: 'Angle (°)', t: 'num', min: 5, max: 120, step: 5, def: 45, group: 'Luz' }] : []);
  const emitterProps = [nameProp, { k: 'enabled', label: 'Enabled', t: 'bool', def: true, group: 'Emisor' }, { k: 'rate', label: 'Rate (por s)', t: 'num', min: 0, max: 100, step: 1, def: 20, group: 'Emisor' }, { k: 'lifetime', label: 'Lifetime (s)', t: 'num', min: 0.1, max: 10, step: 0.1, def: 1.5, group: 'Emisor' }, { k: 'speed', label: 'Speed', t: 'num', min: 0, max: 50, step: 0.5, def: 4, group: 'Emisor' }, { k: 'spread', label: 'SpreadAngle (°)', t: 'num', min: 0, max: 180, step: 5, def: 25, group: 'Emisor' }, { k: 'size', label: 'Size', t: 'num', min: 0.05, max: 10, step: 0.05, def: 0.5, group: 'Emisor' }, { k: 'color', label: 'Color', t: 'color', def: '#ffaa33', group: 'Emisor' }, { k: 'color2', label: 'Color final', t: 'color', def: '#ff3300', group: 'Emisor' }, { k: 'acceleration', label: 'Acceleration Y', t: 'num', min: -50, max: 50, step: 0.5, def: 2, group: 'Emisor' }];

  const INSTANCE_PROPS = {
    Folder: [nameProp],
    Model: [nameProp, { k: 'primaryPart', label: 'PrimaryPart', t: 'part', group: 'Model', hint: 'Pieza de referencia del modelo' }],
    Humanoid: [nameProp, { k: 'displayName', label: 'DisplayName', t: 'str', max: 40, group: 'Humanoid' }, { k: 'health', label: 'Health', t: 'num', min: 0, step: 1, def: 100, group: 'Humanoid' }, { k: 'maxHealth', label: 'MaxHealth', t: 'num', min: 0, step: 1, def: 100, group: 'Humanoid' }, { k: 'walkSpeed', label: 'WalkSpeed', t: 'num', min: 0, step: 1, def: 16, group: 'Humanoid' }, { k: 'jumpPower', label: 'JumpPower', t: 'num', min: 0, step: 1, def: 50, group: 'Humanoid' }, { k: 'hipHeight', label: 'HipHeight', t: 'num', min: 0, step: 0.1, def: 2, group: 'Humanoid' }],
    Attachment: [nameProp, { k: 'x', label: 'Position X', t: 'num', step: 0.25, def: 0, group: 'Attachment' }, { k: 'y', label: 'Position Y', t: 'num', step: 0.25, def: 0, group: 'Attachment' }, { k: 'z', label: 'Position Z', t: 'num', step: 0.25, def: 0, group: 'Attachment' }],
    PointLight: lightProps(false),
    SpotLight: lightProps(true),
    SurfaceLight: lightProps(true),
    ParticleEmitter: emitterProps,
    Fire: emitterProps,
    Smoke: emitterProps,
    Sparkles: emitterProps,
  };
  const EMITTER_PRESETS = {
    ParticleEmitter: {},
    Fire: { rate: 40, lifetime: 0.9, speed: 2.5, spread: 20, size: 0.6, color: '#ffcc33', color2: '#ff3300', acceleration: 4 },
    Smoke: { rate: 12, lifetime: 3, speed: 2, spread: 25, size: 1.2, color: '#999999', color2: '#333333', acceleration: 1 },
    Sparkles: { rate: 25, lifetime: 1.2, speed: 5, spread: 180, size: 0.2, color: '#ffee88', color2: '#ffffff', acceleration: -4 },
  };

  // Catálogo para el menú «Objetos». `needs`: 'part' = requiere una pieza seleccionada como padre/Part0.
  const CATALOG = [
    { cat: 'Organización', items: [{ cls: 'Model', icon: '🗂', es: 'Model (agrupa piezas)' }, { cls: 'Folder', icon: '📁', es: 'Folder' }, { cls: 'Humanoid', icon: '🧍', es: 'Humanoid (datos)', needs: 'model' }, { cls: 'Attachment', icon: '📍', es: 'Attachment', needs: 'part' }] },
    { cat: 'Uniones', items: [{ cls: 'Weld', icon: '🔗', es: 'Weld (soldadura con offsets)', needs: 'part' }, { cls: 'WeldConstraint', icon: '🧷', es: 'WeldConstraint', needs: 'part' }, { cls: 'Motor6D', icon: '⚙', es: 'Motor6D (articulación animable)', needs: 'part' }, { cls: 'Hinge', icon: '🚪', es: 'HingeConstraint (bisagra)', needs: 'part' }, { cls: 'BallSocket', icon: '⚽', es: 'BallSocketConstraint (rótula)', needs: 'part' }, { cls: 'Prismatic', icon: '↔', es: 'PrismaticConstraint (riel)', needs: 'part' }, { cls: 'Rod', icon: '📏', es: 'RodConstraint (varilla)', needs: 'part' }, { cls: 'Rope', icon: '🪢', es: 'RopeConstraint (cuerda)', needs: 'part' }, { cls: 'Spring', icon: '🌀', es: 'SpringConstraint (resorte)', needs: 'part' }] },
    { cat: 'Luces', items: [{ cls: 'PointLight', icon: '💡', es: 'PointLight', needs: 'part' }, { cls: 'SpotLight', icon: '🔦', es: 'SpotLight', needs: 'part' }, { cls: 'SurfaceLight', icon: '🖥', es: 'SurfaceLight', needs: 'part' }] },
    { cat: 'Efectos', items: [{ cls: 'ParticleEmitter', icon: '✨', es: 'ParticleEmitter', needs: 'part' }, { cls: 'Fire', icon: '🔥', es: 'Fire', needs: 'part' }, { cls: 'Smoke', icon: '💨', es: 'Smoke', needs: 'part' }, { cls: 'Sparkles', icon: '🎇', es: 'Sparkles', needs: 'part' }] },
  ];
  const ICONS = { Model: '🗂', Folder: '📁', Humanoid: '🧍', Attachment: '📍', Weld: '🔗', WeldConstraint: '🧷', Motor6D: '⚙', Hinge: '🚪', BallSocket: '⚽', Prismatic: '↔', Rod: '📏', Rope: '🪢', Spring: '🌀', PointLight: '💡', SpotLight: '🔦', SurfaceLight: '🖥', ParticleEmitter: '✨', Fire: '🔥', Smoke: '💨', Sparkles: '🎇' };
  const isJoint = cls => CrixJoints.CLASSES.includes(cls);

  function instanceDefaults(cls) {
    const out = {};
    for (const p of INSTANCE_PROPS[cls] || []) if (p.def !== undefined) out[p.k] = p.def;
    Object.assign(out, EMITTER_PRESETS[cls] || {});
    if (cls === 'Humanoid') out.displayName = '';
    return out;
  }
  // Valida una instancia no-unión: { id, class, name, parent, props }.
  function sanitizeInstance(src, fallbackId) {
    const s = src && typeof src === 'object' ? src : {};
    const cls = INSTANCE_PROPS[s.class] ? s.class : 'Folder';
    const props = { ...instanceDefaults(cls) };
    const given = s.props && typeof s.props === 'object' ? s.props : {};
    for (const p of INSTANCE_PROPS[cls]) {
      if (p.k === 'name' || given[p.k] === undefined) continue;
      const v = given[p.k];
      if (p.t === 'num') props[p.k] = clamp(num(v, p.def || 0), p.min === undefined ? -1e6 : p.min, p.max === undefined ? 1e6 : p.max);
      else if (p.t === 'bool') props[p.k] = v !== false;
      else if (p.t === 'color') props[p.k] = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v)) ? String(v) : (p.def || '#ffffff');
      else props[p.k] = String(v).slice(0, p.max || 120);
    }
    return { id: String(s.id || fallbackId || 'i' + Math.random().toString(36).slice(2, 9)).slice(0, 120), class: cls, name: String(s.name || cls).slice(0, 80), parent: String(s.parent || '').slice(0, 120), props };
  }

  // ── NPC = el MISMO cuerpo que el jugador, como Model + piezas + Motor6D (sin ningún comportamiento) ──
  // Esqueleto de 25 huesos de crix-avatar.js (mismas posiciones, escala BASE_SCALE y jerarquía). Las 16 piezas del cuerpo usan la malla
  // REAL del avatar (propiedad avatarMesh = nombre del hueso; el cliente la toma de crix-avatar.glb). Ojos y boca son piezas simples y
  // los huesos sin malla (Neck, Jaw, ShoulderL/R, ToesL/R) son piezas invisibles. Todas las piezas se centran en su articulación, así
  // c1 = 0 y c0 = posición local del hueso. Devuelve { parts, joints, instances, rootId, modelId }. y = centro de la HumanoidRootPart.
  const RIG_SCALE = 0.83, RIG_ROOT_Y = 1.525, RIG_CLAY = '#dcdad6';
  const RIG_HEAD = { c: [0, 0.515, 0.047], R: 0.614 };
  const rigHeadPoint = (yaw, pitch) => [RIG_HEAD.c[0] + RIG_HEAD.R * Math.sin(yaw) * Math.cos(pitch), RIG_HEAD.c[1] + RIG_HEAD.R * Math.sin(pitch), RIG_HEAD.c[2] + RIG_HEAD.R * Math.cos(yaw) * Math.cos(pitch)];
  // [hueso, padre, posición local (unidades del rig), forma, tamaño aprox. (studs), eje del Motor6D, visible]
  const RIG_BONES = [
    ['Hips', 'Root', [0, 1.27, 0], 'Block', [0.9, 0.5, 0.7], 'y', 1], ['Spine', 'Hips', [0, 0.32, 0], 'Block', [0.8, 0.5, 0.6], 'y', 1],
    ['Chest', 'Spine', [0, 0.405, 0], 'Block', [0.9, 0.7, 0.65], 'y', 1], ['Neck', 'Chest', [0, 0.548, 0], 'Block', [0.2, 0.2, 0.2], 'y', 0],
    ['Head', 'Neck', [0, 0, 0], 'Block', [1.0, 1.0, 1.0], 'y', 1], ['Jaw', 'Head', [0, 0.18, 0.46], 'Block', [0.2, 0.1, 0.2], 'x', 0],
    ['Teeth', 'Head', rigHeadPoint(0, -0.38), 'Block', [0.25, 0.04, 0.04], 'x', 2],
    ['EyeL', 'Head', rigHeadPoint(-0.58, 0.42), 'Sphere', [0.13, 0.13, 0.13], 'y', 2], ['EyeR', 'Head', rigHeadPoint(0.58, 0.42), 'Sphere', [0.13, 0.13, 0.13], 'y', 2],
  ];
  for (const [L, sg] of [['L', -1], ['R', 1]]) RIG_BONES.push(
    ['Shoulder' + L, 'Chest', [sg * 0.31, 0.294, 0], 'Block', [0.2, 0.2, 0.2], 'z', 0],
    ['UpperArm' + L, 'Shoulder' + L, [sg * 0.29, 0, 0], 'Block', [0.3, 0.55, 0.3], 'x', 1], ['LowerArm' + L, 'UpperArm' + L, [0, -0.634, 0], 'Block', [0.28, 0.5, 0.28], 'x', 1],
    ['Hand' + L, 'LowerArm' + L, [0, -0.52, 0], 'Block', [0.25, 0.35, 0.25], 'x', 1],
    ['UpperLeg' + L, 'Hips', [sg * 0.275, 0.158, 0], 'Block', [0.4, 0.6, 0.4], 'x', 1], ['LowerLeg' + L, 'UpperLeg' + L, [0, -0.618, 0], 'Block', [0.35, 0.55, 0.35], 'x', 1],
    ['Foot' + L, 'LowerLeg' + L, [0, -0.481, 0], 'Block', [0.35, 0.3, 0.55], 'x', 1], ['Toes' + L, 'Foot' + L, [0, -0.2, 0.3], 'Block', [0.2, 0.1, 0.2], 'x', 0]);

  function buildHumanoidRig(o = {}) {
    const uid = String(o.id || Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36));
    const name = String(o.name || 'Rig').slice(0, 60), ry = num(o.ry, 0);
    const bx = num(o.x), by = num(o.y, RIG_ROOT_Y), bz = num(o.z);
    const body = /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : RIG_CLAY, dark = '#1b1f2a';
    const modelId = 'm' + uid, rootId = 'p' + uid + 'r';
    const cos = Math.cos(ry), sin = Math.sin(ry);
    // coordenadas con el origen en los pies → mundo
    const at = c => ({ x: bx + c[0] * cos + c[2] * sin, y: by + c[1] - RIG_ROOT_Y, z: bz - c[0] * sin + c[2] * cos });
    const P = bone => 'p' + uid + bone;
    const mk = (id, nm, type, c, size, color, extra) => Object.assign({ id, type, name: nm, ...at(c), sx: size[0], sy: size[1], sz: size[2], rx: 0, ry, rz: 0, color, material: 'SmoothPlastic', anchored: true, canCollide: false, transparent: 0, castShadow: true, parent: modelId }, extra || {});
    const ROOT_C = [0, RIG_ROOT_Y, 0];
    const parts = [mk(rootId, 'HumanoidRootPart', 'Block', ROOT_C, [1.2, 3.05, 0.8], '#ffffff', { transparent: 1, canCollide: true, anchored: o.anchored === true, castShadow: false })];
    const abs = { Root: ROOT_C }, joints = [];
    for (const [bone, parent, lp, type, size, axis, vis] of RIG_BONES) {
      const pa = abs[parent], c = [pa[0] + lp[0] * RIG_SCALE, pa[1] + lp[1] * RIG_SCALE - (parent === 'Root' ? RIG_ROOT_Y : 0), pa[2] + lp[2] * RIG_SCALE];
      abs[bone] = parent === 'Root' ? [c[0], c[1] + RIG_ROOT_Y * 0 + 0, c[2]] : c;
    }
    // Hips: la raíz está en y=RIG_ROOT_Y pero lp[1] se mide desde los pies
    abs.Hips = [0, 1.27 * RIG_SCALE, 0];
    for (const [bone, parent, lp, type, size, axis, vis] of RIG_BONES) {
      if (bone === 'Hips') continue;
      const pa = abs[parent]; abs[bone] = [pa[0] + lp[0] * RIG_SCALE, pa[1] + lp[1] * RIG_SCALE, pa[2] + lp[2] * RIG_SCALE];
    }
    for (const [bone, parent, lp, type, size, axis, vis] of RIG_BONES) {
      const extra = vis === 1 ? { avatarMesh: bone } : vis === 0 ? { transparent: 1, castShadow: false } : {};
      parts.push(mk(P(bone), bone, type, abs[bone], size, vis === 2 ? dark : body, extra));
      const pa = abs[parent === 'Root' ? 'Root' : parent], c0 = parent === 'Root'
        ? [0, abs.Hips[1] - ROOT_C[1], 0] : [lp[0] * RIG_SCALE, lp[1] * RIG_SCALE, lp[2] * RIG_SCALE];
      joints.push(CrixJoints.sanitize({ id: 'j' + uid + bone, class: 'Motor6D', name: bone, part0: parent === 'Root' ? rootId : P(parent), part1: P(bone), c0: { x: c0[0], y: c0[1], z: c0[2] }, c1: { x: 0, y: 0, z: 0 }, axis, parent: modelId }, 'j' + uid + bone));
    }
    const instances = [
      { id: modelId, class: 'Model', name, parent: '', props: { primaryPart: rootId } },
      { id: 'i' + uid + 'hum', class: 'Humanoid', name: 'Humanoid', parent: modelId, props: { displayName: name, health: 100, maxHealth: 100, walkSpeed: 16, jumpPower: 50, hipHeight: 1.05 } },
    ];
    parts[0].attributes = { Health: 100, MaxHealth: 100, WalkSpeed: 16, JumpPower: 50, DisplayName: name };
    return { parts, joints, instances, rootId, modelId };
  }

  // Valores de la ficha del Humanoid → atributos de la raíz del modelo (así los scripts los leen con getAttribute).
  function humanoidAttributes(props) {
    return { Health: num(props.health, 100), MaxHealth: num(props.maxHealth, 100), WalkSpeed: num(props.walkSpeed, 16), JumpPower: num(props.jumpPower, 50), HipHeight: num(props.hipHeight, 2), DisplayName: String(props.displayName || '') };
  }

  // Datos estáticos de cada Model para game.getModel(): ids de piezas y uniones por nombre + valores del Humanoid.
  function buildModelsInfo(parts, joints, instances) {
    const out = [];
    for (const m of (instances || []).filter(i => i && i.class === 'Model').slice(0, 200)) {
      const info = { id: m.id, name: m.name, root: (m.props && m.props.primaryPart) || '', parts: {}, joints: {}, humanoid: null };
      for (const p of parts || []) if (p && p.parent === m.id && p.name) info.parts[p.name] = p.id;
      for (const j of joints || []) if (j && j.parent === m.id && j.name) info.joints[j.name] = j.id;
      const h = (instances || []).find(i => i && i.class === 'Humanoid' && i.parent === m.id);
      if (h) info.humanoid = humanoidAttributes(h.props || {});
      out.push(info);
    }
    return out;
  }

  // NPC antiguos (pieza con isNPC, IA y vida incorporadas) → Model de partes + Motor6D + Humanoid, sin comportamiento.
  // Determinista: los ids salen del id viejo, así editor, cliente y servidor generan lo mismo.
  function migrateLegacyNpcs(map) {
    const src = map && Array.isArray(map.parts) ? map.parts : [];
    if (!src.some(p => p && p.isNPC)) return { parts: src, joints: (map && map.joints) || [], instances: (map && map.instances) || [], converted: 0 };
    const parts = [], joints = [], instances = []; let converted = 0;
    for (const p of src) {
      if (!p || !p.isNPC) { parts.push(p); continue; }
      converted++;
      const rig = buildHumanoidRig({ id: String(p.id || 'npc' + converted).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60), name: p.name || 'NPC', x: num(p.x), y: num(p.y) + 2, z: num(p.z), ry: num(p.ry), anchored: p.anchored === true });
      const hp = Math.max(0, num(p.maxHp, num(p.hp, 100)));
      const hum = rig.instances.find(i => i.class === 'Humanoid');
      if (hum) { hum.props.maxHealth = hp; hum.props.health = Math.max(0, num(p.hp, hp)); rig.parts[0].attributes = humanoidAttributes(hum.props); }
      parts.push(...rig.parts); joints.push(...rig.joints); instances.push(...rig.instances);
    }
    return { parts, joints: ((map && map.joints) || []).concat(joints), instances: ((map && map.instances) || []).concat(instances), converted };
  }

  return { migrateLegacyNpcs, buildModelsInfo, MATERIALS, SHAPES, PART_PROPS, JOINT_PROPS, INSTANCE_PROPS, EMITTER_PRESETS, CATALOG, ICONS, isJoint, instanceDefaults, sanitizeInstance, buildHumanoidRig, humanoidAttributes };
});
