'use strict';
// CrixCSG — unión y resta de piezas (como «Union» y «Negate» de Roblox Studio), sin dependencias salvo THREE para leer las mallas.
// Algoritmo BSP clásico (polígonos convexos que se parten contra el plano de otro cuerpo). Todo es geometría pura:
//   polysFromMesh(THREE, mesh)   → polígonos en coordenadas de MUNDO (aplica la posición/rotación/escala de la malla)
//   combine(items, opts)         → items: [{ polys, negate }]  ·  une todos los positivos y resta todos los negativos
//   toPositions(polys)           → Float32Array de triángulos (x,y,z,…) listo para una malla
// Los cuerpos deben ser cerrados (las piezas de Crix lo son). Límite de triángulos para que no se cuelgue el editor.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CrixCSG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const EPS = 1e-5, COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;
  const MAX_INPUT_TRIS = 6000, MAX_OUTPUT_TRIS = 20000;

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const len = a => Math.sqrt(dot(a, a));

  class Plane {
    constructor(n, w) { this.n = n; this.w = w; }
    static fromPoints(a, b, c) {
      const n = cross(sub(b, a), sub(c, a)), l = len(n); if (l < 1e-12) return null;
      const u = [n[0] / l, n[1] / l, n[2] / l]; return new Plane(u, dot(u, a));
    }
    flip() { this.n = [-this.n[0], -this.n[1], -this.n[2]]; this.w = -this.w; }
    splitPolygon(poly, coplanarFront, coplanarBack, front, back) {
      let polyType = 0; const types = [];
      for (const v of poly.v) { const t = dot(this.n, v) - this.w, ty = t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR; polyType |= ty; types.push(ty); }
      switch (polyType) {
        case COPLANAR: (dot(this.n, poly.plane.n) > 0 ? coplanarFront : coplanarBack).push(poly); break;
        case FRONT: front.push(poly); break;
        case BACK: back.push(poly); break;
        case SPANNING: {
          const f = [], b = [];
          for (let i = 0; i < poly.v.length; i++) {
            const j = (i + 1) % poly.v.length, ti = types[i], tj = types[j], vi = poly.v[i], vj = poly.v[j];
            if (ti !== BACK) f.push(vi);
            if (ti !== FRONT) b.push(ti !== BACK ? vi.slice() : vi);
            if ((ti | tj) === SPANNING) {
              const t = (this.w - dot(this.n, vi)) / dot(this.n, sub(vj, vi)), v = lerp(vi, vj, t);
              f.push(v); b.push(v.slice());
            }
          }
          if (f.length >= 3) front.push(new Polygon(f, poly.plane));
          if (b.length >= 3) back.push(new Polygon(b, poly.plane));
          break;
        }
      }
    }
  }
  class Polygon {
    constructor(v, plane) { this.v = v; this.plane = plane || Plane.fromPoints(v[0], v[1], v[2]); }
    flip() { this.v.reverse(); this.plane = new Plane(this.plane.n.slice(), this.plane.w); this.plane.flip(); }
  }
  class Node {
    constructor(polys) { this.plane = null; this.front = null; this.back = null; this.polys = []; if (polys) this.build(polys); }
    clone() { const n = new Node(); n.plane = this.plane && new Plane(this.plane.n.slice(), this.plane.w); n.front = this.front && this.front.clone(); n.back = this.back && this.back.clone(); n.polys = this.polys.map(p => new Polygon(p.v.map(v => v.slice()), new Plane(p.plane.n.slice(), p.plane.w))); return n; }
    invert() {
      for (const p of this.polys) p.flip();
      if (this.plane) this.plane.flip();
      if (this.front) this.front.invert(); if (this.back) this.back.invert();
      const t = this.front; this.front = this.back; this.back = t;
    }
    clipPolygons(polys) {
      if (!this.plane) return polys.slice();
      let front = [], back = [];
      for (const p of polys) this.plane.splitPolygon(p, front, back, front, back);
      if (this.front) front = this.front.clipPolygons(front);
      back = this.back ? this.back.clipPolygons(back) : [];
      return front.concat(back);
    }
    clipTo(bsp) { this.polys = bsp.clipPolygons(this.polys); if (this.front) this.front.clipTo(bsp); if (this.back) this.back.clipTo(bsp); }
    allPolygons() { let p = this.polys.slice(); if (this.front) p = p.concat(this.front.allPolygons()); if (this.back) p = p.concat(this.back.allPolygons()); return p; }
    build(polys) {
      if (!polys.length) return;
      if (!this.plane) this.plane = new Plane(polys[0].plane.n.slice(), polys[0].plane.w);
      const front = [], back = [];
      for (const p of polys) this.plane.splitPolygon(p, this.polys, this.polys, front, back);
      if (front.length) { if (!this.front) this.front = new Node(); this.front.build(front); }
      if (back.length) { if (!this.back) this.back = new Node(); this.back.build(back); }
    }
  }

  const union = (A, B) => { const a = new Node(A.map(clonePoly)), b = new Node(B.map(clonePoly)); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.allPolygons()); return a.allPolygons(); };
  const subtract = (A, B) => { const a = new Node(A.map(clonePoly)), b = new Node(B.map(clonePoly)); a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.allPolygons()); a.invert(); return a.allPolygons(); };
  const clonePoly = p => new Polygon(p.v.map(v => v.slice()), new Plane(p.plane.n.slice(), p.plane.w));

  // Malla de THREE → polígonos (triángulos) en coordenadas de mundo.
  function polysFromMesh(THREE, mesh) {
    mesh.updateMatrixWorld(true);
    let g = mesh.geometry; if (!g || !g.attributes || !g.attributes.position) return [];
    if (g.index) g = g.toNonIndexed();
    const pos = g.attributes.position, m = mesh.matrixWorld, out = [], v = new THREE.Vector3();
    const get = i => { v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m); return [v.x, v.y, v.z]; };
    for (let i = 0; i + 2 < pos.count; i += 3) {
      const a = get(i), b = get(i + 1), c = get(i + 2), pl = Plane.fromPoints(a, b, c);
      if (pl) out.push(new Polygon([a, b, c], pl));   // los triángulos degenerados (polos de esfera) se descartan
    }
    return out;
  }

  // items: [{ polys, negate }]. Resultado = (unión de los positivos) − (unión de los negativos). Devuelve { polys } o { error }.
  function combine(items) {
    const pos = items.filter(i => !i.negate), neg = items.filter(i => i.negate);
    if (!pos.length) return { error: 'Hace falta al menos una pieza que no sea negativa' };
    const total = items.reduce((n, i) => n + i.polys.length, 0);
    if (total > MAX_INPUT_TRIS) return { error: 'Demasiado complejo (' + total + ' triángulos, máximo ' + MAX_INPUT_TRIS + ')' };
    let acc = pos[0].polys.map(clonePoly);
    for (let i = 1; i < pos.length; i++) acc = union(acc, pos[i].polys);
    for (const n of neg) acc = subtract(acc, n.polys);
    if (!acc.length) return { error: 'El resultado quedó vacío (las piezas no se tocan o la resta se llevó todo)' };
    let tris = 0; for (const p of acc) tris += p.v.length - 2;
    if (tris > MAX_OUTPUT_TRIS) return { error: 'El resultado es demasiado complejo (' + tris + ' triángulos)' };
    return { polys: acc, triangles: tris };
  }

  // Polígonos convexos → triángulos sueltos (abanico).
  function toPositions(polys) {
    let n = 0; for (const p of polys) n += (p.v.length - 2) * 9;
    const out = new Float32Array(n); let k = 0;
    for (const p of polys) for (let i = 1; i + 1 < p.v.length; i++) for (const q of [p.v[0], p.v[i], p.v[i + 1]]) { out[k++] = q[0]; out[k++] = q[1]; out[k++] = q[2]; }
    return out;
  }

  // Triángulos de mundo → datos de pieza «ImportedMesh»: centro, tamaño de la caja envolvente y malla normalizada (la pieza la escala sx/4, sy/4, sz/4).
  function toPartMesh(positions) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], positions[i + a]); mx[a] = Math.max(mx[a], positions[i + a]); }
    const c = [0, 1, 2].map(a => (mn[a] + mx[a]) / 2), d = [0, 1, 2].map(a => Math.max(0.05, mx[a] - mn[a]));
    const out = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) out[i + a] = (positions[i + a] - c[a]) * 4 / d[a];
    return { center: c, size: d, positions: out };
  }

  return { polysFromMesh, combine, toPositions, toPartMesh, MAX_INPUT_TRIS, MAX_OUTPUT_TRIS };
});
