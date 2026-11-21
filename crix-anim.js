'use strict';
// CrixAnim — motor de animación de Crix (sin dependencias; lo usan el servidor, los scripts y el editor).
//
//  Animación = { id, name, length?, loop?, speed?, layers:[Capa], events:[{t,name,data?}] }
//  Capa      = { id, name, loop?, weight, speed, priority, mode:'override'|'additive', length?, enabled,
//                tracks:[Pista], clips:[Clip], events:[...] }
//
//  PRIORIDADES (como en Roblox, pero por pieza): cada capa tiene `priority` (nombre o número: Core 0 · Idle 1 · Movement 2 ·
//  Action 3 · Action2 4 · Action3 5 · Action4 6; se admite cualquier número). Como cada pista apunta a UNA pieza/unión, una capa
//  con prioridad alta solo manda sobre las piezas/canales que anima; el resto sigue con las capas de menor prioridad.
//  Se resuelve por canal: de mayor a menor prioridad cada capa toma `peso` del hueco que queda y el resto pasa a la siguiente
//  (a igual prioridad manda la capa de más arriba / la animación que empezó después). Las capas 'additive' se suman encima siempre.
//  Pista     = { target, kind:'part'|'joint'|'bone'|'face', sub?, rel:bool, channels:{ canal: [Key] } }
//              part  → una pieza (x,y,z,rx,ry,rz,sx,sy,sz,transparent)       joint → una unión (… y angle)
//              bone  → UN hueso del avatar de un jugador/NPC (rx,ry,rz,x,y,z,sx,sy,sz); target = nombre del hueso
//              face  → UN elemento de la cara (sub): Mouth · EyeL · EyeR · BrowL · BrowR · Expression; target = pieza Head / avatar
//              Nada viene agrupado: cada pieza, unión, hueso y elemento de la cara es una pista suelta que el usuario pone en la capa
//              que quiera y con la prioridad que quiera (cada pista de una capa hereda la prioridad de ESA capa).
//  Key       = { t (s), v, ease, bez?:[x1,y1,x2,y2] }   ← la curva `ease` vale para el tramo que EMPIEZA en esa clave
//  Clip      = { symbol:'<id de otra animación>', start, length?, loop, speed, weight, targets:{interno:externo} }  ← SÍMBOLO (como Adobe Animate)
//
//  · Cada capa tiene su propio reloj y su propio loop: una puede repetirse y otra no.
//  · rx/ry/rz y sx/sy/sz son rotación (radianes) y tamaño por eje; x/y/z posición. `rel:true` = valores relativos a la pose inicial.
//  · No hay límite de capas, pistas, claves, símbolos ni eventos.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CrixAnim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CHANNELS = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz', 'transparent', 'angle'];
  // La cara NO es un bloque: cada elemento es un destino aparte (sub) con sus propios canales. Se pone cada uno en la capa que se quiera.
  const FACE_SUBS = {
    Mouth: ['open', 'curve', 'w', 'tongue', 'teeth', 'talk'],
    EyeL: ['close', 'cover', 'ps', 'big', 'lookX', 'lookY', 'tear'],
    EyeR: ['close', 'cover', 'ps', 'big', 'lookX', 'lookY', 'tear'],
    BrowL: ['angle', 'y'],
    BrowR: ['angle', 'y'],
    Expression: ['emotion'],
  };
  const FACE_DEFAULTS = { open: 0, curve: 0.12, w: 0.15, tongue: 0, teeth: 0, talk: 0, close: 0, cover: 0, ps: 1, big: 0, lookX: 0, lookY: 0, tear: 0, angle: 0, y: 0, emotion: 0 };
  const FACE_EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'sleepy', 'wink', 'smug', 'scared', 'talk', 'dead', 'laugh', 'cry', 'love', 'dizzy', 'hurt', 'yawn', 'tongue', 'evil'];
  const FACE_STEP = ['emotion', 'talk', 'tear', 'teeth'];                       // canales on/off o de índice: claves escalonadas
  const BONE_CHANNELS = ['rx', 'ry', 'rz', 'x', 'y', 'z', 'sx', 'sy', 'sz'];    // huesos del avatar (rotación en radianes, posición = desplazamiento)
  const faceSub = v => Object.prototype.hasOwnProperty.call(FACE_SUBS, v) ? v : 'Mouth';
  const channelsOf = (kind, sub) => kind === 'face' ? FACE_SUBS[faceSub(sub)] : kind === 'bone' ? BONE_CHANNELS : CHANNELS;
  // Nombre del canal dentro del acumulador: los de la cara llevan el elemento delante («EyeL.close») para que cada uno tenga su propia prioridad.
  const chKey = (tr, c) => tr.kind === 'face' ? tr.sub + '.' + c : c;
  const PRIORITIES = { Core: 0, Idle: 1, Movement: 2, Action: 3, Action2: 4, Action3: 5, Action4: 6 };
  const DEFAULT_PRIORITY = PRIORITIES.Action;
  const PRIORITY_NAMES = Object.keys(PRIORITIES);
  // Acepta 'Movement' (sin importar mayúsculas), 'action 2', un número o un {name}; cualquier otra cosa → Action.
  function priorityValue(p, d) {
    if (typeof p === 'number' && Number.isFinite(p)) return p;
    if (typeof p === 'string' && p.trim() !== '') {
      const k = p.trim().replace(/[\s_-]+/g, '').toLowerCase();
      for (const n of PRIORITY_NAMES) if (n.toLowerCase() === k) return PRIORITIES[n];
      const n = Number(p); if (Number.isFinite(n)) return n;
    }
    return d === undefined ? DEFAULT_PRIORITY : d;
  }
  function priorityName(v) { for (const n of PRIORITY_NAMES) if (PRIORITIES[n] === v) return n; return String(v); }
  const MAX_DEPTH = 24;   // solo corta ciclos de símbolos (A contiene a B que contiene a A)
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const clamp01 = t => t < 0 ? 0 : t > 1 ? 1 : t;

  // ── Curvas de transición entre fotogramas clave ──
  const OUT = {
    linear: t => t, step: () => 0,
    quadIn: t => t * t, quadOut: t => 1 - (1 - t) * (1 - t), quadInOut: t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
    cubicIn: t => t * t * t, cubicOut: t => 1 - Math.pow(1 - t, 3), cubicInOut: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
    quartIn: t => t ** 4, quartOut: t => 1 - Math.pow(1 - t, 4), quartInOut: t => t < 0.5 ? 8 * t ** 4 : 1 - Math.pow(-2 * t + 2, 4) / 2,
    sineIn: t => 1 - Math.cos(t * Math.PI / 2), sineOut: t => Math.sin(t * Math.PI / 2), sineInOut: t => 0.5 - Math.cos(Math.PI * t) / 2,
    expoIn: t => t === 0 ? 0 : Math.pow(2, 10 * t - 10), expoOut: t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
    expoInOut: t => t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
    circIn: t => 1 - Math.sqrt(1 - t * t), circOut: t => Math.sqrt(1 - Math.pow(t - 1, 2)),
    backIn: t => { const c = 1.70158; return (c + 1) * t * t * t - c * t * t; },
    backOut: t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
    backInOut: t => { const c = 1.70158 * 1.525; return t < 0.5 ? (Math.pow(2 * t, 2) * ((c + 1) * 2 * t - c)) / 2 : (Math.pow(2 * t - 2, 2) * ((c + 1) * (t * 2 - 2) + c) + 2) / 2; },
    elasticIn: t => t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * (2 * Math.PI / 3)),
    elasticOut: t => t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1,
    bounceOut: t => { const n = 7.5625, d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375; return n * (t -= 2.625 / d) * t + 0.984375; },
  };
  OUT.bounceIn = t => 1 - OUT.bounceOut(1 - t);
  OUT.bounceInOut = t => t < 0.5 ? (1 - OUT.bounceOut(1 - 2 * t)) / 2 : (1 + OUT.bounceOut(2 * t - 1)) / 2;
  OUT.circInOut = t => t < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2;
  OUT.elasticInOut = t => t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * (2 * Math.PI / 4.5))) / 2 : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * (2 * Math.PI / 4.5))) / 2 + 1;
  OUT.sine = OUT.sineInOut; OUT.back = OUT.backOut; OUT.bounce = OUT.bounceOut;   // alias de los tweens viejos
  const EASINGS = Object.keys(OUT).concat(['bezier']);

  // cubic-bezier(x1,y1,x2,y2) como en CSS
  function bezier(x1, y1, x2, y2, t) {
    if (t <= 0) return 0; if (t >= 1) return 1;
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = s => ((ax * s + bx) * s + cx) * s, Y = s => ((ay * s + by) * s + cy) * s, dX = s => (3 * ax * s + 2 * bx) * s + cx;
    let s = t;
    for (let i = 0; i < 8; i++) { const e = X(s) - t; if (Math.abs(e) < 1e-6) return Y(s); const d = dX(s); if (Math.abs(d) < 1e-6) break; s -= e / d; }
    let lo = 0, hi = 1; s = t;
    for (let i = 0; i < 24; i++) { const e = X(s); if (Math.abs(e - t) < 1e-6) break; if (e < t) lo = s; else hi = s; s = (lo + hi) / 2; }
    return Y(s);
  }
  function ease(name, k, bez) {
    if (name === 'bezier' && Array.isArray(bez) && bez.length === 4) return bezier(num(bez[0]), num(bez[1]), num(bez[2]), num(bez[3]), clamp01(k));
    const f = OUT[name] || OUT.linear; return f(clamp01(k));
  }

  // ── Normalización (sin límites de cantidad) ──
  const sid = (v, d) => String(v === undefined || v === null || v === '' ? d : v);
  function sanitizeKeys(keys) {
    const out = [];
    for (const k of Array.isArray(keys) ? keys : []) {
      if (!k || typeof k !== 'object') continue;
      const t = num(k.t, NaN), v = num(k.v, NaN); if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
      const key = { t: Math.max(0, t), v, ease: EASINGS.includes(k.ease) ? k.ease : 'linear' };
      if (key.ease === 'bezier') key.bez = Array.isArray(k.bez) && k.bez.length === 4 ? k.bez.map(n => num(n)) : [0.42, 0, 0.58, 1];
      out.push(key);
    }
    return out.sort((a, b) => a.t - b.t);
  }
  const sanitizeEvents = ev => (Array.isArray(ev) ? ev : []).filter(e => e && Number.isFinite(Number(e.t))).map(e => { const o = { t: Math.max(0, Number(e.t)), name: sid(e.name, 'Evento') }; if (e.data !== undefined) o.data = e.data; return o; }).sort((a, b) => a.t - b.t);
  function sanitizeTrack(src) {
    const kind = src && (src.kind === 'joint' || src.kind === 'face' || src.kind === 'bone') ? src.kind : 'part';
    const t = { target: sid(src && src.target, ''), kind, rel: kind === 'face' ? false : !!(src && src.rel), channels: {} };
    if (kind === 'face') t.sub = faceSub(src && src.sub);
    const ch = src && src.channels && typeof src.channels === 'object' ? src.channels : {};
    for (const c of channelsOf(kind, t.sub)) { const keys = sanitizeKeys(ch[c]); if (keys.length) t.channels[c] = keys; }
    return t;
  }
  function sanitizeClip(src) {
    const c = { symbol: sid(src && src.symbol, ''), start: Math.max(0, num(src && src.start, 0)), loop: !(src && src.loop === false), speed: num(src && src.speed, 1), weight: num(src && src.weight, 1), targets: {} };
    if (src && src.length !== undefined && Number(src.length) > 0) c.length = Number(src.length);
    if (src && src.targets && typeof src.targets === 'object') for (const [k, v] of Object.entries(src.targets)) c.targets[String(k)] = String(v);
    return c;
  }
  function sanitizeLayer(src, i) {
    const l = { id: sid(src && src.id, 'L' + (i + 1)), name: sid(src && src.name, 'Capa ' + (i + 1)), weight: num(src && src.weight, 1), speed: num(src && src.speed, 1), priority: priorityValue(src && src.priority), mode: src && src.mode === 'additive' ? 'additive' : 'override', enabled: !(src && src.enabled === false), tracks: (src && Array.isArray(src.tracks) ? src.tracks : []).map(sanitizeTrack), clips: (src && Array.isArray(src.clips) ? src.clips : []).map(sanitizeClip), events: sanitizeEvents(src && src.events) };
    if (src && typeof src.loop === 'boolean') l.loop = src.loop;
    if (src && src.length !== undefined && Number(src.length) > 0) l.length = Number(src.length);
    return l;
  }
  function sanitize(src) {
    const s = src && typeof src === 'object' ? src : {};
    const a = { id: sid(s.id, 'anim_' + Math.random().toString(36).slice(2, 9)), name: sid(s.name, 'Animación'), loop: s.loop === true, speed: num(s.speed, 1), fps: Math.max(1, num(s.fps, 30)), layers: (Array.isArray(s.layers) ? s.layers : []).map(sanitizeLayer), events: sanitizeEvents(s.events) };
    if (s.length !== undefined && Number(s.length) > 0) a.length = Number(s.length);
    return a;
  }
  function blank(name) { return sanitize({ name: name || 'Animación', layers: [{ name: 'Capa 1' }] }); }

  // ── Duraciones ──
  const libGet = (lib, id) => !lib ? null : typeof lib.get === 'function' ? lib.get(id) : lib[id] || null;
  function layerLength(layer, lib, depth) {
    if (layer.length) return layer.length;
    let m = 0;
    for (const t of layer.tracks) for (const c in t.channels) { const k = t.channels[c]; if (k.length) m = Math.max(m, k[k.length - 1].t); }
    for (const c of layer.clips) { const sym = depth < MAX_DEPTH ? libGet(lib, c.symbol) : null; m = Math.max(m, c.start + (c.length || (sym ? animLength(sym, lib, depth + 1) / Math.max(1e-6, Math.abs(c.speed || 1)) : 0))); }
    for (const e of layer.events) m = Math.max(m, e.t);
    return m;
  }
  function animLength(anim, lib, depth) {
    depth = depth || 0; if (anim.length) return anim.length;
    let m = 0; for (const l of anim.layers) m = Math.max(m, layerLength(l, lib, depth));
    for (const e of anim.events) m = Math.max(m, e.t);
    return m;
  }

  // ── Muestreo ──
  function sampleKeys(keys, t) {
    const n = keys.length; if (!n) return undefined;
    if (t <= keys[0].t) return keys[0].v; if (t >= keys[n - 1].t) return keys[n - 1].v;
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid].t <= t) lo = mid; else hi = mid; }
    const a = keys[lo], b = keys[hi], k = (t - a.t) / Math.max(1e-9, b.t - a.t);
    return a.ease === 'step' ? a.v : a.v + (b.v - a.v) * ease(a.ease, k, a.bez);
  }
  // Acumulador: key `target\u0001kind\u0001channel` → { target, kind, ch, items:[{ rel, v, w, pr, ord }], add }.
  // Las contribuciones se guardan sin mezclar y `resolve` las mezcla por prioridad al final (así una capa puede ganarle a otra aunque
  // se muestree antes). `ord` desempata prioridades iguales: más alto = más arriba.
  function put(acc, target, kind, ch, rel, v, w, additive, pr, ord) {
    const key = target + '\u0001' + kind + '\u0001' + ch; let e = acc[key];
    if (!e) e = acc[key] = { target, kind, ch, rel: false, v: 0, w: 0, rd: 0, add: 0, items: [] };
    if (additive) { e.add += v * w; return; }
    e.items.push({ rel: !!rel, v, w: clamp01(w), pr: pr === undefined ? DEFAULT_PRIORITY : pr, ord: ord || 0 });
  }
  // Mezcla en cascada: de mayor a menor prioridad, cada contribución toma `w` de lo que queda libre. Resultado por canal:
  //   absoluto: base + (v − base)·w   ·   relativo: + rd   ·   aditivo: + add   →  valor final = base + (v − base)·w + rd + add
  function resolve(acc) {
    for (const key in acc) {
      const e = acc[key], items = e.items; if (!items) continue;
      items.sort((a, b) => b.pr - a.pr || b.ord - a.ord);
      let free = 1, wAbs = 0, vAbs = 0, rd = 0;
      for (const it of items) {
        if (free <= 1e-9) break;
        const f = free * it.w; free -= f;
        if (it.rel) rd += it.v * f; else { wAbs += f; vAbs += it.v * f; }
      }
      e.w = wAbs; e.v = wAbs > 0 ? vAbs / wAbs : 0; e.rd = rd; e.rel = wAbs === 0 && items.length > 0;
      delete e.items;
    }
    return acc;
  }
  // Valor final de una entrada resuelta sobre la pose base `base` (las uniones usan base 0).
  const apply = (e, base) => base + (e.v - base) * e.w + e.rd + e.add;
  function sampleAnimInto(anim, times, lib, acc, weight, map, depth, additiveAll, pr0, ord0) {
    for (let i = 0; i < anim.layers.length; i++) {
      const l = anim.layers[i]; if (!l.enabled) continue;
      // dentro de un símbolo manda la prioridad de la capa que lo contiene (el símbolo hereda), salvo que la capa interna sea más alta
      sampleLayerInto(l, times[i], lib, acc, weight * l.weight, map, depth, additiveAll || l.mode === 'additive', pr0 === undefined ? l.priority : Math.max(pr0, l.priority), (ord0 || 0) + i * 1e-6);
    }
  }
  function sampleLayerInto(layer, t, lib, acc, w, map, depth, additive, pr, ord) {
    if (pr === undefined) pr = layer.priority;
    for (const tr of layer.tracks) {
      const target = map && map[tr.target] !== undefined ? map[tr.target] : tr.target;
      for (const c in tr.channels) { const v = sampleKeys(tr.channels[c], t); if (v !== undefined) put(acc, target, tr.kind, chKey(tr, c), tr.rel, v, w, additive, pr, ord); }
    }
    if (depth >= MAX_DEPTH) return;
    for (const clip of layer.clips) {
      const sym = libGet(lib, clip.symbol); if (!sym || t < clip.start) continue;
      const slen = animLength(sym, lib, depth + 1), sp = clip.speed || 1, span = clip.length || (slen / Math.max(1e-6, Math.abs(sp)));
      let lt = (t - clip.start) * sp;
      if (!clip.loop && (t - clip.start) > span) lt = span * sp;
      else if (clip.loop && slen > 0) lt = ((lt % slen) + slen) % slen;
      const inner = {}; if (clip.targets) for (const k in clip.targets) inner[k] = clip.targets[k];
      const merged = map ? Object.assign({}, inner) : inner;
      if (map) for (const k in merged) if (map[merged[k]] !== undefined) merged[k] = map[merged[k]];
      sampleAnimInto(sym, sym.layers.map(sl => symbolLayerTime(sl, lt, slen, lib, depth + 1, sym.loop)), lib, acc, w * clip.weight, merged, depth + 1, additive, pr, ord);
    }
  }
  // dentro de un símbolo cada capa respeta su propio loop (si no define loop, hereda el del símbolo)
  function symbolLayerTime(sl, lt, slen, lib, depth, symLoop) {
    const len = layerLength(sl, lib, depth) || slen; if (!(len > 0)) return 0;
    return (sl.loop === undefined ? symLoop : sl.loop) ? ((lt % len) + len) % len : Math.min(lt, len);
  }

  // ── Eventos: se disparan al cruzar su tiempo (también al dar la vuelta de un loop) ──
  function cross(events, t0, t1, len, loop, out, extra, incl) {
    if (!events.length) return;
    const fire = (a, b, inclFirst) => { for (const e of events) if ((inclFirst ? e.t >= a : e.t > a) && e.t <= b) out.push(Object.assign({ name: e.name, t: e.t, data: e.data }, extra)); };
    if (t1 >= t0) fire(t0, t1, !!incl);
    else if (loop && len > 0) { fire(t0, len, false); fire(0, t1, true); }
  }

  // ── Reproductor ──
  function createPlayer(def, opts) {
    opts = opts || {};
    const lib = opts.library || null, anim = def && def.layers && def.events && def.fps ? def : sanitize(def);
    const len = animLength(anim, lib, 0);
    // prioridad de cada capa: opts.layerPriority {capa: prioridad} > opts.priority (toda la animación, como en Roblox) > la que trae la capa
    const lpo = opts.layerPriority && typeof opts.layerPriority === 'object' ? opts.layerPriority : null;
    const layerPrio = l => lpo && lpo[l.id] !== undefined ? priorityValue(lpo[l.id], l.priority) : lpo && lpo[l.name] !== undefined ? priorityValue(lpo[l.name], l.priority) : opts.priority !== undefined && opts.priority !== null ? priorityValue(opts.priority, l.priority) : l.priority;
    const p = {
      anim, id: anim.id, name: anim.name, length: len, time: 0, speed: num(opts.speed, 1), weight: num(opts.weight, 1), playing: true, ended: false, started: false,
      loop: opts.loop === undefined ? anim.loop : !!opts.loop, map: opts.targets || null, order: num(opts.order, 0),
      layers: anim.layers.map(l => ({ layer: l, time: 0, loop: opts.layerLoop && opts.layerLoop[l.id] !== undefined ? !!opts.layerLoop[l.id] : opts.layerLoop && opts.layerLoop[l.name] !== undefined ? !!opts.layerLoop[l.name] : (l.loop === undefined ? anim.loop : l.loop), weight: 1, speed: 1, enabled: l.enabled, len: layerLength(l, lib, 0), done: false, priority: layerPrio(l) })),
    };
    const find = key => p.layers.find(x => x.layer.id === String(key) || x.layer.name === String(key));
    p.layer = find;
    p.setLayerLoop = (key, v) => { const x = find(key); if (x) { x.loop = !!v; if (v) x.done = false; } return !!x; };
    p.setLayerWeight = (key, v) => { const x = find(key); if (x) x.weight = num(v, 1); return !!x; };
    p.setLayerSpeed = (key, v) => { const x = find(key); if (x) x.speed = num(v, 1); return !!x; };
    p.setLayerEnabled = (key, v) => { const x = find(key); if (x) x.enabled = !!v; return !!x; };
    p.setLayerPriority = (key, v) => { const x = find(key); if (x) x.priority = priorityValue(v, x.priority); return !!x; };
    p.setPriority = v => { for (const x of p.layers) x.priority = priorityValue(v, x.priority); };
    p.getLayerPriority = key => { const x = find(key); return x ? x.priority : undefined; };
    p.seek = t => { t = Math.max(0, num(t, 0)); p.time = p.loop && len > 0 ? t % len : t; p.ended = false; p.started = false; for (const x of p.layers) { x.time = x.loop && x.len > 0 ? t % x.len : Math.min(t, x.len); x.done = false; } };
    // Suma las contribuciones de TODAS las capas a `acc` SIN resolver las prioridades: sirve para mezclar varias animaciones a la vez
    // (la que tenga la capa de más prioridad sobre una pieza, gana esa pieza). Luego se llama a resolve(acc).
    p.sampleInto = acc => {
      const n = p.layers.length + 1;
      for (let i = 0; i < p.layers.length; i++) { const x = p.layers[i]; if (!x.enabled) continue; sampleLayerInto(x.layer, x.time, lib, acc, p.weight * x.weight * x.layer.weight, p.map, 0, x.layer.mode === 'additive', x.priority, p.order + (i + 1) / n); }
      return acc;
    };
    p.sample = () => resolve(p.sampleInto({}));
    p.update = (dt, skipSample) => {
      const events = [];
      if (!p.playing) return { values: skipSample ? null : p.sample(), events, ended: p.ended };
      dt = Math.max(0, num(dt, 0)) * p.speed * anim.speed;
      const first = !p.started; p.started = true;
      // reloj maestro (eventos de la animación)
      const t0 = p.time; let t1 = t0 + dt;
      if (p.loop && len > 0) t1 = t1 % len;
      else if (t1 > len) t1 = len;
      cross(anim.events, t0, t1, len, p.loop, events, { layer: null }, first);
      p.time = t1;
      let anyRunning = false;
      for (const x of p.layers) {
        if (x.done && !x.loop) continue;
        const a = x.time, ldt = dt * x.speed; let b = a + ldt;
        if (x.loop && x.len > 0) b = b % x.len; else if (b >= x.len) b = x.len;
        cross(x.layer.events, a, b, x.len, x.loop, events, { layer: x.layer.name }, first);
        x.time = b; if (!x.loop && b >= x.len) x.done = true; else anyRunning = true;
      }
      if (!p.layers.length) anyRunning = false;
      const looping = p.loop || p.layers.some(x => x.loop && x.len > 0);
      if (!anyRunning && !looping && t1 >= len) { p.ended = true; p.playing = false; }
      return { values: skipSample ? null : p.sample(), events, ended: p.ended };
    };
    return p;
  }

  return { CHANNELS, BONE_CHANNELS, FACE_SUBS, FACE_DEFAULTS, FACE_EMOTIONS, FACE_STEP, channelsOf, EASINGS, PRIORITIES, DEFAULT_PRIORITY, priorityValue, priorityName, ease, bezier, sanitize, blank, sampleKeys, animLength, layerLength, createPlayer, put, resolve, apply };
});
