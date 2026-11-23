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
  const QUALITY = (pref === 'low' || pref === 'high' || pref === 'ultra') ? pref : (mobile ? 'low' : 'high');
  const Q = { quality: QUALITY, clouds: QUALITY !== 'low', bump: QUALITY !== 'low', physical: QUALITY !== 'low', env: true, anisotropy: QUALITY === 'ultra' ? 16 : QUALITY === 'high' ? 8 : 2 };

  // ── Color ────────────────────────────────────────────────────────────────────────────────────
  // Los colores del juego están escritos en sRGB (#rrggbb). Con salida sRGB, los materiales necesitan color lineal.
  // La niebla y el fondo NO se convierten: Three r128 los mezcla después de codificar la imagen.
  const lin = c => (c && c.isColor ? c.clone() : new T.Color(c)).convertSRGBToLinear();
  const roughFromShine = s => Math.max(0.04, Math.min(1, 1 - 0.85 * Math.min(1, Math.sqrt(Math.max(0, s) / 150))));

  function basic(params) {          // material sin luz (ojos, sangre, gizmos…): mismo color en pantalla que antes
    const m = new T.MeshBasicMaterial(params || {});
    m.color.convertSRGBToLinear(); m.toneMapped = false; return m;
  }
  function std(params) {            // reemplazo PBR de MeshPhongMaterial ({color, shininess, opacity, emissive…})
    const p = Object.assign({}, params || {});
    if (p.shininess !== undefined) { if (p.roughness === undefined) p.roughness = roughFromShine(p.shininess); delete p.shininess; }
    delete p.specular;
    const emissive = p.emissive; delete p.emissive;
    const ctor = (p.clearcoat !== undefined && Q.physical) ? T.MeshPhysicalMaterial : T.MeshStandardMaterial;
    if (ctor === T.MeshStandardMaterial) { delete p.clearcoat; delete p.clearcoatRoughness; }
    const m = new ctor(p);
    m.color.convertSRGBToLinear();
    if (emissive !== undefined) m.emissive = lin(emissive);
    return m;
  }
  function tex(t, srgb) {           // textura de color: se decodifica como sRGB; con mipmaps y anisotropía
    if (!t) return t;
    if (srgb !== false) t.encoding = T.sRGBEncoding;
    t.anisotropy = Q.anisotropy; t.needsUpdate = true; return t;
  }

  // ── Renderer ─────────────────────────────────────────────────────────────────────────────────
  function setupRenderer(r, o) {
    o = o || {};
    r.outputEncoding = T.sRGBEncoding;
    r.toneMapping = T.ACESFilmicToneMapping;
    r.toneMappingExposure = o.exposure || 1.0;
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
    'float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.0; a *= 0.5; } return s; }',
    'void main(){',
    '  vec3 d = normalize(vDir); float h = d.y;',
    '  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.42));',
    '  col = mix(col, uGround, 1.0 - smoothstep(-0.18, 0.0, h));',
    '  vec3 sd3 = normalize(uSunDir); float sd = max(dot(d, sd3), 0.0);',
    '  float haze = pow(sd, 5.0) * (1.0 - clamp(h, 0.0, 1.0) * 0.6);',
    '  col += uSunCol * (haze * 0.16 + pow(sd, 48.0) * 0.38 + pow(sd, 3500.0) * uSunBoost);',
    '#ifdef CLOUDS',
    '  if (h > 0.015) {',
    '    vec2 uv = d.xz / (h + 0.22) * 0.55 + vec2(uTime * 0.004, uTime * 0.0015);',
    '    float n = fbm(uv * 1.7); float cov = smoothstep(0.47 - uCloudAmt * 0.12, 0.84, n);',
    '    float lit = clamp(0.55 + 0.45 * dot(normalize(vec3(sd3.x, 0.0, sd3.z) + 1e-4), normalize(vec3(d.x, 0.0, d.z) + 1e-4)) * 0.5 + 0.3 * sd3.y, 0.0, 1.0);',
    '    vec3 cc = mix(uHorizon * 0.55 + uZenith * 0.25, vec3(1.0) * (0.78 + 0.5 * lit) * mix(vec3(1.0), uSunCol, 0.35), lit);',
    '    col = mix(col, cc, cov * smoothstep(0.015, 0.2, h) * 0.9);',
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
    if (clouds) m.defines = { CLOUDS: 1 };
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
      applySky(dome, P, 9, (0.55 + 0.45 * P.day) * P.B);
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
