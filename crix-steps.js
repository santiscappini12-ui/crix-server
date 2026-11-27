/* Crix — pisadas y salto realistas (y bajitos), generados con Web Audio: no usa archivos de audio.
 *
 * Cada pisada = un golpe de ruido filtrado (el "roce" del zapato contra la superficie) + un golpe grave corto (el peso del cuerpo),
 * con pequeñas variaciones al azar de tono y volumen y un pie izquierdo/derecho alternados, para que no suene a máquina.
 * El material de la pieza que se pisa cambia el sonido: pasto, arena, madera, piedra, metal, tela/suave.
 *
 * Ajustes (se guardan en localStorage y en la cuenta, ver ACCOUNT_PREF_KEYS):
 *   crix_step_on      'on' | 'off'   pisadas
 *   crix_step_vol     0..100         volumen general de pisadas y salto (por defecto 30: bajito)
 *   crix_step_style   'auto' | 'grass' | 'sand' | 'wood' | 'stone' | 'metal' | 'soft'   (auto = según el material del suelo)
 *   crix_jump_on      'on' | 'off'   sonido de salto y de aterrizaje
 *   crix_step_others  'on' | 'off'   pisadas de los otros jugadores (más bajas con la distancia)
 *
 * Módulo sin dependencias del juego: recibe un getter del AudioContext y uno de preferencias.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CrixSteps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STYLES = ['auto', 'grass', 'sand', 'wood', 'stone', 'metal', 'soft'];
  const STYLE_NAMES = { auto: 'Automático (según el suelo)', grass: 'Pasto', sand: 'Arena', wood: 'Madera', stone: 'Piedra', metal: 'Metal', soft: 'Suave' };
  const MAT_KIND = {
    Grass: 'grass', Sand: 'sand', Wood: 'wood', WoodPlanks: 'wood',
    Rock: 'stone', Cobblestone: 'stone', Brick: 'stone', Concrete: 'stone', Marble: 'stone', Glass: 'stone', Ice: 'stone', Slate: 'stone',
    Metal: 'metal', DiamondPlate: 'metal', Fabric: 'soft', Plastic: 'soft', SmoothPlastic: 'soft', Neon: 'soft'
  };
  const DEFAULTS = { crix_step_on: 'on', crix_step_vol: '30', crix_step_style: 'auto', crix_jump_on: 'on', crix_step_others: 'on' };
  const MASTER = 0.2;          // ganancia base: con el volumen por defecto (30 %) las pisadas quedan en ≈ −27 dBFS de pico (bajitas)
  const STRIDE = 4.2;          // studs recorridos por pisada (≈3,3 pisadas/s a velocidad normal)
  const MAX_VOICES_PER_S = 14; // tope de sonidos por segundo (evita saturar con muchos jugadores)

  let getCtx = () => null, getPref = k => null, setPrefHook = null;
  let noiseBuf = null, lastVoices = [], localFoot = 0;
  const rnd = (a, b) => a + Math.random() * (b - a);

  function pref(k) { let v = null; try { v = getPref(k); } catch (_) {} return v == null ? DEFAULTS[k] : v; }
  function volume() { const n = parseInt(pref('crix_step_vol'), 10); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) / 100 : 0.3; }
  const stepsOn = () => pref('crix_step_on') !== 'off';
  const jumpOn = () => pref('crix_jump_on') !== 'off';
  const othersOn = () => pref('crix_step_others') !== 'off';

  function ctxReady() { const c = getCtx(); return c && c.state === 'running' ? c : null; }
  function noise(c) {
    if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
    const len = c.sampleRate, b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
    let last = 0, sum = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = w * 0.6 + last * 8; sum += d[i] * d[i]; }
    const k = 0.3 / Math.sqrt(sum / len);   // nivel fijo (RMS 0,3): así el volumen de cada sonido depende solo de su receta
    for (let i = 0; i < len; i++) d[i] *= k;
    return (noiseBuf = b);
  }
  function budget() {
    const t = performance.now(); lastVoices = lastVoices.filter(x => t - x < 1000);
    if (lastVoices.length >= MAX_VOICES_PER_S) return false;
    lastVoices.push(t); return true;
  }

  // Un golpe de ruido filtrado: tipo de filtro, frecuencia, Q, duración, volumen.
  function burst(c, at, o) {
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = noise(c); src.loop = false;
    f.type = o.type; f.frequency.setValueAtTime(o.f, at); if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, at + o.dur); f.Q.value = o.q || 0.7;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.vol), at + (o.att || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, at + o.dur);
    src.connect(f); f.connect(g); g.connect(o.out || c.destination);
    src.start(at, Math.random() * 0.5); src.stop(at + o.dur + 0.03);
  }
  // Golpe grave (el peso del cuerpo): ruido muy filtrado, sin tono, para que suene a "tump" y no a nota.
  const thud = (c, at, f, dur, vol, out) => burst(c, at, { type: 'lowpass', f, q: 0.7, dur, vol, att: 0.006, out });

  // Receta de cada superficie. `v` = volumen, `p` = variación de tono (≈0,9..1,1). Todas son talón + punta (dos golpes seguidos, el
  // segundo más flojo y más grave), que es lo que hace que un paso suene a paso y no a un "clic".
  const RECIPES = {
    grass(c, t, v, p, out) { burst(c, t, { type: 'lowpass', f: 1900 * p, q: 0.3, dur: 0.12, vol: v * 0.9, att: 0.018, out }); burst(c, t + 0.075, { type: 'lowpass', f: 1400 * p, q: 0.3, dur: 0.1, vol: v * 0.45, att: 0.02, out }); thud(c, t, 160, 0.06, v * 0.5, out); },
    sand(c, t, v, p, out) { burst(c, t, { type: 'bandpass', f: 1000 * p, q: 0.4, dur: 0.15, vol: v * 0.8, att: 0.025, out }); burst(c, t + 0.08, { type: 'bandpass', f: 800 * p, q: 0.4, dur: 0.12, vol: v * 0.4, att: 0.025, out }); thud(c, t, 140, 0.05, v * 0.3, out); },
    wood(c, t, v, p, out) { burst(c, t, { type: 'bandpass', f: 1100 * p, q: 1.1, dur: 0.045, vol: v * 0.9, att: 0.002, out }); thud(c, t, 220 * p, 0.09, v * 0.9, out); burst(c, t + 0.07, { type: 'bandpass', f: 800 * p, q: 1, dur: 0.035, vol: v * 0.4, att: 0.002, out }); },
    stone(c, t, v, p, out) { burst(c, t, { type: 'bandpass', f: 1900 * p, q: 0.8, dur: 0.04, vol: v * 0.9, att: 0.001, out }); thud(c, t, 260, 0.07, v * 0.55, out); burst(c, t + 0.07, { type: 'bandpass', f: 1300 * p, q: 0.8, dur: 0.03, vol: v * 0.35, att: 0.001, out }); },
    metal(c, t, v, p, out) { burst(c, t, { type: 'bandpass', f: 2300 * p, q: 1.4, dur: 0.07, vol: v * 0.75, att: 0.001, out }); thud(c, t, 240, 0.06, v * 0.4, out); burst(c, t + 0.07, { type: 'bandpass', f: 1800 * p, q: 1.2, dur: 0.05, vol: v * 0.3, att: 0.001, out }); },
    soft(c, t, v, p, out) { burst(c, t, { type: 'lowpass', f: 1000 * p, q: 0.5, dur: 0.075, vol: v * 0.85, att: 0.008, out }); thud(c, t, 200, 0.07, v * 0.6, out); burst(c, t + 0.07, { type: 'lowpass', f: 800 * p, q: 0.5, dur: 0.06, vol: v * 0.35, att: 0.008, out }); }
  };
  // Ajuste por superficie (medido renderizando cada receta): deja a todas en el mismo nivel, ≈ −27 dBFS de pico con el volumen por defecto.
  const TRIM = { grass: 2.2, sand: 3.2, wood: 3.0, stone: 3.8, metal: 5.3, soft: 2.0 };
  const play = (kind, c, t, v, p, out) => RECIPES[kind](c, t, v * TRIM[kind], p, out);
  function kindFor(material) {
    const s = pref('crix_step_style');
    if (s && s !== 'auto' && RECIPES[s]) return s;
    return MAT_KIND[material] || 'soft';
  }

  // Pisada suelta. `gain` (0..1) escala sobre el volumen del usuario (distancia, velocidad…). `pan` (-1..1) opcional.
  function step(material, gain, foot, pan) {
    if (!stepsOn() || !budget()) return;
    const c = ctxReady(); if (!c) return;
    const vol = volume() * MASTER * Math.max(0, Math.min(1, gain == null ? 1 : gain)); if (vol < 0.002) return;
    let out = c.destination;
    if (pan && c.createStereoPanner) { const sp = c.createStereoPanner(); sp.pan.value = Math.max(-1, Math.min(1, pan)); sp.connect(c.destination); out = sp; }
    const side = foot ? 1 : -1, p = rnd(0.9, 1.1) * (1 + side * 0.025), v = vol * rnd(0.85, 1.15);
    play(kindFor(material), c, c.currentTime + 0.005, v, p, out);
  }
  // Salto: el empujón del pie contra el suelo (una pisada, del material que se pisa) + un roce de ropa muy suave.
  function jump(material) {
    if (!jumpOn() || !budget()) return;
    const c = ctxReady(); if (!c) return;
    const v = volume() * MASTER, t = c.currentTime + 0.005;
    play(kindFor(material), c, t, v * 0.8, rnd(0.92, 1.0), c.destination);
    burst(c, t + 0.02, { type: 'bandpass', f: 1500, q: 0.4, dur: 0.14, vol: v * 0.3, att: 0.04 });
  }
  // Aterrizaje: dos pisadas juntas (los dos pies) y un golpe grave; más fuerte cuanto más rápida fue la caída
  // (`impact` en studs por paso de 60 Hz: ≈0,35 un salto normal, 1 la caída máxima).
  function land(material, impact) {
    if (!jumpOn() || impact < 0.08 || !budget()) return;
    const c = ctxReady(); if (!c) return;
    const k = Math.max(0.4, Math.min(1.5, impact / 0.35)), v = volume() * MASTER * k, t = c.currentTime + 0.005, kind = kindFor(material);
    play(kind, c, t, v * 1.5, rnd(0.9, 1.0), c.destination);
    thud(c, t, 150, 0.12, v * 1.0, c.destination);
  }

  // Ritmo de pisadas por distancia recorrida: llamar una vez por paso con lo que avanzó en el suelo.
  function tracker() { return { acc: 0, foot: 0, was: false }; }
  function feed(tr, dist, onGround, cb) {
    if (!onGround) { tr.was = false; return; }
    if (!tr.was) { tr.was = true; tr.acc = Math.min(tr.acc, STRIDE * 0.5); }   // al aterrizar no suena de inmediato (lo hace land())
    if (dist < 0.004) { tr.acc = Math.max(0, tr.acc - 0.02); return; }
    tr.acc += dist;
    if (tr.acc >= STRIDE) { tr.acc -= STRIDE; tr.foot ^= 1; cb(tr.foot); }
  }

  // Material de la pieza `data` (la raíz de un modelo puede no tenerlo: 'soft').
  const materialOf = data => (data && data.material) || '';

  function init(opts) { opts = opts || {}; if (opts.ctx) getCtx = opts.ctx; if (opts.pref) getPref = opts.pref; if (opts.set) setPrefHook = opts.set; }
  function setPref(k, v) { if (setPrefHook) setPrefHook(k, v); }
  function preview() { const c = ctxReady(); if (!c) return; step('', 1, 0); setTimeout(() => step('', 1, 1), 280); }

  return {
    init, step, jump, land, tracker, feed, materialOf, preview, setPref,
    get: pref, volume, stepsOn, jumpOn, othersOn, STRIDE, STYLES, STYLE_NAMES, DEFAULTS, MAT_KIND
  };
});
