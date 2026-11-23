'use strict';
// CrixGFX — render realista para el juego y el editor (Three.js r128).
//  • Flujo de color correcto: salida sRGB + tone mapping cinematográfico (ACES) y colores de entrada convertidos a lineal.
//  • Materiales PBR (MeshStandard / MeshPhysical): rugosidad, metalicidad, barniz, relieve (bump) y reflejos del entorno.
//  • Iluminación basada en imagen: el cielo se convierte en un mapa de entorno (PMREM) que ilumina y se refleja en todo.
//  • Cielo procedural con gradiente, sol, halo y nubes que se mueven despacio.
//  • Calidad automática (celular / PC) y ajustable: localStorage.crix_gfx = 'low' | 'high' | 'ultra'.
(function () {
  const T = window.THREE;
  if (!T) return;
  const mobile = /Android|webOS|iPhone|iPad/i.test(navigator.userAgent) || Math.min(innerWidth, innerHeight) < 600;
  let pref = ''; try { pref = String(localStorage.getItem('crix_gfx') || ''); } catch (e) {}
  if (pref === 'off') return;   // sin CrixGFX el juego usa sus materiales y luces de siempre
  const QUALITY = (pref === 'low' || pref === 'high' || pref === 'ultra') ? pref : (mobile ? 'low' : 'high');
  // Flujo de color correcto: salida sRGB (sin tone mapping, para respetar los colores), con todos los colores de entrada convertidos a lineal.
  // Los materiales "viejos" (Basic/Phong/Lambert/Points/Sprite, p. ej. los del avatar) se parchean más abajo para convertir
  // solos lo que se les asigna: sus archivos no se tocan y sus colores se ven igual que se eligieron.
  // Para volver al aspecto anterior: localStorage.setItem('crix_gfx','off') y recargar.
  const SRGB = true;
  const Q = { srgb: SRGB, quality: QUALITY, clouds: true, bump: QUALITY !== 'low', physical: QUALITY !== 'low', env: true, anisotropy: QUALITY === 'ultra' ? 16 : QUALITY === 'high' ? 8 : 2 };

  // ── Color ────────────────────────────────────────────────────────────────────────────────────
  // Los colores del juego están escritos en sRGB (#rrggbb). Con salida sRGB, los materiales necesitan color lineal.
  // La niebla y el fondo NO se convierten: Three r128 los mezcla después de codificar la imagen.
  const lin = c => { const k = c && c.isColor ? c.clone() : new T.Color(c); return SRGB ? k.convertSRGBToLinear() : k; };
  const roughFromShine = s => Math.max(0.04, Math.min(1, 1 - 0.85 * Math.min(1, Math.sqrt(Math.max(0, s) / 150))));

  // Color "de entrada sRGB": al asignarle un valor (hex, nombre, css) lo guarda ya en lineal. Copiar de otro Color no convierte.
  class SColor extends T.Color {
    // Un THREE.Color común (p. ej. new THREE.Color('#8b5a2b') que le pasa el código del juego) está escrito en sRGB: se convierte.
    set(v) { if (v && v.isColor && !(v instanceof SColor)) { this.copy(v); return this.convertSRGBToLinear(); } return super.set(v); }
    setHex(h) { super.setHex(h); if (!this._in) this.convertSRGBToLinear(); return this; }
    setStyle(st) { this._in = true; try { super.setStyle(st); } finally { this._in = false; } return this.convertSRGBToLinear(); }
  }
  function patchColor(proto, key) {
    if (!proto) return; const k = '__' + key;
    Object.defineProperty(proto, key, { configurable: true, enumerable: true,
      get() { return this[k]; },
      set(v) { if (!v || v instanceof SColor) { this[k] = v; return; } const c = new SColor(); c.r = v.r; c.g = v.g; c.b = v.b; this[k] = c.convertSRGBToLinear(); } });
  }
  if (SRGB) {
    ['MeshBasicMaterial', 'MeshPhongMaterial', 'MeshLambertMaterial', 'PointsMaterial', 'SpriteMaterial', 'LineBasicMaterial'].forEach(n => patchColor(T[n] && T[n].prototype, 'color'));
    ['MeshPhongMaterial', 'MeshLambertMaterial'].forEach(n => patchColor(T[n] && T[n].prototype, 'emissive'));
    // Lo que no tiene luz (ojos, sangre, gizmos, etiquetas) no pasa por el tone mapping: se ve del color exacto.
    ['MeshBasicMaterial', 'SpriteMaterial'].forEach(n => { const pr = T[n] && T[n].prototype; if (pr) Object.defineProperty(pr, 'toneMapped', { configurable: true, enumerable: true, get() { return false; }, set() {} }); });
  }
  function basic(params) { return new T.MeshBasicMaterial(params || {}); }   // la conversión de color la hace el parche de arriba
  function std(params) {            // reemplazo PBR de MeshPhongMaterial ({color, shininess, opacity, emissive…})
    const p = Object.assign({}, params || {});
    if (p.shininess !== undefined) { if (p.roughness === undefined) p.roughness = roughFromShine(p.shininess); delete p.shininess; }
    delete p.specular;
    const emissive = p.emissive; delete p.emissive;
    const ctor = (p.clearcoat !== undefined && Q.physical) ? T.MeshPhysicalMaterial : T.MeshStandardMaterial;
    if (ctor === T.MeshStandardMaterial) { delete p.clearcoat; delete p.clearcoatRoughness; }
    const m = new ctor(p);
    if (SRGB) m.color.convertSRGBToLinear();
    if (emissive !== undefined) m.emissive = lin(emissive);
    return m;
  }
  function tex(t, srgb) {           // textura de color: se decodifica como sRGB; con mipmaps y anisotropía
    if (!t) return t;
    if (SRGB && srgb !== false) t.encoding = T.sRGBEncoding;
    t.anisotropy = Q.anisotropy; t.needsUpdate = true; return t;
  }

  // ── Renderer ─────────────────────────────────────────────────────────────────────────────────
  function setupRenderer(r, o) {
    o = o || {};
    if (SRGB) { r.outputEncoding = T.sRGBEncoding; r.toneMapping = T.NoToneMapping; r.toneMappingExposure = 1; }   // sin ACES: no desplaza los tonos (el marrón sigue siendo marrón)
    if (r.shadowMap) { r.shadowMap.enabled = true; r.shadowMap.type = T.PCFSoftShadowMap; }
    Q.maxAniso = Math.min(Q.anisotropy, r.capabilities && r.capabilities.getMaxAnisotropy ? r.capabilities.getMaxAnisotropy() : 4);
    Q.anisotropy = Q.maxAniso || Q.anisotropy;
    return r;
  }

  // ── Cielo ────────────────────────────────────────────────────────────────────────────────────
  const SKY_VERT = 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const SKY_FRAG = [
    'uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSunDir; uniform vec3 uSunCol;',
    'uniform float uExposure; uniform float uSunBoost; uniform float uTime; uniform float uCloudAmt; varying vec3 vDir;',
    'float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }',
    '#ifndef CLOUD_OCT\n#define CLOUD_OCT 5\n#endif\nfloat fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < CLOUD_OCT; i++) { s += a * vnoise(p); p = p * 2.03 + 17.0; a *= 0.5; } return s; }',
    'void main(){',
    '  vec3 d = normalize(vDir); float h = d.y;',
    '  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.42));',
    '  col = mix(col, uGround, 1.0 - smoothstep(-0.18, 0.0, h));',
    '  vec3 sd3 = normalize(uSunDir); float sd = max(dot(d, sd3), 0.0);',
    '  float haze = pow(sd, 5.0) * (1.0 - clamp(h, 0.0, 1.0) * 0.6);',
    '  col += uSunCol * (haze * 0.16 + pow(sd, 48.0) * 0.38 + pow(sd, 3500.0) * uSunBoost);',
    '#ifdef CLOUDS',
    '  if (h > 0.02) {',
    '    vec2 uv = d.xz / (h + 0.2) * 0.5 + vec2(uTime * 0.03, uTime * 0.011);',
    '    float n = fbm(uv * 1.6);',
    '    float dens = smoothstep(0.5 - uCloudAmt * 0.14, 0.82, n);',
    '    if (dens > 0.001) {',
    '      vec2 sdir = normalize(sd3.xz + 1e-4) * (0.35 - 0.2 * sd3.y);',
    '      float nl = fbm((uv + sdir * 0.12) * 1.6);',
    '      float shade = clamp(1.0 - (nl - n) * 7.0 - 0.12, 0.0, 1.0);',
    '      float thick = smoothstep(0.55, 0.9, n);',
    '      vec3 lit = uSunCol * (0.85 + 0.3 * sd3.y);',
    '      vec3 base = mix(uHorizon, uZenith, 0.55) * 0.9 + vec3(0.12);',
    '      vec3 cc = mix(base * (0.5 - 0.14 * thick), lit, shade * (1.0 - 0.55 * thick));',
    '      cc += uSunCol * pow(sd, 6.0) * (1.0 - dens) * 0.55;',
    '      float fade = smoothstep(0.02, 0.28, h);',
    '      col = mix(col, cc, dens * fade * 0.96);',
    '    }',
    '  }',
    '#endif',
    '  gl_FragColor = vec4(col * uExposure, 1.0);',
    '#include <encodings_fragment>',
    '}'
  ].join('\n');
  function skyMaterial(clouds) {
    const m = new T.ShaderMaterial({
      uniforms: { uZenith: { value: new T.Color() }, uHorizon: { value: new T.Color() }, uGround: { value: new T.Color() }, uSunDir: { value: new T.Vector3(0, 1, 0) }, uSunCol: { value: new T.Color(1, 1, 1) },
        uExposure: { value: 1 }, uSunBoost: { value: 30 }, uTime: { value: 0 }, uCloudAmt: { value: 0.5 } },
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: T.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false
    });
    if (clouds) m.defines = { CLOUDS: 1, CLOUD_OCT: Q.quality === 'low' ? 3 : 5 };
    return m;
  }
  const SKY_GEO = new T.SphereGeometry(1, clampSeg(32), clampSeg(18));
  function clampSeg(n) { return Q.quality === 'low' ? Math.round(n * 0.6) : n; }
  function sky(clouds) { const m = new T.Mesh(SKY_GEO, skyMaterial(clouds)); m.frustumCulled = false; m.renderOrder = -1000; m.matrixAutoUpdate = true; return m; }

  function skyParams(L) {
    const fog = new T.Color(L.fogColor || '#87ceeb'), horizon = lin(fog);   // el horizonte coincide con la niebla
    const el = Math.max(2, Math.min(89, Number(L.sunElevation) || 55)) * Math.PI / 180, az = (Number(L.sunAzimuth) || 0) * Math.PI / 180;
    const sunDir = new T.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    const day = Math.max(0, Math.min(1, (el * 180 / Math.PI - 4) / 26));
    const warm = Math.max(0, Math.min(1, (28 - el * 180 / Math.PI) / 28));
    const zenith = horizon.clone().multiply(new T.Color(0.34, 0.5, 0.95)).multiplyScalar(0.55 + 0.45 * day);
    const ground = horizon.clone().multiplyScalar(0.42);
    const sunCol = new T.Color(1, 0.96 - 0.3 * warm, 0.9 - 0.55 * warm);
    const B = Math.max(0, Number(L.brightness));
    return { horizon, zenith, ground, sunDir, sunCol, day, B: Number.isFinite(B) ? B : 1 };
  }
  function applySky(mesh, P, boost, exposure) {
    const u = mesh.material.uniforms;
    u.uHorizon.value.copy(P.horizon); u.uZenith.value.copy(P.zenith); u.uGround.value.copy(P.ground);
    u.uSunDir.value.copy(P.sunDir); u.uSunCol.value.copy(P.sunCol); u.uSunBoost.value = boost; u.uExposure.value = exposure;
  }

  // ── Entorno (IBL) ────────────────────────────────────────────────────────────────────────────
  // Convierte el cielo en un mapa de entorno filtrado: da luz ambiental suave con el color del cielo y reflejos reales.
  function applyScene(scene, L, renderer, opts) {
    if (!scene || !L) return;
    const st = scene.userData._gfx || (scene.userData._gfx = {});
    renderer = renderer || st.renderer; if (renderer) st.renderer = renderer;
    const P = skyParams(L);
    // Cielo visible (sigue a la cámara); opts.sky === false lo omite (fondos transparentes, p. ej. la vista previa del avatar)
    if (opts && opts.sky === false) { /* solo entorno */ } else if (!st.sky) {
      st.sky = sky(Q.clouds);
      st.sky.onBeforeRender = function (r, s, cam) {
        this.position.copy(cam.position); const k = Math.max(10, Math.min(400, (cam.far || 500) * 0.8)); this.scale.set(k, k, k);
        this.material.uniforms.uTime.value = performance.now() / 1000;
      };
      scene.add(st.sky);
    } else if (!st.sky.parent) scene.add(st.sky);
    if (st.sky) applySky(st.sky, P, 30, 1);
    // Mapa de entorno (se regenera solo si cambió el cielo)
    if (!Q.env || !renderer || !T.PMREMGenerator || st.envFail) return;
    const key = [L.fogColor, Math.round(L.sunElevation), Math.round(L.sunAzimuth), Number(L.brightness).toFixed(2)].join('|');
    if (st.envKey === key && scene.environment) return;
    try {
      const pm = renderer.userData && renderer.userData._pmrem || (renderer.userData = renderer.userData || {}, renderer.userData._pmrem = new T.PMREMGenerator(renderer));
      const es = new T.Scene(), dome = sky(false);
      dome.scale.set(50, 50, 50);
      applySky(dome, P, 6, (0.55 + 0.45 * P.day) * P.B * 0.42);
      es.add(dome);
      const rt = pm.fromScene(es, 0.02, 1, 100);
      const old = st.envRT; scene.environment = rt.texture; st.envRT = rt; st.envKey = key;
      if (old) old.dispose();
      dome.material.dispose();
    } catch (e) { st.envFail = true; scene.environment = null; console.warn('[CrixGFX] sin reflejos de entorno:', e && e.message); }
  }
  function dispose(scene) {
    const st = scene && scene.userData && scene.userData._gfx; if (!st) return;
    if (st.envRT) st.envRT.dispose(); if (st.sky) { if (st.sky.parent) st.sky.parent.remove(st.sky); st.sky.material.dispose(); }
    scene.environment = null; scene.userData._gfx = null;
  }

  window.CrixGFX = { Q, lin, basic, std, tex, setupRenderer, applyScene, dispose, roughFromShine };
})();
