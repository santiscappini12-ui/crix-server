/* Crix — pisadas y salto realistas (y bajitos), generados con Web Audio: no usa archivos de audio.
 *
 * Cada pisada = un golpe de ruido filtrado (el "roce" del zapato contra la superficie) + un golpe grave corto (el peso del cuerpo),
 * con pequeñas variaciones al azar de tono y volumen y un pie izquierdo/derecho alternados, para que no suene a máquina.
 * El material de la pieza que se pisa cambia el sonido: pasto, arena, madera, piedra, metal, tela/suave.
 *
 * Ajustes (se guardan en localStorage y en la cuenta, ver ACCOUNT_PREF_KEYS):
 *   crix_step_on      'on' | 'off'   pisadas
 *   crix_step_vol     0..100         volumen general de pisadas y salto (por defecto 35: bajito)
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
  const DEFAULTS = { crix_step_on: 'on', crix_step_vol: '35', crix_step_style: 'auto', crix_jump_on: 'on', crix_step_others: 'on' };
  const MASTER = 0.5;          // ganancia base: con el volumen por defecto (35 %) queda muy bajito
  const STRIDE = 4.2;          // studs recorridos por pisada (≈3,3 pisadas/s a velocidad normal)
  const MAX_VOICES_PER_S = 14; // tope de sonidos por segundo (evita saturar con muchos jugadores)

  let getCtx = () => null, getPref = k => null, setPrefHook = null;
  let noiseBuf = null, lastVoices = [], localFoot = 0;
  const rnd = (a, b) => a + Math.random() * (b - a);

  function pref(k) { let v = null; try { v = getPref(k); } catch (_) {} return v == null ? DEFAULTS[k] : v; }
  function volume() { const n = parseInt(pref('crix_step_vol'), 10); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) / 100 : 0.35; }
  const stepsOn = () => pref('crix_step_on') !== 'off';
  const jumpOn = () => pref('crix_jump_on') !== 'off';
  const othersOn = () => pref('crix_step_others') !== 'off';

  function ctxReady() { const c = getCtx(); return c && c.state === 'running' ? c : null; }
  function noise(c) {
    if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
    const len = c.sampleRate, b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = (w * 0.6 + last * 8); }   // ruido rosado-ish: menos "siseo" que el blanco
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
  // Golpe grave (el peso del cuerpo contra el suelo).
  function thump(c, at, freq, dur, vol, out) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(freq * 1.6, at); o.frequency.exponentialRampToValueAtTime(freq, at + dur * 0.5);
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), at + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(out || c.destination); o.start(at); o.stop(at + dur + 0.03);
  }
  function ring(c, at, freq, dur, vol, out) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), at + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(out || c.destination); o.start(at); o.stop(at + dur + 0.03);
  }

  // Receta de cada superficie. `v` = volumen (0..1 ya con variación), `p` = variación de tono (≈0,88..1,12), `foot` = 0 / 1 (izq./der.)
  const RECIPES = {
    grass(c, t, v, p, out) { burst(c, t, { type: 'lowpass', f: 2200 * p, q: 0.5, dur: 0.14, vol: v * 0.9, att: 0.012, out }); burst(c, t, { type: 'highpass', f: 900 * p, dur: 0.09, vol: v * 0.35, att: 0.01, out }); thump(c, t, 70 * p, 0.07, v * 0.25, out); },
    sand(c, t, v, p, out) { burst(c, t, { type: 'bandpass', f: 1300 * p, q: 0.5, dur: 0.17, vol: v * 0.85, att: 0.018, out }); thump(c, t, 65 * p, 0.06, v * 0.15, out); },
    wood(c, t, v, p, out) { thump(c, t, 115 * p, 0.09, v * 0.9, out); burst(c, t, { type: 'bandpass', f: 950 * p, q: 2.2, dur: 0.05, vol: v * 0.7, att: 0.002, out }); burst(c, t, { type: 'highpass', f: 2500 * p, dur: 0.02, vol: v * 0.25, att: 0.001, out }); },
    stone(c, t, v, p, out) { burst(c, t, { type: 'bandpass', f: 2300 * p, q: 1.3, dur: 0.045, vol: v * 0.85, att: 0.001, out }); burst(c, t, { type: 'lowpass', f: 700 * p, dur: 0.06, vol: v * 0.45, att: 0.002, out }); thump(c, t, 90 * p, 0.07, v * 0.5, out); },
    metal(c, t, v, p, out) { burst(c, t, { type: 'bandpass', f: 3200 * p, q: 3, dur: 0.05, vol: v * 0.6, att: 0.001, out }); thump(c, t, 100 * p, 0.06, v * 0.45, out); ring(c, t, 1750 * p, 0.12, v * 0.1, out); ring(c, t, 2650 * p, 0.09, v * 0.07, out); },
    soft(c, t, v, p, out) { burst(c, t, { type: 'lowpass', f: 1300 * p, q: 0.6, dur: 0.08, vol: v * 0.8, att: 0.006, out }); thump(c, t, 95 * p, 0.075, v * 0.55, out); }
  };
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
    RECIPES[kindFor(material)](c, c.currentTime + 0.005, v, p, out);
  }
  // Salto: "hup" corto (aire que sube) y un roce suave.
  function jump() {
    if (!jumpOn() || !budget()) return;
    const c = ctxReady(); if (!c) return;
    const v = volume() * MASTER * 0.8, t = c.currentTime + 0.005;
    burst(c, t, { type: 'bandpass', f: 500, f2: 1500, q: 0.9, dur: 0.16, vol: v * 0.55, att: 0.03 });
    thump(c, t, 110 * rnd(0.95, 1.05), 0.07, v * 0.5);
  }
  // Aterrizaje: más fuerte cuanto más rápida fue la caída (`impact` en studs por paso de 60 Hz, ≈0,15 un salto normal, 1 caída máxima).
  function land(material, impact) {
    if (!jumpOn() || impact < 0.08 || !budget()) return;
    const k = Math.max(0.35, Math.min(1.4, impact / 0.3));
    step(material, k, 0, 0);
    const c = ctxReady(); if (!c) return;
    thump(c, c.currentTime + 0.005, 60 * rnd(0.95, 1.05), 0.12, volume() * MASTER * 0.5 * k);
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
