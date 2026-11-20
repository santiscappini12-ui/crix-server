'use strict';
// CrixAnim — motor de animación de Crix (sin dependencias; lo usan el servidor, los scripts y el editor).
//
//  Animación = { id, name, length?, loop?, speed?, layers:[Capa], events:[{t,name,data?}] }
//  Capa      = { id, name, loop?, weight, speed, mode:'override'|'additive', length?, enabled,
//                tracks:[Pista], clips:[Clip], events:[...] }
//  Pista     = { target, kind:'part'|'joint', rel:bool, channels:{ x|y|z|rx|ry|rz|sx|sy|sz|transparent|angle: [Key] } }
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
    const t = { target: sid(src && src.target, ''), kind: src && src.kind === 'joint' ? 'joint' : 'part', rel: !!(src && src.rel), channels: {} };
    const ch = src && src.channels && typeof src.channels === 'object' ? src.channels : {};
    for (const c of CHANNELS) { const keys = sanitizeKeys(ch[c]); if (keys.length) t.channels[c] = keys; }
    return t;
  }
  function sanitizeClip(src) {
    const c = { symbol: sid(src && src.symbol, ''), start: Math.max(0, num(src && src.start, 0)), loop: !(src && src.loop === false), speed: num(src && src.speed, 1), weight: num(src && src.weight, 1), targets: {} };
    if (src && src.length !== undefined && Number(src.length) > 0) c.length = Number(src.length);
    if (src && src.targets && typeof src.targets === 'object') for (const [k, v] of Object.entries(src.targets)) c.targets[String(k)] = String(v);
    return c;
  }
  function sanitizeLayer(src, i) {
    const l = { id: sid(src && src.id, 'L' + (i + 1)), name: sid(src && src.name, 'Capa ' + (i + 1)), weight: num(src && src.weight, 1), speed: num(src && src.speed, 1), mode: src && src.mode === 'additive' ? 'additive' : 'override', enabled: !(src && src.enabled === false), tracks: (src && Array.isArray(src.tracks) ? src.tracks : []).map(sanitizeTrack), clips: (src && Array.isArray(src.clips) ? src.clips : []).map(sanitizeClip), events: sanitizeEvents(src && src.events) };
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
  // acumulador: key `target\u0001kind\u0001channel` → { target, kind, ch, rel, v, w, add }
  function put(acc, target, kind, ch, rel, v, w, additive) {
    const key = target + '\u0001' + kind + '\u0001' + ch; let e = acc[key];
    if (!e) e = acc[key] = { target, kind, ch, rel, v: 0, w: 0, add: 0 };
    if (additive) { e.add += v * w; return; }
    if (e.w <= 0) { e.v = v; e.w = clamp01(w); } else { e.v = e.v + (v - e.v) * clamp01(w); e.w = e.w + (1 - e.w) * clamp01(w); }
    e.rel = rel;
  }
  function sampleAnimInto(anim, times, lib, acc, weight, map, depth, additiveAll) {
    for (let i = 0; i < anim.layers.length; i++) {
      const l = anim.layers[i]; if (!l.enabled) continue;
      sampleLayerInto(l, times[i], lib, acc, weight * l.weight, map, depth, additiveAll || l.mode === 'additive');
    }
  }
  function sampleLayerInto(layer, t, lib, acc, w, map, depth, additive) {
    for (const tr of layer.tracks) {
      const target = map && map[tr.target] !== undefined ? map[tr.target] : tr.target;
      for (const c in tr.channels) { const v = sampleKeys(tr.channels[c], t); if (v !== undefined) put(acc, target, tr.kind, c, tr.rel, v, w, additive); }
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
      sampleAnimInto(sym, sym.layers.map(sl => symbolLayerTime(sl, lt, slen, lib, depth + 1, sym.loop)), lib, acc, w * clip.weight, merged, depth + 1, additive);
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
    const p = {
      anim, id: anim.id, name: anim.name, length: len, time: 0, speed: num(opts.speed, 1), weight: num(opts.weight, 1), playing: true, ended: false, started: false,
      loop: opts.loop === undefined ? anim.loop : !!opts.loop, map: opts.targets || null,
      layers: anim.layers.map(l => ({ layer: l, time: 0, loop: opts.layerLoop && opts.layerLoop[l.id] !== undefined ? !!opts.layerLoop[l.id] : opts.layerLoop && opts.layerLoop[l.name] !== undefined ? !!opts.layerLoop[l.name] : (l.loop === undefined ? anim.loop : l.loop), weight: 1, speed: 1, enabled: l.enabled, len: layerLength(l, lib, 0), done: false })),
    };
    const find = key => p.layers.find(x => x.layer.id === String(key) || x.layer.name === String(key));
    p.layer = find;
    p.setLayerLoop = (key, v) => { const x = find(key); if (x) { x.loop = !!v; if (v) x.done = false; } return !!x; };
    p.setLayerWeight = (key, v) => { const x = find(key); if (x) x.weight = num(v, 1); return !!x; };
    p.setLayerSpeed = (key, v) => { const x = find(key); if (x) x.speed = num(v, 1); return !!x; };
    p.setLayerEnabled = (key, v) => { const x = find(key); if (x) x.enabled = !!v; return !!x; };
    p.seek = t => { t = Math.max(0, num(t, 0)); p.time = p.loop && len > 0 ? t % len : t; p.ended = false; p.started = false; for (const x of p.layers) { x.time = x.loop && x.len > 0 ? t % x.len : Math.min(t, x.len); x.done = false; } };
    p.sample = () => {
      const acc = {}, times = p.layers.map(x => x.time);
      for (let i = 0; i < p.layers.length; i++) { const x = p.layers[i]; if (!x.enabled) continue; sampleLayerInto(x.layer, times[i], lib, acc, p.weight * x.weight * x.layer.weight, p.map, 0, x.layer.mode === 'additive'); }
      return acc;
    };
    p.update = dt => {
      const events = [];
      if (!p.playing) return { values: p.sample(), events, ended: p.ended };
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
      return { values: p.sample(), events, ended: p.ended };
    };
    return p;
  }

  return { CHANNELS, EASINGS, ease, bezier, sanitize, blank, sampleKeys, animLength, layerLength, createPlayer };
});
