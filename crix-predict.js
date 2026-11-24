/* Crix — predicción de movimiento para lo que mueven los scripts del servidor.
 *
 * El servidor manda posiciones a ~20 Hz (script: updatePart, tween, setVelocity; física: world_delta; uniones: joint_poses),
 * cada paquete con la hora del servidor `t`. Antes el cliente estimaba la velocidad con la hora de LLEGADA de los paquetes,
 * así que el jitter de red (paquetes que llegan juntos o tarde) producía velocidades falsas y tirones.
 *
 * Aquí se usa la hora del servidor:
 *   1. Reloj: `off` = mínimo de (llegada − t). Con eso la "edad" de cada paquete no depende del jitter.
 *   2. Velocidad (y velocidad angular) exactas = diferencia entre las dos últimas muestras / diferencia de sus `t`.
 *   3. Aceleración opcional (suavizada y acotada) para que un tween con easing (sine, quadInOut…) no se prediga como recta.
 *   4. Se extrapola solo hasta un horizonte corto (≈1,5 intervalos de paquete); si el paquete siguiente no llega, la extrapolación
 *      se apaga y la pieza vuelve a la última posición exacta del servidor (no vuela ni se queda desviada). `lead` (s) adelanta además la latencia de ida (≈ ping/2) para mostrar el "ahora" del servidor.
 *   5. Teletransportes (velocidad > MAX_SPEED) y huecos largos no se extrapolan.
 *
 * Es un módulo puro (sin DOM ni three.js): funciona igual en el navegador (window.CrixPredict) y en Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CrixPredict = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_SPEED = 150;       // studs/s: más rápido = teletransporte, no se extrapola
  const MAX_SPIN = 40;         // rad/s
  const MIN_DT = 0.004;        // s: paquetes más juntos que esto se ignoran para la velocidad
  const MAX_GAP = 0.5;         // s: un hueco mayor reinicia la velocidad
  const MAX_ACCEL = 400;       // studs/s²
  const ACCEL_GAIN = 0.5;      // cuánto de la aceleración medida se usa (ruido de cuantización)
  const AXES = ['x', 'y', 'z'], ROT = ['rx', 'ry', 'rz'];

  const wrap = a => { a %= Math.PI * 2; if (a > Math.PI) a -= Math.PI * 2; else if (a < -Math.PI) a += Math.PI * 2; return a; };
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

  function create(options) {
    const opt = Object.assign({ lead: 0, maxHorizon: 0.25, minHorizon: 0.06, accel: true }, options || {});
    const ents = new Map();
    let off = null;            // ms: llegada − t mínimo observado
    let lead = opt.lead;       // s

    function clock(t, recv) {
      const s = recv - t;
      if (off === null || s < off) off = s;
      else off += (s - off) * 0.02;           // deriva lenta hacia arriba (el reloj del cliente y el del servidor se separan)
    }

    // Registra una muestra del servidor. `st` = {x,y,z,rx,ry,rz}. Devuelve false si es vieja (fuera de orden).
    function push(id, t, st, recv) {
      if (!(t > 0)) return false;
      clock(t, recv);
      const key = String(id);
      let e = ents.get(key);
      const cur = { x: st.x || 0, y: st.y || 0, z: st.z || 0, rx: st.rx || 0, ry: st.ry || 0, rz: st.rz || 0 };
      if (!e) { ents.set(key, e = { t, p: cur, v: null, w: null, a: null, interval: 0.05, still: 0 }); return true; }
      if (t <= e.t) return false;
      const dt = (t - e.t) / 1000;
      if (dt < MIN_DT) { e.p = cur; e.t = t; return true; }
      if (dt > MAX_GAP) { e.v = null; e.w = null; e.a = null; e.p = cur; e.t = t; return true; }
      const v = { x: (cur.x - e.p.x) / dt, y: (cur.y - e.p.y) / dt, z: (cur.z - e.p.z) / dt };
      const w = { x: wrap(cur.rx - e.p.rx) / dt, y: wrap(cur.ry - e.p.ry) / dt, z: wrap(cur.rz - e.p.rz) / dt };
      e.interval = e.interval * 0.7 + dt * 0.3;
      const teleport = Math.hypot(v.x, v.y, v.z) > MAX_SPEED;
      if (teleport) { e.v = null; e.w = null; e.a = null; }
      else {
        if (opt.accel && e.v && dt < 0.25) {
          let a = { x: (v.x - e.v.x) / dt, y: (v.y - e.v.y) / dt, z: (v.z - e.v.z) / dt };
          const m = Math.hypot(a.x, a.y, a.z);
          if (m > MAX_ACCEL) { const k = MAX_ACCEL / m; a = { x: a.x * k, y: a.y * k, z: a.z * k }; }
          // suavizado: una aceleración aislada (ruido) no domina
          e.a = e.a ? { x: e.a.x * 0.5 + a.x * 0.5, y: e.a.y * 0.5 + a.y * 0.5, z: e.a.z * 0.5 + a.z * 0.5 } : { x: a.x * 0.5, y: a.y * 0.5, z: a.z * 0.5 };
        } else e.a = null;
        e.v = v;
        e.w = Math.hypot(w.x, w.y, w.z) < MAX_SPIN ? w : null;
      }
      e.still = Math.hypot(v.x, v.y, v.z) < 1e-3 && !(e.w && Math.hypot(e.w.x, e.w.y, e.w.z) > 1e-3) ? e.still + 1 : 0;
      e.p = cur; e.t = t;
      e.teleported = teleport;
      return true;
    }

    // Estado predicho para el instante `now` (ms, mismo reloj que `recv`). Escribe en `out` y lo devuelve; null si no hay muestras.
    function sample(id, now, out) {
      const e = ents.get(String(id)); if (!e) return null;
      out = out || {};
      const H = clamp(e.interval * 1.5, opt.minHorizon, opt.maxHorizon);
      const raw = off === null ? 0 : (now - off - e.t) / 1000;     // s desde que el servidor tomó la muestra (sin jitter)
      const age = clamp(raw, 0, H) + lead;
      // Si pasado el horizonte no llega otro paquete, lo normal es que la pieza se haya detenido (fin de un tween): la extrapolación
      // se apaga en ~0,15 s y la pieza queda EXACTAMENTE en la última posición del servidor (sin sobrepaso permanente).
      const fade = raw <= H ? 1 : clamp(1 - (raw - H) / 0.15, 0, 1);
      const v = e.v, w = e.w, a = e.a;
      for (let i = 0; i < 3; i++) {
        const k = AXES[i];
        let d = v ? v[k] * age : 0;
        if (a && v) {
          const ad = 0.5 * a[k] * age * age * ACCEL_GAIN;
          // la corrección por aceleración nunca debe invertir el sentido ni pasar de la mitad del avance lineal
          d += clamp(ad, -Math.abs(d) * 0.5, Math.abs(d) * 0.5);
        }
        out[k] = e.p[k] + d * fade;
        out[ROT[i]] = e.p[ROT[i]] + (w ? w[k] * age * fade : 0);
      }
      out.moving = !!(v && (Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z) > 1e-3)) || !!(w && Math.abs(w.x) + Math.abs(w.y) + Math.abs(w.z) > 1e-3);
      return out;
    }

    return {
      push, sample, clock,
      setLead(s) { lead = clamp(+s || 0, 0, 0.15); },
      reset(id) { ents.delete(String(id)); },
      clear() { ents.clear(); off = null; },
      vel(id) { const e = ents.get(String(id)); return e ? e.v : null; },
      ang(id) { const e = ents.get(String(id)); return e ? e.w : null; },
      interval(id) { const e = ents.get(String(id)); return e ? e.interval : 0.05; },
      has(id) { return ents.has(String(id)); },
      get offset() { return off; }
    };
  }

  return { create, wrap, MAX_SPEED };
});
