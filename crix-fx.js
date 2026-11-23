'use strict';
// CrixFx — luces y partículas reales para el editor y el juego (se pegan a la malla de la pieza padre).
(function () {
  const MAX_LIGHTS = 6, MAX_PARTICLES = 300;
  function create(THREE, scene) {
    let lights = [], systems = [], tmp = new THREE.Vector3(), warned = false;
    const col = (c, d) => { const k = new THREE.Color(/^#/.test(String(c)) ? c : d); return window.CrixGFX ? CrixGFX.lin(k) : k; };   // color lineal para la salida sRGB

    function clear() {
      for (const l of lights) { if (l.target && l.target.parent) l.target.parent.remove(l.target); if (l.parent) l.parent.remove(l); }
      for (const s of systems) { scene.remove(s.points); s.points.geometry.dispose(); s.points.material.dispose(); }
      lights = []; systems = [];
    }

    // instances: [{id,class,props,parent}] · meshOf(partId) → THREE.Object3D | null
    function build(instances, meshOf, report) {
      clear();
      let nLights = 0;
      for (const inst of instances || []) {
        const mesh = meshOf(inst.parent), p = inst.props || {};
        const cls = inst.class;
        if (cls === 'PointLight' || cls === 'SpotLight' || cls === 'SurfaceLight') {
          if (!mesh) { if (report) report('warn', `${cls} «${inst.name}»: su pieza padre no existe`); continue; }
          if (nLights >= MAX_LIGHTS) { if (!warned && report) { report('warn', `Hay más de ${MAX_LIGHTS} luces: las extra se ignoran para cuidar el rendimiento`); warned = true; } continue; }
          nLights++;
          const color = col(p.color, '#ffffff'), intensity = Number(p.brightness) || 1, range = Number(p.range) || 16;
          let light;
          if (cls === 'PointLight') light = new THREE.PointLight(color, intensity, range, 1);
          else { light = new THREE.SpotLight(color, intensity, range, (Number(p.angle) || 45) * Math.PI / 360, 0.4, 1); const tg = new THREE.Object3D(); tg.position.set(0, -2, 0); mesh.add(tg); light.target = tg; }
          light.visible = p.enabled !== false; light.userData.instId = inst.id;
          mesh.add(light); lights.push(light);
        } else if (cls === 'ParticleEmitter' || cls === 'Fire' || cls === 'Smoke' || cls === 'Sparkles') {
          if (!mesh) { if (report) report('warn', `${cls} «${inst.name}»: su pieza padre no existe`); continue; }
          const rate = Math.max(0, Number(p.rate) || 0), life = Math.max(0.1, Number(p.lifetime) || 1.5);
          const n = Math.min(MAX_PARTICLES, Math.ceil(rate * life) + 4);
          const geo = new THREE.BufferGeometry();
          const pos = new Float32Array(n * 3), cl = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) pos[i * 3 + 1] = -1e5;
          geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(cl, 3));
          const additive = cls !== 'Smoke';
          const mat = new THREE.PointsMaterial({ size: Math.max(0.05, Number(p.size) || 0.5), vertexColors: true, transparent: true, opacity: additive ? 0.95 : 0.55, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, sizeAttenuation: true });
          const points = new THREE.Points(geo, mat); points.frustumCulled = false; scene.add(points);
          systems.push({ inst, mesh, points, n, pos, cl, age: new Float32Array(n).fill(-1), vel: new Float32Array(n * 3), acc: 0, c1: col(p.color, '#ffaa33'), c2: col(p.color2, '#ff3300'), life, rate, p, additive });
        }
      }
    }

    function update(dt) {
      dt = Math.min(0.1, Math.max(0, dt));
      for (const s of systems) {
        const p = s.p, enabled = p.enabled !== false && s.mesh.parent !== null && s.mesh.visible !== false;
        const spread = (Number(p.spread) || 0) * Math.PI / 180, speed = Number(p.speed) || 0, accY = Number(p.acceleration) || 0;
        if (enabled) s.acc += s.rate * dt;
        let spawn = Math.floor(s.acc); s.acc -= spawn;
        for (let i = 0; i < s.n; i++) {
          if (s.age[i] < 0) {
            if (spawn <= 0) continue;
            spawn--; s.mesh.getWorldPosition(tmp);
            const a = Math.random() * Math.PI * 2, t = Math.random() * spread, sp = speed * (0.6 + Math.random() * 0.4);
            s.pos[i * 3] = tmp.x; s.pos[i * 3 + 1] = tmp.y; s.pos[i * 3 + 2] = tmp.z;
            s.vel[i * 3] = Math.sin(t) * Math.cos(a) * sp; s.vel[i * 3 + 1] = Math.cos(t) * sp; s.vel[i * 3 + 2] = Math.sin(t) * Math.sin(a) * sp;
            s.age[i] = 0;
          }
          s.age[i] += dt;
          if (s.age[i] >= s.life) { s.age[i] = -1; s.pos[i * 3 + 1] = -1e5; continue; }
          s.vel[i * 3 + 1] += accY * dt;
          s.pos[i * 3] += s.vel[i * 3] * dt; s.pos[i * 3 + 1] += s.vel[i * 3 + 1] * dt; s.pos[i * 3 + 2] += s.vel[i * 3 + 2] * dt;
          const k = s.age[i] / s.life, fade = s.additive ? 1 - k : 1;
          s.cl[i * 3] = (s.c1.r + (s.c2.r - s.c1.r) * k) * fade; s.cl[i * 3 + 1] = (s.c1.g + (s.c2.g - s.c1.g) * k) * fade; s.cl[i * 3 + 2] = (s.c1.b + (s.c2.b - s.c1.b) * k) * fade;
        }
        s.points.geometry.attributes.position.needsUpdate = true; s.points.geometry.attributes.color.needsUpdate = true;
      }
    }
    return { build, update, clear, get count() { return lights.length + systems.length; } };
  }
  window.CrixFx = { create };
})();
