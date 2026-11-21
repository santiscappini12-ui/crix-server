'use strict';
// CrixEdit — edición de GRUPOS en el Studio. Se carga después de crix-ext.js y comparte su ámbito global (stParts, stScene, selPart…).
//
//  · Selección múltiple: Shift (o Ctrl) + clic izquierdo en el visor o el Explorador. En pantallas táctiles, el botón ☑ del visor.
//  · Un Model se selecciona ENTERO al tocar cualquiera de sus piezas (y se mueve/gira entero). Las piezas sueltas de un Folder se
//    seleccionan de una en una: el Folder solo organiza. Alt + clic entra a la pieza de un Model; en el Explorador siempre se elige lo que tocás.
//  · Model y Folder son genéricos (no solo personajes), se anidan entre sí y se arman con cualquier selección. Agrupar NO suelda nada:
//    cada pieza conserva su física. Para unir piezas se pone una unión (Weld, WeldConstraint, Motor6D…) dentro del Model.
//  · ⬡ Unir / ➖ Restar / ◐ Negar: unión de piezas como en Roblox (CSG). Las negativas se restan al unir. El resultado es una malla.
(function () {
  const X = window.CrixExt, J = window.CrixJoints, O = window.CrixObjects, CSG = window.CrixCSG;
  if (!X || !J || !O) return;
  const S = X.state;
  const FX_CLASSES = ['PointLight', 'SpotLight', 'SurfaceLight', 'ParticleEmitter', 'Fire', 'Smoke', 'Sparkles'];
  let _n = 0; const uid = p => p + Date.now().toString(36) + (++_n).toString(36) + Math.floor(Math.random() * 1e3).toString(36);
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const enc = encodeURIComponent, dec = decodeURIComponent;
  const toast = t => { if (typeof showToast === 'function') showToast(t); };
  const E = { units: [], pivot: null, helpers: [], pend: null, multi: false, busy: false };

  // ── Árbol de datos ──────────────────────────────────────────────────────────
  const entryById = id => stParts.find(e => e.data.id === id);
  const inst = id => S.instances.find(i => i.id === id);
  const isGroup = i => !!i && (i.class === 'Model' || i.class === 'Folder');
  function descParts(id, seen) {                         // todas las piezas dentro de un Model/Folder (a cualquier profundidad)
    seen = seen || new Set(); if (seen.has(id)) return []; seen.add(id);
    const out = stParts.filter(e => e.data.parent === id);
    for (const c of S.instances) if (c.parent === id && isGroup(c)) out.push(...descParts(c.id, seen));
    return out;
  }
  function descInstances(id) {                           // instancias que cuelgan (directa o indirectamente) de un grupo
    const out = [], seen = new Set([id]); let grew = true;
    while (grew) { grew = false; for (const i of S.instances) if (!seen.has(i.id) && seen.has(i.parent)) { seen.add(i.id); out.push(i); grew = true; } }
    return out;
  }
  const unitParts = u => u.k === 'part' ? [entryById(u.id)].filter(Boolean) : descParts(u.id);
  function allParts() { const seen = new Set(), out = []; for (const u of E.units) for (const e of unitParts(u)) if (!seen.has(e.data.id)) { seen.add(e.data.id); out.push(e); } return out; }
  const valid = u => u.k === 'part' ? !!entryById(u.id) : isGroup(inst(u.id));
  // Model más externo (subiendo solo por Models; un Folder corta) al que pertenece una pieza.
  function topModelOf(entry) { let cur = inst(entry.data.parent), top = null, guard = 0; while (cur && cur.class === 'Model' && guard++ < 50) { top = cur; cur = inst(cur.parent); } return top; }
  function nearestModelOf(entry) { let cur = inst(entry.data.parent), guard = 0; while (cur && guard++ < 50) { if (cur.class === 'Model') return cur; cur = inst(cur.parent); } return null; }
  const parentOfUnit = u => u.k === 'part' ? ((entryById(u.id) || { data: {} }).data.parent || '') : ((inst(u.id) || {}).parent || '');
  function commonParent(units) { const ps = units.map(parentOfUnit); return ps.length && ps.every(p => p === ps[0]) && inst(ps[0]) ? ps[0] : ''; }
  const sameUnit = (a, b) => a.k === b.k && a.id === b.id;
  function rebuildFx() { try { const fx = S.fx; if (fx) fx.build(S.instances.filter(i => FX_CLASSES.includes(i.class)), id => { const e = entryById(id); return e && e.mesh; }); } catch (_) { /* sin efectos */ } }
  function remesh(e) { if (e.data.isNPC) return; stScene.remove(e.mesh); e.mesh = makeMesh(e.data); stScene.add(e.mesh); }

  // ── Selección ───────────────────────────────────────────────────────────────
  const groupActive = () => E.units.length > 1 || (E.units.length === 1 && E.units[0].k === 'model');
  function clearHelpers() { for (const h of E.helpers) { stScene.remove(h.obj); try { h.obj.geometry.dispose(); } catch (_) { /* ya liberada */ } } E.helpers = []; }
  function boxOf(parts) { const b = new THREE.Box3(); for (const e of parts) { e.mesh.updateMatrixWorld(true); b.expandByObject(e.mesh); } return b; }
  function makeHelpers() {
    clearHelpers(); if (!groupActive()) return;
    for (const u of E.units) {
      const parts = unitParts(u); if (!parts.length) continue;
      const obj = new THREE.Box3Helper(boxOf(parts), u.k === 'model' ? 0x62d6a6 : 0x5b8def);
      obj.renderOrder = 998; try { obj.material.depthTest = false; } catch (_) { /* r128 */ }
      stScene.add(obj); E.helpers.push({ u, obj });
    }
  }
  function updateHelpers() { for (const h of E.helpers) { const parts = unitParts(h.u); if (parts.length) { h.obj.box.copy(boxOf(parts)); } } }
  function pivotFor(parts) {
    const u0 = E.units[0]; if (u0 && u0.k === 'model') { const m = inst(u0.id), pp = m && m.props && entryById(m.props.primaryPart); if (pp && parts.includes(pp)) return pp; }
    return parts[0] || null;
  }
  function apply() {
    E.units = E.units.filter(valid); E.busy = true;
    try {
      clearHelpers();
      if (!E.units.length) { E.pivot = null; deselect(); }
      else if (E.units.length === 1 && E.units[0].k === 'part') { const en = entryById(E.units[0].id); E.pivot = en; selectPart(en); }
      else {
        const parts = allParts(), u0 = E.units[0];
        if (E.units.length === 1 && u0.k === 'model') { X.select('inst', u0.id); } else deselect();
        E.pivot = pivotFor(parts);
        if (E.pivot) { selPart = E.pivot; buildGizmo(E.pivot); }
        makeHelpers();
        if (E.units.length > 1) renderGroupPanel();
        refreshExplorer();
      }
    } finally { E.busy = false; }
    updateBar();
  }
  function setUnits(list) { E.units = list; apply(); }
  function toggleUnit(u) { const i = E.units.findIndex(x => sameUnit(x, u)); if (i >= 0) E.units.splice(i, 1); else E.units.push(u); apply(); }
  // Qué se selecciona al tocar una pieza en el visor: su Model entero (o ella sola si no está en un Model / se usa Alt).
  function pickUnit(entry, alt) { if (alt) return { k: 'part', id: entry.data.id }; const m = topModelOf(entry); return m ? { k: 'model', id: m.id } : { k: 'part', id: entry.data.id }; }

  function pickEntryAt(cx, cy) {
    const wrap = document.getElementById('stu-canvas-wrap'); if (!wrap) return null;
    const rect = wrap.getBoundingClientRect(), mouse = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1), ray = new THREE.Raycaster();
    ray.setFromCamera(mouse, stCamera);
    const meshes = stParts.filter(p => !p.data.locked).map(p => p.mesh).filter(Boolean), hits = ray.intersectObjects(meshes, true);
    if (!hits.length) return null;
    const root = hits[0].object.userData.studioRoot || hits[0].object;
    return stParts.find(p => p.mesh === root || p.mesh === hits[0].object) || null;
  }

  // ── Panel de grupo ──────────────────────────────────────────────────────────
  function renderGroupPanel() {
    const body = document.getElementById('props-body'); if (!body) return;
    const parts = allParts(), names = E.units.map(u => u.k === 'model' ? '🗂 ' + esc((inst(u.id) || {}).name) : (typeIcon(entryById(u.id).data.type) + ' ' + esc(entryById(u.id).data.name)));
    body.innerHTML = `<div style="padding:10px 12px;font-size:12px;color:var(--text2)"><b>${E.units.length}</b> seleccionados · ${parts.length} pieza(s)</div>
      <div style="padding:0 12px 8px;font-size:11px;color:var(--text3);line-height:1.7">${names.slice(0, 12).join('<br>')}${names.length > 12 ? '<br>…' : ''}</div>
      <div style="padding:6px 12px;font-size:10px;color:var(--text3);line-height:1.6">Usá la barra de abajo del visor: agrupar en Model/Folder, unir, restar, soldar… Agrupar <b>no</b> suelda: cada pieza sigue con su física. La primera que elegiste es la Part0 de las uniones.</div>`;
  }

  // ── Barra de acciones (sobre el visor) ──────────────────────────────────────
  function ensureBar() {
    const wrap = document.getElementById('stu-canvas-wrap'); if (!wrap || document.getElementById('ce-bar')) return;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    const b = (a, label, title) => `<button class="st-btn" style="padding:4px 8px;font-size:11px" title="${esc(title)}" onclick="CrixEdit.act('${a}')">${label}</button>`;
    const bar = document.createElement('div'); bar.id = 'ce-bar';
    bar.style.cssText = 'position:absolute;left:6px;right:6px;bottom:6px;display:none;justify-content:center;z-index:30;pointer-events:none';
    bar.innerHTML = `<div style="pointer-events:auto;display:flex;flex-wrap:wrap;gap:4px;justify-content:center;background:rgba(10,12,20,.9);border:1px solid var(--border,#2a3350);border-radius:12px;padding:6px;max-width:100%">
      <span id="ce-count" style="font-size:11px;color:var(--text2);align-self:center;padding:0 6px"></span>
      ${b('model', '🗂 Model', 'Agrupar la selección en un Model (NO suelda las piezas)')}${b('folder', '📁 Folder', 'Agrupar en un Folder (organiza; las piezas se seleccionan de a una)')}${b('out', '⤴ Sacar', 'Sacar del grupo al nivel de arriba')}${b('ungroup', '⤓ Desagrupar', 'Deshacer el Model/Folder (los hijos quedan donde estaba)')}
      ${b('union', '⬡ Unir', 'Une las piezas en una sola malla; las negativas (◐) se restan')}${b('subtract', '➖ Restar', 'La primera pieza menos todas las demás')}${b('negate', '◐ Negar', 'Marca como negativa (se resta al unir) / vuelve a normal')}
      ${b('Weld', '🔗 Weld', 'Weld entre la 1ª pieza (Part0) y las demás')}${b('WeldConstraint', '🧷 WeldC', 'WeldConstraint entre la 1ª pieza y las demás')}${b('Motor6D', '⚙ Motor6D', 'Motor6D (articulación animable) entre la 1ª pieza y las demás')}
      <select id="ce-joint" class="prop-inp" style="width:auto;padding:3px 4px;font-size:11px" onchange="if(this.value){CrixEdit.act(this.value);this.value=''}"><option value="">Otra unión…</option>${['Hinge', 'BallSocket', 'Prismatic', 'Rod', 'Rope', 'Spring'].map(c => `<option>${c}</option>`).join('')}</select>
      ${b('dup', '⧉', 'Duplicar')}${b('del', '✕', 'Borrar')}</div>`;
    wrap.appendChild(bar);
    const mt = document.createElement('button'); mt.id = 'ce-multi'; mt.className = 'st-btn'; mt.title = 'Selección múltiple: cada toque suma o quita (en PC: Shift o Ctrl + clic izquierdo)';
    mt.style.cssText = 'position:absolute;left:6px;top:6px;z-index:30;padding:4px 8px;font-size:11px;opacity:.85'; mt.textContent = '☑ Multi';
    mt.onclick = () => { E.multi = !E.multi; mt.style.background = E.multi ? '#2a3a7a' : ''; mt.style.borderColor = E.multi ? '#5b8def' : ''; mt.textContent = E.multi ? '☑ Multi: SÍ' : '☑ Multi'; };
    wrap.appendChild(mt);
  }
  function selectedGroupInst() { const s = S.sel; return s && s.kind === 'inst' && isGroup(inst(s.id)) ? inst(s.id) : null; }
  function updateBar() {
    ensureBar(); const bar = document.getElementById('ce-bar'); if (!bar) return;
    const n = E.units.length, g = selectedGroupInst();
    bar.style.display = n || g ? 'flex' : 'none';
    const c = document.getElementById('ce-count'); if (c) c.textContent = n ? (n === 1 ? (E.units[0].k === 'model' ? '🗂 Model' : '1 pieza') : n + ' seleccionados') : g ? (g.class === 'Folder' ? '📁 ' : '🗂 ') + g.name : '';
  }

  // ── Acciones ────────────────────────────────────────────────────────────────
  const history = () => { if (typeof recordStudioHistory === 'function') recordStudioHistory(); };
  function groupInto(cls) {
    if (!E.units.length) return toast('Seleccioná algo primero (Shift + clic izquierdo para varios)');
    history();
    const parent = commonParent(E.units), parts = allParts();
    const g = O.sanitizeInstance({ class: cls, name: cls, id: uid('m'), parent, props: {} });
    if (cls === 'Model' && parts[0]) g.props.primaryPart = parts[0].data.id;
    S.instances.push(g);
    for (const u of E.units) { if (u.k === 'part') { const e = entryById(u.id); if (e) e.data.parent = g.id; } else { const i = inst(u.id); if (i) i.parent = g.id; } }
    S.open.add(g.id); if (parent) S.open.add(parent);
    if (cls === 'Model') { setUnits([{ k: 'model', id: g.id }]); toast('🗂 Model creado. Las piezas NO quedan soldadas: ponele uniones (🔗 ⚙) si querés que se muevan juntas'); }
    else { E.units = []; X.select('inst', g.id); toast('📁 Folder creado'); }
    refreshExplorer(); updateBar();
  }
  function releaseChildren(g) {                          // los hijos de un grupo pasan al padre del grupo
    const up = g.parent || '';
    for (const e of stParts) if (e.data.parent === g.id) { if (up) e.data.parent = up; else delete e.data.parent; }
    for (const i of S.instances) if (i.parent === g.id) i.parent = up;
    for (const j of S.joints) if (j.parent === g.id) { if (up) j.parent = up; else delete j.parent; }
  }
  function ungroup() {
    const targets = E.units.filter(u => u.k === 'model').map(u => inst(u.id)); const g = selectedGroupInst(); if (g && !targets.includes(g)) targets.push(g);
    if (!targets.length) return toast('Seleccioná un Model o un Folder para desagrupar');
    history();
    for (const t of targets) { releaseChildren(t); S.instances = S.instances.filter(i => i !== t); }
    E.units = []; deselect(); refreshExplorer(); toast('Desagrupado (las piezas siguen con sus uniones)');
  }
  function takeOut() {
    if (!E.units.length) return toast('Seleccioná algo primero'); history(); let n = 0;
    for (const u of E.units) {
      const p = inst(parentOfUnit(u)); if (!p) continue; const up = p.parent || ''; n++;
      if (u.k === 'part') { const e = entryById(u.id); if (up) e.data.parent = up; else delete e.data.parent; } else inst(u.id).parent = up;
    }
    refreshExplorer(); toast(n ? 'Sacado del grupo' : 'No estaba dentro de ningún grupo');
  }
  function b64(f32) { const b = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
  function toggleNegate() {
    const parts = allParts().filter(e => !e.data.isNPC && !e.data.avatarMesh); if (!parts.length) return toast('Seleccioná piezas');
    history(); const on = !parts.every(e => e.data.negate);
    for (const e of parts) {
      const d = e.data;
      if (on) { d._neg = { color: d.color, transparent: d.transparent || 0, canCollide: d.canCollide !== false }; d.negate = true; d.color = '#ff4d4d'; d.transparent = 0.55; d.canCollide = false; }
      else { const p = d._neg || {}; d.negate = false; d.color = p.color || '#a3a2a5'; d.transparent = p.transparent || 0; d.canCollide = p.canCollide !== false; delete d._neg; }
      remesh(e);
    }
    apply(); toast(on ? '◐ Piezas negativas: al unir se restan' : 'Piezas normales otra vez');
  }
  function doUnion(mode) {
    if (!CSG) return toast('Falta crix-csg.js');
    const parts = allParts().filter(e => !e.data.avatarMesh && !e.data.isNPC && e.data.type !== 'Spawn');
    if (parts.length < 2) return toast('Elegí 2 o más piezas (Shift + clic izquierdo)');
    const items = parts.map((e, i) => ({ e, negate: mode === 'subtract' ? i > 0 : !!e.data.negate }));
    let res; try { res = CSG.combine(items.map(it => ({ polys: CSG.polysFromMesh(THREE, it.e.mesh), negate: it.negate }))); } catch (err) { return toast('⬡ No se pudo unir: ' + (err && err.message || err)); }
    if (res.error) return toast('⬡ ' + res.error);
    history();
    const pm = CSG.toPartMesh(CSG.toPositions(res.polys)), base = (items.find(i => !i.negate) || items[0]).e.data;
    const parent = commonParent(E.units.length ? E.units.filter(u => u.k === 'part' || true) : []) || '';
    const ids = new Set(parts.map(e => e.data.id)), uidNew = uid('u');
    const d = { id: uidNew, name: 'Union', type: 'ImportedMesh', x: pm.center[0], y: pm.center[1], z: pm.center[2], rx: 0, ry: 0, rz: 0, sx: pm.size[0], sy: pm.size[1], sz: pm.size[2], meshData: b64(pm.positions),
      color: base.color || '#a3a2a5', material: base.material || 'SmoothPlastic', anchored: base.anchored !== false, canCollide: true, transparent: base.transparent || 0 };
    if (base.textureId) { d.textureId = base.textureId; d.texScale = base.texScale; d.texTint = base.texTint; }
    if (parent) d.parent = parent; else { const m = nearestModelOf(parts[0]); if (m && parts.every(e => nearestModelOf(e) === m)) d.parent = parts[0].data.parent; }
    for (const e of parts) stScene.remove(e.mesh);
    stParts = stParts.filter(e => !ids.has(e.data.id));
    const before = S.joints.length; S.joints = S.joints.filter(j => !ids.has(j.part0) && !ids.has(j.part1));
    for (const i of S.instances) if (ids.has(i.parent)) i.parent = uidNew;   // luces/efectos que estaban en las piezas pasan a la unión
    for (const m of S.instances) if (m.class === 'Model' && ids.has(m.props.primaryPart)) m.props.primaryPart = uidNew;
    addPartMesh(d); rebuildFx();
    E.units = [{ k: 'part', id: uidNew }]; apply(); refreshExplorer(); if (typeof updateStStatus === 'function') updateStStatus();
    toast('⬡ Unión creada (' + res.triangles + ' triángulos). Colisiona como su caja envolvente' + (before !== S.joints.length ? ' · se quitaron ' + (before - S.joints.length) + ' unión(es) de las piezas originales' : ''));
  }
  function addJoint(cls) {
    const parts = allParts(); if (parts.length < 2) return toast('Elegí 2 o más piezas con Shift + clic izquierdo: la primera es Part0');
    history(); const base = parts[0], models = parts.map(e => nearestModelOf(e)), model = models[0] && models.every(m => m && m.id === models[0].id) ? models[0] : null;
    let n = 0, last = null;
    for (const p of parts.slice(1)) {
      const id = uid('j'), j = J.sanitize({ class: cls, name: cls, part0: base.data.id, part1: p.data.id, id }, id);
      if (model) j.parent = model.id;
      if (['Weld', 'WeldConstraint', 'Motor6D', 'Hinge', 'BallSocket', 'Prismatic'].includes(cls)) { J.preserve(j, base.data, p.data); if (cls === 'Prismatic') j.position = 0; j.angle = 0; }
      else { const dist = Math.hypot(p.data.x - base.data.x, p.data.y - base.data.y, p.data.z - base.data.z); if (cls === 'Spring') j.freeLength = +dist.toFixed(2); else j.length = Math.max(0.1, +dist.toFixed(2)); }
      S.joints.push(j); n++; last = j;
    }
    if (model) S.open.add(model.id);
    refreshExplorer(); toast((O.ICONS[cls] || '🔗') + ' ' + n + ' ' + cls + ' creada(s) · Part0 = «' + base.data.name + '»' + (model ? ' · dentro del Model «' + model.name + '»' : ' · fuera de Model (agrupá para ordenarlas)'));
    return last;
  }
  function deleteUnits() {
    const g = selectedGroupInst();
    if (!E.units.length && g) { const parts = descParts(g.id); if (parts.length && !confirm('¿Borrar «' + g.name + '» y sus ' + parts.length + ' piezas?')) return; E.units = [{ k: 'model', id: g.id }]; }
    if (!E.units.length) return toast('Seleccioná algo primero');
    const mods = E.units.filter(u => u.k === 'model'), parts = allParts();
    if (mods.length && !confirm('¿Borrar ' + mods.length + ' grupo(s) con ' + parts.length + ' pieza(s)?')) return;
    history(); const ids = new Set(parts.map(e => e.data.id)), gone = new Set();
    for (const u of mods) { gone.add(u.id); for (const i of descInstances(u.id)) gone.add(i.id); }
    for (const e of parts) stScene.remove(e.mesh);
    stParts = stParts.filter(e => !ids.has(e.data.id));
    S.instances = S.instances.filter(i => !gone.has(i.id) && !ids.has(i.parent));
    S.joints = S.joints.filter(j => !gone.has(j.parent) && !ids.has(j.part0) && !ids.has(j.part1));
    E.units = []; deselect(); rebuildFx(); refreshExplorer(); if (typeof updateStStatus === 'function') updateStStatus();
  }
  function duplicateUnits() {
    if (!E.units.length) return toast('Seleccioná algo primero'); history(); const out = [], off = 2;
    for (const u of E.units) {
      if (u.k === 'part') { const e = entryById(u.id); if (!e) continue; const d = { ...e.data, id: uid('p'), x: e.data.x + off, z: e.data.z + off }; addPartMesh(d); out.push({ k: 'part', id: d.id }); continue; }
      const root = inst(u.id); if (!root) continue; const map = new Map(), gather = [root, ...descInstances(root.id)], parts = descParts(root.id);
      for (const g of gather) map.set(g.id, uid('m')); for (const e of parts) map.set(e.data.id, uid('p'));
      for (const g of gather) {
        const c = JSON.parse(JSON.stringify(g)); c.id = map.get(g.id); c.parent = g === root ? root.parent : (map.get(g.parent) || g.parent);
        if (c.props && c.props.primaryPart) c.props.primaryPart = map.get(c.props.primaryPart) || c.props.primaryPart;
        S.instances.push(O.sanitizeInstance(c, c.id));
      }
      for (const e of parts) addPartMesh({ ...e.data, id: map.get(e.data.id), parent: map.get(e.data.parent) || e.data.parent, x: e.data.x + off, z: e.data.z + off });
      for (const j of S.joints.slice()) if (map.has(j.parent) || (map.has(j.part0) && map.has(j.part1))) { const id = uid('j'); S.joints.push(J.sanitize({ ...j, id, part0: map.get(j.part0) || j.part0, part1: map.get(j.part1) || j.part1, parent: map.get(j.parent) || j.parent }, id)); }
      S.open.add(map.get(root.id)); out.push({ k: 'model', id: map.get(root.id) });
    }
    rebuildFx(); setUnits(out); refreshExplorer(); if (typeof updateStStatus === 'function') updateStStatus();
  }
  function act(a) {
    try {
      if (a === 'model') groupInto('Model'); else if (a === 'folder') groupInto('Folder'); else if (a === 'ungroup') ungroup(); else if (a === 'out') takeOut();
      else if (a === 'union') doUnion('union'); else if (a === 'subtract') doUnion('subtract'); else if (a === 'negate') toggleNegate();
      else if (a === 'del') deleteUnits(); else if (a === 'dup') duplicateUnits(); else if (O.isJoint(a)) addJoint(a);
    } catch (err) { toast('⚠ ' + (err && err.message || err)); if (window.CrixConsole) CrixConsole.add('error', 'Editor', String(err && err.stack || err)); }
  }

  // ── Explorador en árbol (Models y Folders anidados con sus piezas, uniones y objetos) ──
  const GI = { Model: '🗂', Folder: '📁' };
  function treeHtml(parentId, depth, q) {
    const pad = 12 + depth * 14; let h = '';
    const kids = S.instances.filter(i => isGroup(i) && (parentId ? i.parent === parentId : !inst(i.parent) || !isGroup(inst(i.parent))));
    const mine = stParts.map((e, i) => ({ e, i })).filter(({ e }) => parentId ? e.data.parent === parentId : !isGroup(inst(e.data.parent)));
    for (const g of kids) {
      const inner = treeHtml(g.id, depth + 1, q), match = !q || (g.name + ' ' + g.class).toLowerCase().includes(q);
      if (q && !match && !inner) continue;
      const open = S.open.has(g.id) || !!q, sel = E.units.some(u => u.k === 'model' && u.id === g.id) || (S.sel && S.sel.kind === 'inst' && S.sel.id === g.id);
      const n = descParts(g.id).length, idq = enc(g.id);
      h += `<div class="exp-item ${sel ? 'sel' : ''}" style="padding-left:${pad}px" onclick="CrixEdit.rowClick(event,'inst','${idq}')"><span onclick="event.stopPropagation();CrixExt.toggleModel('${esc(g.id)}')" style="cursor:pointer;display:inline-block;width:14px;font-size:9px">${open ? '▼' : '▶'}</span><span style="font-size:10px">${GI[g.class]}</span><span style="flex:1">${esc(g.name)}</span><span style="font-size:9px;color:var(--text3)">${n || ''}</span><span class="exp-ctx" onclick="event.stopPropagation();CrixEdit.delRow('inst','${idq}')">✕</span></div>`;
      if (open) h += inner;
    }
    for (const { e } of mine) {
      if (q && !(e.data.name + ' ' + e.data.type).toLowerCase().includes(q)) continue;
      const sel = E.units.some(u => u.k === 'part' && u.id === e.data.id) || (E.units.length === 0 && selPart === e), idq = enc(e.data.id);
      h += `<div class="exp-item ${sel ? 'sel' : ''}" style="padding-left:${pad + 14}px" onclick="CrixEdit.rowClick(event,'part','${idq}')"><span style="font-size:10px">${typeIcon(e.data.type)}</span><span style="flex:1">${esc(e.data.name)}</span>${e.data.negate ? '<span title="Negativa: se resta al unir" style="font-size:9px">◐</span>' : ''}${e.data.type === 'Spawn' || e.data.isNPC ? '' : (e.data.anchored !== false ? '<span title="Anclada" style="font-size:9px;opacity:.7">🔒</span>' : '<span title="Suelta: cae con la gravedad" style="font-size:9px">🔓</span>')}<span class="exp-ctx" onclick="event.stopPropagation();CrixEdit.delRow('part','${idq}')">✕</span></div>`;
    }
    if (parentId) {
      for (const j of S.joints.filter(j => j.parent === parentId)) { if (q && !(j.name + ' ' + j.class).toLowerCase().includes(q)) continue; h += `<div class="exp-item ${S.sel && S.sel.kind === 'joint' && S.sel.id === j.id ? 'sel' : ''}" style="padding-left:${pad + 14}px" onclick="CrixExt.select('joint','${esc(j.id)}')"><span style="font-size:10px">${O.ICONS[j.class] || '🔗'}</span><span style="flex:1">${esc(j.name)}</span><span style="font-size:9px;color:var(--text3)">${j.class}</span></div>`; }
      for (const c of S.instances.filter(i => i.parent === parentId && !isGroup(i))) { if (q && !(c.name + ' ' + c.class).toLowerCase().includes(q)) continue; h += `<div class="exp-item ${S.sel && S.sel.kind === 'inst' && S.sel.id === c.id ? 'sel' : ''}" style="padding-left:${pad + 14}px" onclick="CrixExt.select('inst','${esc(c.id)}')"><span style="font-size:10px">${O.ICONS[c.class] || '•'}</span><span style="flex:1">${esc(c.name)}</span></div>`; }
    }
    return h;
  }
  function workspaceTreeHtml(query) { return treeHtml('', 0, (query || '').toLowerCase()); }
  function rowClick(ev, kind, idq) {
    const id = dec(idq), multi = ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey) || E.multi;
    if (kind === 'part') { const u = { k: 'part', id }; if (multi) toggleUnit(u); else setUnits([u]); return; }
    const g = inst(id); if (!g) return;
    if (g.class === 'Folder') { if (multi) { for (const e of descParts(id)) if (!E.units.some(u => u.k === 'part' && u.id === e.data.id)) E.units.push({ k: 'part', id: e.data.id }); apply(); } else { E.units = []; X.select('inst', id); updateBar(); } return; }
    const u = { k: 'model', id }; if (multi) toggleUnit(u); else setUnits([u]);
  }
  function delRow(kind, idq) {
    const id = dec(idq); E.units = [kind === 'part' ? { k: 'part', id } : { k: 'model', id }]; deleteUnits();
  }

  // ── Ganchos sobre el editor ─────────────────────────────────────────────────
  function wrap(name, fn) { const orig = window[name]; if (typeof orig !== 'function') return; window[name] = function () { return fn(orig, arguments, this); }; }
  const qOf = d => new THREE.Quaternion().setFromEuler(new THREE.Euler(d.rx || 0, d.ry || 0, d.rz || 0, 'XYZ'));
  function install() {
    ensureBar();
    wrap('selectPart', (orig, a, t) => { if (!E.busy) { E.units = a[0] ? [{ k: 'part', id: a[0].data.id }] : []; E.pivot = a[0] || null; clearHelpers(); } const r = orig.apply(t, a); updateBar(); return r; });
    wrap('deselect', (orig, a, t) => { if (!E.busy) { E.units = []; E.pivot = null; clearHelpers(); } const r = orig.apply(t, a); updateBar(); return r; });
    wrap('renderProps', (orig, a, t) => {
      if (E.units.length > 1) { renderGroupPanel(); return; }
      if (E.units.length === 1 && E.units[0].k === 'model') { const id = E.units[0].id, keep = E.pivot; E.busy = true; try { X.select('inst', id); selPart = keep; if (keep) buildGizmo(keep); makeHelpers(); } finally { E.busy = false; } return; }
      const r = orig.apply(t, a);
      try { const body = document.getElementById('props-body'), e = a[0]; if (body && e && !e.data.isNPC) body.insertAdjacentHTML('beforeend', `<div style="padding:8px 12px"><button class="st-btn" style="width:100%" onclick="CrixEdit.act('negate')">◐ ${e.data.negate ? 'Volver a pieza normal' : 'Negar (se resta al unir)'}</button></div>`); } catch (_) { /* panel sin cuerpo */ }
      return r;
    });
    // Clic en el visor: gizmo → Model entero / pieza; con Shift, Ctrl o ☑ se suma o se quita (se decide al soltar, así Shift + arrastrar sigue moviendo la cámara)
    window.onStClick = function (e) {
      if (gizmoDragging) return;
      const wrapEl = document.getElementById('stu-canvas-wrap'), rect = wrapEl.getBoundingClientRect(), mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, stCamera);
      if (gizmoArrows.length && selPart) { const gh = ray.intersectObjects(gizmoArrows, false); if (gh.length) { recordStudioHistory(); gizmoDragging = true; gizmoAxis = gh[0].object.userData.axis; gizmoStart.copy(gh[0].point); gizmoStartRotation.set(selPart.data.rx || 0, selPart.data.ry || 0, selPart.data.rz || 0); gizmoRotationDelta = 0; gizmoLastAngle = rotationPointerAngle(gizmoAxis, gizmoStart, selPart.mesh.position); return; } }
      if (e.shiftKey || e.ctrlKey || e.metaKey || E.multi) { E.pend = { x: e.clientX, y: e.clientY, alt: e.altKey }; return; }
      const entry = pickEntryAt(e.clientX, e.clientY);
      if (!entry) { deselect(); return; }
      setUnits([pickUnit(entry, e.altKey)]);
    };
    window.addEventListener('mouseup', ev => {
      const p = E.pend; E.pend = null; if (!p || ev.button !== 0) return;
      if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 5) return;      // se arrastró: era mover la cámara
      const entry = pickEntryAt(ev.clientX, ev.clientY); if (!entry) return;
      toggleUnit(pickUnit(entry, p.alt));
    });
    window.addEventListener('mouseup', () => { if (E.units.length && groupActive()) { updateHelpers(); } });
    // Mover / girar un grupo con el gizmo: la pieza pivote manda y las demás la siguen (escalar un grupo no se permite)
    wrap('onGizmoDrag', (orig, a, t) => {
      if (!groupActive() || !selPart) return orig.apply(t, a);
      if (stTool === 'scl') { if (!E._sclWarn) { E._sclWarn = 1; toast('Escalar: seleccioná una sola pieza'); setTimeout(() => { E._sclWarn = 0; }, 3000); } return; }
      const d = selPart.data, p0 = { x: d.x, y: d.y, z: d.z }, q0 = qOf(d), r = orig.apply(t, a), others = allParts().filter(e => e !== selPart);
      if (stTool === 'mov') { const dx = d.x - p0.x, dy = d.y - p0.y, dz = d.z - p0.z; if (dx || dy || dz) for (const e of others) { e.data.x += dx; e.data.y += dy; e.data.z += dz; e.mesh.position.set(e.data.x, e.data.y, e.data.z); } }
      else if (stTool === 'rot') {
        const dq = qOf(d).multiply(q0.clone().invert());
        for (const e of others) {
          const v = new THREE.Vector3(e.data.x - p0.x, e.data.y - p0.y, e.data.z - p0.z).applyQuaternion(dq); e.data.x = p0.x + v.x; e.data.y = p0.y + v.y; e.data.z = p0.z + v.z;
          const eu = new THREE.Euler().setFromQuaternion(dq.clone().multiply(qOf(e.data)), 'XYZ'); e.data.rx = eu.x; e.data.ry = eu.y; e.data.rz = eu.z;
          e.mesh.position.set(e.data.x, e.data.y, e.data.z); e.mesh.rotation.set(e.data.rx, e.data.ry, e.data.rz);
        }
      }
      updateHelpers(); return r;
    });
    wrap('stuNudge', (orig, a, t) => { if (!groupActive()) return orig.apply(t, a); history(); const [dx, dy, dz] = [a[0] || 0, a[1] || 0, a[2] || 0]; for (const e of allParts()) { e.data.x += dx; e.data.y += dy; e.data.z += dz; e.mesh.position.set(e.data.x, e.data.y, e.data.z); } updateGizmoPos(); updateHelpers(); });
    wrap('stuDelete', (orig, a, t) => { if (groupActive() || (!selPart && selectedGroupInst())) return deleteUnits(); return orig.apply(t, a); });
    wrap('stuDuplicate', (orig, a, t) => { if (groupActive()) return duplicateUnits(); return orig.apply(t, a); });
    wrap('applyStudioSnapshot', (orig, a, t) => { const r = orig.apply(t, a); try { E.units = []; E.pivot = null; clearHelpers(); updateBar(); } catch (_) { /* nada */ } return r; });
    const loop = () => { try { if (E.helpers.length && E.units.length) updateHelpers(); } catch (_) { /* sin escena */ } requestAnimationFrame(loop); }; requestAnimationFrame(loop);
  }
  // Se instala DESPUÉS de CrixExt.init (que registró su DOMContentLoaded antes) para quedar como envoltura más externa.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else setTimeout(install, 0);

  window.CrixEdit = { act, rowClick, delRow, workspaceTreeHtml, setUnits, toggleNegate, state: E };
})();
