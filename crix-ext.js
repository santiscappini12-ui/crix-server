'use strict';
// CrixExt — conecta CrixJoints / CrixObjects / CrixFx con el editor (Crix Hub) y con el juego.
// Se carga al final de index.html y comparte su ámbito global (stParts, stScene, runtimeObjects, gScene, …).
(function () {
  const J = window.CrixJoints, O = window.CrixObjects;
  if (!J || !O) return;
  const S = { joints: [], instances: [], sel: null, preview: null, fx: null, open: new Set() };   // editor
  const G = { joints: [], instances: [], state: {}, vel: {}, fx: null, t: 0, driven: new Set(), used: new Set(), errors: new Set(), targets: new Map() }; // juego
  const FX_CLASSES = ['PointLight', 'SpotLight', 'SurfaceLight', 'ParticleEmitter', 'Fire', 'Smoke', 'Sparkles'];
  const log = (lvl, src, txt) => { if (window.CrixConsole) CrixConsole.add(lvl, src, txt); };
  const uid = p => p + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const esc2 = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const deg = r => ((Number(r) || 0) * 180 / Math.PI);
  const rad = d => ((Number(d) || 0) * Math.PI / 180);
  const partsDict = () => { const d = {}; for (const e of stParts) d[e.data.id] = e.data; return d; };
  const entryOf = id => stParts.find(e => e.data.id === id);

  // ═════════════════════════════ EDITOR ═════════════════════════════
  function edFx() { if (!S.fx && window.CrixFx && typeof stScene !== 'undefined') S.fx = CrixFx.create(THREE, stScene); return S.fx; }
  function rebuildEditorFx() {
    const fx = edFx(); if (!fx) return;
    fx.build(S.instances.filter(i => FX_CLASSES.includes(i.class)), id => { const e = entryOf(id); return e && e.mesh; });
  }
  function loadFromMap(m) {
    S.joints = ((m && m.joints) || []).map((j, i) => J.sanitize(j, 'joint-' + i));
    S.instances = ((m && m.instances) || []).map((x, i) => O.sanitizeInstance(x, 'inst-' + i));
    S.sel = null; stopPreview(true); rebuildEditorFx();
  }
  function drivenIds() { return J.drivenIds(S.joints, partsDict()); }
  function isDriven(id) { return !!(S.driven && S.driven.has(id)); }

  // ── Vista previa de uniones (anima motores y bisagras; al parar vuelve todo a su sitio) ──
  function startPreview() {
    if (S.preview) return;
    const diag = J.diagnose(S.joints, partsDict()); diag.forEach(t => log('warn', 'Uniones', t));
    S.preview = { poses: new Map(stParts.map(e => [e.data.id, { ...e.data }])), joints: JSON.parse(JSON.stringify(S.joints)), state: {}, vel: {}, last: performance.now() };
    S.driven = drivenIds();
    showToast('🔗 Probando uniones — tocá otra vez para volver');
    setBtn(true);
  }
  function stopPreview(silent) {
    if (!S.preview) { setBtn(false); return; }
    for (const e of stParts) { const p = S.preview.poses.get(e.data.id); if (p) { Object.assign(e.data, { x: p.x, y: p.y, z: p.z, rx: p.rx || 0, ry: p.ry || 0, rz: p.rz || 0 }); syncMesh(e); } }
    S.joints = S.preview.joints; S.preview = null; S.driven = null; setBtn(false);
    if (!silent) { showToast('Uniones restauradas'); updateSelectionOutline(); refreshExplorer(); }
  }
  function setBtn(on) { const b = document.getElementById('cx-prev-btn'); if (b) b.classList.toggle('on', !!on); }
  function syncMesh(e) { const d = e.data; e.mesh.position.set(d.x || 0, d.y || 0, d.z || 0); e.mesh.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0); }
  function previewStep() {
    const pv = S.preview; if (!pv) return;
    const now = performance.now(), dt = Math.min(0.05, (now - pv.last) / 1000); pv.last = now;
    // el editor mueve la malla (⚛ Física, gizmo): se toma como verdad antes de resolver
    const parts = partsDict();
    for (const e of stParts) { const d = e.data; d.x = e.mesh.position.x; d.y = e.mesh.position.y; d.z = e.mesh.position.z; }
    const world = { parts, joints: S.joints, state: pv.state, vel: pv.vel, partBox: window.CrixWorldPhysics && CrixWorldPhysics.partBox, onError: (j, msg) => log('error', 'Uniones', msg) };
    const res = J.step(world, dt);
    for (const id of res.changed) { const e = entryOf(id); if (e) syncMesh(e); }
    if (res.changed.length) { updateSelectionOutline(); if (typeof updateGizmoPos === 'function') updateGizmoPos(); }
  }
  function editorFrame() {
    const fx = S.fx; const now = performance.now(), dt = S._ft ? Math.min(0.1, (now - S._ft) / 1000) : 0.016; S._ft = now;
    if (S.preview) previewStep();
    if (fx) fx.update(dt);
  }

  // ── Explorador ──
  const rowHtml = (kind, id, icon, name, extra, click, indent) => `<div class="exp-item ${S.sel && S.sel.kind === kind && S.sel.id === id ? 'sel' : ''}" style="${indent ? 'padding-left:' + (12 + indent * 14) + 'px' : ''}" onclick="${click || `CrixExt.select('${kind}','${esc2(id)}')`}"><span style="font-size:10px">${icon}</span><span style="flex:1">${esc2(name)}</span>${extra || ''}<span class="exp-ctx" onclick="event.stopPropagation();CrixExt.remove('${kind}','${esc2(id)}')">✕</span></div>`;
  const isModel = i => i.class === 'Model';
  function isModelMember(p) { return !!p.data.parent && S.instances.some(i => isModel(i) && i.id === p.data.parent); }
  // Los Model viven dentro de Workspace, con sus piezas, uniones y Humanoid anidados (como en Roblox Studio).
  function workspaceModelsHtml(query) {
    let h = ''; const q = (query || '').toLowerCase();
    for (const m of S.instances.filter(isModel)) {
      const members = stParts.map((e, i) => ({ e, i })).filter(({ e }) => e.data.parent === m.id);
      const kids = S.instances.filter(i => i.parent === m.id), js = S.joints.filter(j => j.parent === m.id);
      if (q && !(m.name + ' model').toLowerCase().includes(q) && !members.some(({ e }) => e.data.name.toLowerCase().includes(q))) continue;
      const open = S.open.has(m.id) || !!q;
      const arrow = `<span onclick="event.stopPropagation();CrixExt.toggleModel('${esc2(m.id)}')" style="cursor:pointer;display:inline-block;width:14px;font-size:9px">${open ? '▼' : '▶'}</span>`;
      h += `<div class="exp-item ${S.sel && S.sel.id === m.id ? 'sel' : ''}" onclick="CrixExt.select('inst','${esc2(m.id)}')">${arrow}<span style="font-size:10px">🗂</span><span style="flex:1">${esc2(m.name)}</span><span style="font-size:9px;color:var(--text3)">${members.length} piezas</span><span class="exp-ctx" onclick="event.stopPropagation();CrixExt.remove('inst','${esc2(m.id)}')">✕</span></div>`;
      if (!open) continue;
      for (const { e, i } of members) h += `<div class="exp-item ${selPart === e ? 'sel' : ''}" style="padding-left:30px" onclick="selectPart(stParts[${i}])"><span style="font-size:10px">${typeIcon(e.data.type)}</span><span style="flex:1">${esc2(e.data.name)}</span><span class="exp-ctx" onclick="event.stopPropagation();selPart=stParts[${i}];stuDelete()">✕</span></div>`;
      for (const j of js) h += rowHtml('joint', j.id, O.ICONS[j.class] || '🔗', j.name, `<span style="font-size:9px;color:var(--text3)">${j.class}</span>`, '', 2);
      for (const c of kids) h += rowHtml('inst', c.id, O.ICONS[c.class] || '•', c.name, '', '', 2);
    }
    return h;
  }
  function toggleModel(id) { if (S.open.has(id)) S.open.delete(id); else S.open.add(id); refreshExplorer(); }
  function explorerHtml() {
    const inModel = x => S.instances.some(m => (isModel(m) || m.class === 'Folder') && m.id === x.parent);   // el árbol del Workspace (CrixEdit) ya muestra Models y Folders con todo lo que contienen
    const joints = S.joints.filter(j => !inModel(j)), others = S.instances.filter(i => !isModel(i) && i.class !== 'Folder' && !inModel(i));
    const total = joints.length + others.length;
    let h = '<div class="exp-folder"><div class="exp-folder-hd open" onclick="toggleFolder(this)"><span class="exp-arrow">▶</span><span>🧩</span><span style="flex:1;font-size:11px">Objetos sueltos</span>' + (total ? `<span style="font-size:9px;color:var(--text3)">${total}</span>` : '') + '<button class="exp-ctx" style="opacity:1;color:var(--acc);font-size:14px;font-weight:700;padding:0 5px;line-height:1" onclick="event.stopPropagation();CrixExt.openCatalog()">+</button></div><div class="exp-children">';
    for (const j of joints) h += rowHtml('joint', j.id, O.ICONS[j.class] || '🔗', j.name, `<span style="font-size:9px;color:var(--text3)">${j.class}</span>`);
    for (const i of others) h += rowHtml('inst', i.id, O.ICONS[i.class] || '•', i.name, `<span style="font-size:9px;color:var(--text3)">${i.class}</span>`);
    if (!total) h += '<div style="padding:6px 12px;font-size:10px;color:var(--text3)">Folders, uniones, luces y efectos sueltos · tocá + para insertar</div>';
    return h + '</div></div>';
  }

  // ── Inspector genérico (a partir del esquema de CrixObjects) ──
  const PANEL = () => document.getElementById('props-body');
  function partOptions(sel) {
    return '<option value="">— ninguna —</option>' + stParts.map(e => `<option value="${esc2(e.data.id)}" ${e.data.id === sel ? 'selected' : ''}>${esc2(e.data.name)}</option>`).join('');
  }
  function field(kind, id, p, val) {
    const k = p.k, a = `CrixExt.set('${kind}','${id}','${k}',`;
    const lbl = `<div class="prop-lbl" title="${esc2(p.hint || '')}">${esc2(p.label)}</div>`;
    switch (p.t) {
      case 'bool': return `<div class="prop-row"><div class="tgl-row" onclick="${a}${!val})"><div class="tgl ${val ? 'on' : ''}"><div class="tgl-k"></div></div><span class="prop-lbl" style="margin:0" title="${esc2(p.hint || '')}">${esc2(p.label)}</span></div></div>`;
      case 'num': case 'int': return `<div class="prop-row">${lbl}<input class="prop-inp" type="number" value="${Number(val === undefined ? (p.def === undefined ? 0 : p.def) : val)}" step="${p.step || 0.1}" ${p.min !== undefined ? 'min="' + p.min + '"' : ''} ${p.max !== undefined ? 'max="' + p.max + '"' : ''} onchange="${a}this.value)"></div>`;
      case 'color': return `<div class="prop-row">${lbl}<input class="prop-inp" type="color" value="${/^#[0-9a-f]{6}$/i.test(val) ? val : '#ffffff'}" onchange="${a}this.value)"></div>`;
      case 'enum': return `<div class="prop-row">${lbl}<select class="prop-inp" onchange="${a}this.value)">${p.opts.map(o => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
      case 'part': return `<div class="prop-row">${lbl}<select class="prop-inp" onchange="${a}this.value)">${partOptions(val)}</select></div>`;
      case 'cf': {
        const c = val || {}, g = (kk, isRot) => `<input class="prop-inp" type="number" step="${isRot ? 15 : 0.25}" value="${(isRot ? deg(c[kk]) : Number(c[kk] || 0)).toFixed(2)}" onchange="CrixExt.setCf('${kind}','${id}','${k}','${kk}',this.value)">`;
        return `<div class="prop-row">${lbl}<div class="prop-grid3">${g('x')}${g('y')}${g('z')}</div><div class="prop-grid3" style="margin-top:3px">${g('rx', 1)}${g('ry', 1)}${g('rz', 1)}</div></div>`;
      }
      case 'strlist': return `<div class="prop-row">${lbl}<input class="prop-inp" value="${esc2((val || []).join(', '))}" onchange="${a}this.value)"></div>`;
      case 'attrs': return `<div class="prop-row">${lbl}<textarea class="prop-inp" rows="3" placeholder="vida=100&#10;equipo=rojo" onchange="${a}this.value)">${esc2(Object.entries(val || {}).map(([kk, v]) => kk + '=' + v).join('\n'))}</textarea></div>`;
      default: return `<div class="prop-row">${lbl}<input class="prop-inp" value="${esc2(val == null ? '' : val)}" maxlength="${p.max || 80}" onchange="${a}this.value)"></div>`;
    }
  }
  function groups(kind, id, schema, obj, getVal) {
    const order = []; const by = {};
    for (const p of schema) { const g = p.group || 'Datos'; if (!by[g]) { by[g] = []; order.push(g); } by[g].push(p); }
    return order.map(g => `<div style="padding:6px 12px 2px;font-size:9px;letter-spacing:1px;color:var(--text3)">${g.toUpperCase()}</div>` + by[g].map(p => field(kind, id, p, getVal(p))).join('')).join('');
  }
  function getObj(kind, id) { return kind === 'joint' ? S.joints.find(j => j.id === id) : S.instances.find(i => i.id === id); }
  function renderSel() {
    const sel = S.sel; if (!sel) return;
    const o = getObj(sel.kind, sel.id); if (!o) { S.sel = null; return; }
    let body;
    if (sel.kind === 'joint') {
      const msgs = J.diagnose([o], partsDict());
      body = `<div style="padding:8px 12px;font-size:11px;color:var(--text2)">${O.ICONS[o.class] || '🔗'} <b>${o.class}</b></div>` + (msgs.length ? `<div style="margin:0 10px 6px;padding:6px 8px;border-radius:8px;background:rgba(239,68,68,.12);color:#ff9b9b;font-size:10px">${msgs.map(esc2).join('<br>')}</div>` : '') + groups('joint', o.id, O.JOINT_PROPS[o.class] || [], o, p => o[p.k]);
    } else {
      const mp = o.class === 'Model' ? modelPos(o) : null;
      const posHtml = mp ? `<div style="padding:6px 12px 2px;font-size:9px;letter-spacing:1px;color:var(--text3)">POSICIÓN (mueve todo el Model)</div><div class="prop-row"><div class="prop-grid3">${['x', 'y', 'z'].map(ax => `<input class="prop-inp" type="number" step="0.5" value="${mp[ax].toFixed(2)}" onchange="CrixExt.moveModelTo('${o.id}','${ax}',this.value)">`).join('')}</div></div>` : '';
      body = `<div style="padding:8px 12px;font-size:11px;color:var(--text2)">${O.ICONS[o.class] || '•'} <b>${o.class}</b></div>` + posHtml + groups('inst', o.id, O.INSTANCE_PROPS[o.class] || [], o, p => p.k === 'name' ? o.name : o.props[p.k]) + (o.class === 'Model' ? `<div style="padding:8px;display:grid;gap:4px"><button class="st-btn" onclick="CrixExt.addSelectedToModel('${o.id}')">＋ Meter la pieza seleccionada</button><button class="st-btn" onclick="CrixExt.addExampleScript('${o.id}')">📜 Agregar script de ejemplo</button><button class="st-btn red" onclick="CrixExt.removeModelWithParts('${o.id}')">✕ Borrar Model y sus piezas</button></div>` : '');
    }
    PANEL().innerHTML = body + `<div style="padding:8px;display:flex;gap:4px"><button class="st-btn red" style="flex:1" onclick="CrixExt.remove('${sel.kind}','${esc2(sel.id)}')">✕ Borrar</button></div>`;
  }
  function select(kind, id) {
    stopPreviewIfNeeded();
    if (typeof deselect === 'function') { const keep = null; deselect(); }
    S.sel = { kind, id }; const o = getObj(kind, id);
    renderSel();
    const hd = document.getElementById('props-panel'); if (hd) hd.style.display = '';
    refreshExplorer();
  }
  function stopPreviewIfNeeded() { /* la vista previa sigue activa al inspeccionar */ }

  function snapshotChange() { if (typeof recordStudioHistory === 'function') recordStudioHistory(); }
  function setProp(kind, id, key, raw) {
    if (kind === 'part') return setPartProp(id, key, raw);
    const o = getObj(kind, id); if (!o) return; snapshotChange();
    if (kind === 'joint') {
      let v = raw;
      const sch = (O.JOINT_PROPS[o.class] || []).find(p => p.k === key) || {};
      if (sch.t === 'bool') v = (raw === true || raw === 'true'); else if (sch.t === 'num') v = parseFloat(raw) || 0;
      const prev = { p0: o.part0, p1: o.part1 };
      Object.assign(o, J.sanitize({ ...o, [key]: v, id: o.id, class: o.class }, o.id));
      if ((key === 'part0' || key === 'part1') && o.part0 && o.part1 && (prev.p0 !== o.part0 || prev.p1 !== o.part1)) fitJoint(o);
    } else {
      const sch = (O.INSTANCE_PROPS[o.class] || []).find(p => p.k === key) || {};
      if (key === 'name') o.name = String(raw).slice(0, 80);
      else { const merged = O.sanitizeInstance({ ...o, props: { ...o.props, [key]: sch.t === 'bool' ? (raw === true || raw === 'true') : raw } }, o.id); o.props = merged.props; }
      if (o.class === 'Humanoid') syncHumanoid(o);
      if (FX_CLASSES.includes(o.class)) rebuildEditorFx();
    }
    renderSel(); refreshExplorer();
  }
  // Al elegir las dos piezas, la unión conserva su pose actual (nada salta de sitio).
  function fitJoint(j) {
    const A = entryOf(j.part0), B = entryOf(j.part1); if (!A || !B) return;
    if (['Weld', 'WeldConstraint', 'Motor6D', 'Hinge', 'BallSocket', 'Prismatic'].includes(j.class)) { J.preserve(j, A.data, B.data); if (j.class === 'Prismatic') j.position = 0; j.angle = 0; }
    else { const d = Math.hypot(B.data.x - A.data.x, B.data.y - A.data.y, B.data.z - A.data.z); if (j.class === 'Spring') j.freeLength = +d.toFixed(2); else j.length = Math.max(0.1, +d.toFixed(2)); }
  }
  function setCf(kind, id, key, comp, raw) {
    const o = getObj(kind, id); if (!o) return; snapshotChange();
    const c = { ...(o[key] || {}) }; c[comp] = /^r/.test(comp) ? rad(raw) : (parseFloat(raw) || 0);
    Object.assign(o, J.sanitize({ ...o, [key]: c, id: o.id, class: o.class }, o.id)); if (o.class === 'WeldConstraint' && key === 'offset') o.offset = c;
  }
  function syncHumanoid(h) {
    const m = S.instances.find(i => i.id === h.parent && i.class === 'Model'); const root = m && entryOf(m.props.primaryPart); if (!root) return;
    root.data.attributes = { ...(root.data.attributes || {}), ...O.humanoidAttributes(h.props) };
  }
  function remove(kind, id) {
    snapshotChange();
    if (kind === 'joint') S.joints = S.joints.filter(j => j.id !== id);
    else {
      const gone = new Set([id]); S.instances.filter(i => i.parent === id).forEach(i => gone.add(i.id));
      const o = S.instances.find(i => i.id === id);
      S.instances = S.instances.filter(i => !gone.has(i.id));
      if (o && o.class === 'Model') { for (const e of stParts) if (e.data.parent === id) delete e.data.parent; S.joints = S.joints.filter(j => j.parent !== id); }
      rebuildEditorFx();
    }
    if (S.sel && S.sel.id === id) { S.sel = null; if (typeof deselect === 'function') deselect(); }
    refreshExplorer();
  }
  function members(modelId) { return stParts.filter(e => e.data.parent === modelId); }
  function modelPos(m) { const r = entryOf(m.props.primaryPart) || members(m.id)[0]; return r ? { x: r.data.x, y: r.data.y, z: r.data.z } : null; }
  function moveModelTo(id, axis, raw) {
    const m = S.instances.find(i => i.id === id); if (!m) return; const cur = modelPos(m); if (!cur) return;
    const delta = (parseFloat(raw) || 0) - cur[axis]; if (!delta) return; snapshotChange();
    for (const e of members(id)) { e.data[axis] += delta; syncMesh(e); }
    updateSelectionOutline && updateSelectionOutline(); renderSel();
  }
  function removeModelWithParts(id) {
    const ms = members(id); if (ms.length && !confirm('¿Borrar el Model y sus ' + ms.length + ' piezas?')) return;
    snapshotChange(); const ids = new Set(ms.map(e => e.data.id));
    ms.forEach(e => stScene.remove(e.mesh)); stParts = stParts.filter(e => !ids.has(e.data.id));
    S.joints = S.joints.filter(j => j.parent !== id && !ids.has(j.part0) && !ids.has(j.part1));
    S.instances = S.instances.filter(i => i.id !== id && i.parent !== id && !ids.has(i.parent));
    S.sel = null; if (typeof deselect === 'function') deselect(); rebuildEditorFx(); refreshExplorer(); if (typeof updateStStatus === 'function') updateStStatus();
  }
  function addSelectedToModel(modelId) {
    if (typeof selPart === 'undefined' || !selPart) { showToast('Seleccioná una pieza en el visor o el Explorador primero'); return; }
    const m = S.instances.find(i => i.id === modelId); if (!m) return; snapshotChange();
    selPart.data.parent = modelId; if (!m.props.primaryPart) m.props.primaryPart = selPart.data.id;
    showToast('Pieza agregada a «' + m.name + '»'); refreshExplorer();
  }

  // ── Insertar objetos ──
  function insert(cls) {
    const pickedPart = (typeof selPart !== 'undefined' && selPart) ? selPart : null;
    const meta = O.CATALOG.flatMap(c => c.items).find(i => i.cls === cls) || {};
    snapshotChange();
    const asModelOf = pickedPart && pickedPart.data.parent && S.instances.find(i => i.id === pickedPart.data.parent && i.class === 'Model');
    let created = null;
    if (O.isJoint(cls)) {
      if (!pickedPart) { showToast('Seleccioná primero la pieza que será Part0'); return; }
      const j = J.sanitize({ class: cls, name: cls, part0: pickedPart.data.id, part1: '', id: uid('j') }, uid('j'));
      if (asModelOf) j.parent = asModelOf.id;
      S.joints.push(j); created = { kind: 'joint', id: j.id };
      showToast('Elegí Part1 en el inspector');
    } else if (cls === 'Model' || cls === 'Folder') {
      const inst = O.sanitizeInstance({ class: cls, name: cls, id: uid('m'), props: {} });
      if (cls === 'Model' && pickedPart) { pickedPart.data.parent = inst.id; inst.props.primaryPart = pickedPart.data.id; }
      S.instances.push(inst); created = { kind: 'inst', id: inst.id };
    } else if (cls === 'Humanoid') {
      const model = asModelOf || (S.sel && S.sel.kind === 'inst' && S.instances.find(i => i.id === S.sel.id && i.class === 'Model'));
      if (!model) { showToast('Insertá un Model y seleccioná el Model (o una de sus piezas)'); return; }
      if (S.instances.some(i => i.class === 'Humanoid' && i.parent === model.id)) { showToast('Ese Model ya tiene un Humanoid'); return; }
      const inst = O.sanitizeInstance({ class: 'Humanoid', name: 'Humanoid', id: uid('h'), parent: model.id, props: { displayName: model.name } });
      S.instances.push(inst); syncHumanoid(inst); created = { kind: 'inst', id: inst.id };
    } else {
      if (!pickedPart) { showToast('Seleccioná primero la pieza donde va ' + cls); return; }
      const inst = O.sanitizeInstance({ class: cls, name: cls, id: uid('i'), parent: pickedPart.data.id, props: {} });
      S.instances.push(inst); created = { kind: 'inst', id: inst.id }; rebuildEditorFx();
    }
    closeCatalog(); select(created.kind, created.id);
  }
  function openCatalog() {
    closeCatalog();
    const wrap = document.createElement('div'); wrap.id = 'cx-cat';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center';
    wrap.onclick = e => { if (e.target === wrap) closeCatalog(); };
    const sel = (typeof selPart !== 'undefined' && selPart) ? selPart.data.name : null;
    wrap.innerHTML = `<div style="background:var(--bg2,#12141c);border:1px solid var(--border,#2a3350);border-radius:16px 16px 0 0;width:100%;max-width:520px;max-height:78vh;overflow:auto;padding:14px 14px 22px"><div style="display:flex;align-items:center;margin-bottom:6px"><b style="flex:1;font-size:14px">🧩 Insertar objeto</b><button class="st-btn" onclick="CrixExt.closeCatalog()">✕</button></div><div style="font-size:10px;color:var(--text3);margin-bottom:8px">${sel ? 'Pieza seleccionada: <b>' + esc2(sel) + '</b>' : 'Tip: seleccioná una pieza antes para uniones, luces y efectos'}</div>` +
      '<div style="font-size:9px;letter-spacing:1px;color:var(--text3);margin:10px 0 4px">PERSONAJES (Model + Motor6D, sin comportamiento)</div><div style=\"display:grid;grid-template-columns:1fr 1fr;gap:6px\"><button class=\"st-btn\" style=\"text-align:left;padding:9px 8px;font-size:11px\" onclick=\"CrixExt.spawnPreset(\'player\')\">🧍 Personaje (igual que el jugador)</button></div>' +
      O.CATALOG.map(c => `<div style="font-size:9px;letter-spacing:1px;color:var(--text3);margin:10px 0 4px">${c.cat.toUpperCase()}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">${c.items.map(i => `<button class="st-btn" style="text-align:left;padding:9px 8px;font-size:11px" onclick="CrixExt.insert('${i.cls}')">${i.icon} ${esc2(i.es)}</button>`).join('')}</div>`).join('') + '</div>';
    document.body.appendChild(wrap);
  }
  function closeCatalog() { const w = document.getElementById('cx-cat'); if (w) w.remove(); }

  // ── Panel de la pieza: propiedades extra estilo Roblox ──
  function extraPartHtml(entry) {
    const d = entry.data; const sch = O.PART_PROPS;
    const mdl = d.parent && S.instances.find(i => i.id === d.parent && i.class === 'Model');
    const goModel = mdl ? `<div style="padding:6px 10px 0"><button class="st-btn" style="width:100%" onclick="CrixExt.select('inst','${esc2(mdl.id)}')">🗂 Ir al Model «${esc2(mdl.name)}»</button></div>` : '';
    return goModel + '<div style="padding:8px 12px 2px;font-size:9px;letter-spacing:1px;color:var(--text3)">PROPIEDADES ROBLOX</div>' + groups('part', d.id, sch, d, p => {
      if (p.k === 'type') return d.type; if (p.k === 'tags') return d.tags || []; if (p.k === 'attributes') return d.attributes || {};
      return d[p.k] === undefined ? p.def : d[p.k];
    });
  }
  function setPartProp(id, key, raw) {
    const e = entryOf(id); if (!e) return; snapshotChange();
    const sch = O.PART_PROPS.find(p => p.k === key) || {}; const d = e.data;
    if (sch.t === 'bool') d[key] = (raw === true || raw === 'true');
    else if (sch.t === 'num') d[key] = Math.max(sch.min === undefined ? -1e6 : sch.min, Math.min(sch.max === undefined ? 1e6 : sch.max, parseFloat(raw) || 0));
    else if (sch.t === 'strlist') d.tags = String(raw).split(',').map(t => t.trim()).filter(Boolean).slice(0, 50).map(t => t.slice(0, 40));
    else if (sch.t === 'attrs') {
      const a = {}; String(raw).split('\n').slice(0, 32).forEach(line => { const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*=\s*(.*)$/); if (m) { const v = m[2].trim(); a[m[1]] = v === 'true' ? true : v === 'false' ? false : (v !== '' && Number.isFinite(Number(v)) ? Number(v) : v.slice(0, 200)); } });
      d.attributes = a;
    } else d[key] = String(raw).slice(0, sch.max || 40);
    if (key === 'type') { stScene.remove(e.mesh); e.mesh = makeMesh(d); stScene.add(e.mesh); syncMesh(e); if (selPart === e) { selectPart(e); return; } }
    if (key === 'reflectance' || key === 'castShadow') { try { e.mesh.traverse(m => { if (m.isMesh) { if (key === 'castShadow') m.castShadow = d.castShadow !== false; else if (m.material && m.material.isMeshStandardMaterial) { m.material.roughness = 1 - 0.85 * d.reflectance; m.material.envMapIntensity = 0.7 + d.reflectance * 1.1; } else if (m.material && m.material.specular) { m.material.specular.setScalar(0.15 + d.reflectance * 0.85); m.material.shininess = 30 + d.reflectance * 120; } } }); } catch (_) { /* material sin specular */ } }
    if (selPart === e) { const h = document.getElementById('cx-extra'); if (h) h.outerHTML = '<div id="cx-extra">' + extraPartHtml(e) + '</div>'; }
  }

  // ── NPC = Model de partes + Motor6D + Humanoid (sin IA, sin vida, sin reglas) ──
  function spawnRig(name, colors) {
    snapshotChange();
    const t = stCamTarget || { x: 0, y: 0, z: 0 };
    const rig = O.buildHumanoidRig({ name, x: Math.round(t.x + (Math.random() * 6 - 3)), y: 1.525 + 0.05, z: Math.round(t.z + (Math.random() * 6 - 3)), ry: 0, color: colors && colors.color });
    rig.parts.forEach(p => addPartMesh({ ...p }));
    rig.joints.forEach(j => S.joints.push(j)); rig.instances.forEach(i => S.instances.push(i));
    closeModalSafe('mo-npc'); refreshExplorer(); if (typeof updateStStatus === 'function') updateStStatus();
    showToast('🧍 «' + name + '» creado: Model con las piezas del avatar unidas por Motor6D y un Humanoid. Sin comportamientos: se programa con Scripts');
    S.open.add(rig.modelId); select('inst', rig.modelId);
  }
  function spawnPreset(id) {
    closeCatalog();
    spawnRig('Personaje');
  }
  function closeModalSafe(id) { try { closeModal(id); } catch (_) { /* nada */ } }
  function exampleScript(modelName) {
    return '// Ejemplo (borralo o cambialo): el NPC camina hacia adelante balanceando brazos y piernas.\n// Nada de esto viene por defecto: el NPC solo hace lo que programes.\nconst npc = game.getModel(' + JSON.stringify(modelName) + ');\nlet t = 0, z = 0;\nfunction onStart() {\n  if (!npc) throw new Error("No existe el Model en el mapa");\n  z = npc.rootPart.z;\n}\nfunction onUpdate(dt) {\n  t += dt; z += 4 * dt;\n  game.updatePart(npc.root, { z: z });\n  const s = Math.sin(t * 6) * 0.8;\n  game.updateJoint(npc.joints["UpperArmL"], { mode: "servo", targetAngle: s, maxVelocity: 20 });\n  game.updateJoint(npc.joints["UpperArmR"], { mode: "servo", targetAngle: -s, maxVelocity: 20 });\n  game.updateJoint(npc.joints["UpperLegL"], { mode: "servo", targetAngle: -s, maxVelocity: 20 });\n  game.updateJoint(npc.joints["UpperLegR"], { mode: "servo", targetAngle: s, maxVelocity: 20 });\n}\n';
  }
  function addExampleScript(modelId) {
    const m = S.instances.find(i => i.id === modelId); if (!m) return;
    stScripts.push({ id: uid('s'), name: 'Mover ' + m.name, type: 'Script', language: 'javascript', event: 'onStart', parent: 'ServerScriptService', code: exampleScript(m.name) });
    refreshExplorer(); showToast('📜 Script de ejemplo agregado en ServerScriptService');
  }

  function applyLook(mesh, d) {
    if (!mesh || (!(d.reflectance > 0) && d.castShadow !== false)) return;
    mesh.traverse(m => { if (!m.isMesh) return; if (d.castShadow === false) m.castShadow = false; if (d.reflectance > 0 && m.material && m.material.isMeshStandardMaterial) { m.material.roughness = 1 - 0.85 * d.reflectance; m.material.envMapIntensity = 0.7 + d.reflectance * 1.1; } else if (d.reflectance > 0 && m.material && m.material.specular) { m.material.specular.setScalar(0.15 + d.reflectance * 0.85); m.material.shininess = 30 + d.reflectance * 120; } });
  }
  // Datos de los Model para game.getModel() en los scripts locales (▶ Probar y LocalScript).
  function modelsInfo() {
    try {
      const inGame = typeof gScene !== 'undefined' && G.instances.length && runtimeObjects && runtimeObjects.size;
      if (inGame) return O.buildModelsInfo([...runtimeObjects.values()].map(o => o.data), G.joints, G.instances);
      return O.buildModelsInfo(stParts.map(p => p.data), S.joints, S.instances);
    } catch (_) { return []; }
  }

  // ── Barra: botones nuevos ──
  function addButtons() {
    const npc = document.querySelector('button[onclick="openNpcPanel()"]'); if (!npc || document.getElementById('cx-obj-btn')) return;
    npc.style.display = 'none';   // los personajes ya no son un objeto especial: se insertan desde 🧩 Objetos → Personajes
    const mk = (id, html, fn, title) => { const b = document.createElement('button'); b.className = 'st-btn'; b.id = id; b.innerHTML = html; b.title = title; b.onclick = fn; return b; };
    const prev = mk('cx-prev-btn', '🔗 Uniones', () => (S.preview ? stopPreview() : startPreview()), 'Probar Motor6D, Weld, bisagras, resortes…');
    const obj = mk('cx-obj-btn', '🧩 Objetos', openCatalog, 'Insertar Model, uniones, luces, efectos…');
    const diag = mk('cx-diag-btn', '🩺 Revisar', runDiagnostics, 'Busca errores en uniones y objetos y los muestra en Output');
    npc.after(obj, prev, diag);
    const st = document.createElement('style'); st.textContent = '#cx-prev-btn.on{background:#2a3a7a;border-color:#5b8def;color:#fff}'; document.head.appendChild(st);
  }
  function runDiagnostics() {
    const msgs = J.diagnose(S.joints, partsDict());
    for (const i of S.instances) {
      if (i.class === 'Model' && i.props.primaryPart && !entryOf(i.props.primaryPart)) msgs.push(`Model «${i.name}»: su PrimaryPart ya no existe`);
      if (FX_CLASSES.concat(['Attachment']).includes(i.class) && !entryOf(i.parent)) msgs.push(`${i.class} «${i.name}»: su pieza padre no existe`);
      if (i.class === 'Humanoid' && !S.instances.some(m => m.id === i.parent)) msgs.push(`Humanoid «${i.name}»: no está dentro de un Model`);
    }
    const seen = new Map(); stParts.forEach(e => { const n = e.data.name; seen.set(n, (seen.get(n) || 0) + 1); });
    const dup = [...seen].filter(([, c]) => c > 1).length;
    if (dup) msgs.push(`${dup} nombre(s) de pieza repetidos: tus scripts los encuentran por nombre, conviene que sean únicos`);
    if (window.CrixConsole) { msgs.forEach(t => CrixConsole.warn('Revisión', t)); if (!msgs.length) CrixConsole.info('Revisión', '✔ Sin problemas en uniones y objetos'); CrixConsole.open(); }
    showToast(msgs.length ? '⚠ ' + msgs.length + ' aviso(s) — mirá Output' : '✔ Todo en orden');
  }

  // ── Ganchos sobre funciones existentes del editor ──
  function wrap(name, fn) { const orig = window[name]; if (typeof orig !== 'function') return; window[name] = function () { return fn(orig, arguments, this); }; }
  function installEditorHooks() {
    wrap('refreshExplorer', (orig, a, t) => { const r = orig.apply(t, a); try { const el = document.getElementById('explorer'); if (el && typeof stParts !== 'undefined') el.insertAdjacentHTML('beforeend', explorerHtml()); } catch (e) { log('error', 'Explorador', e.message); } return r; });
    wrap('renderProps', (orig, a, t) => { const r = orig.apply(t, a); try { const body = PANEL(); if (body) body.insertAdjacentHTML('beforeend', '<div id="cx-extra">' + extraPartHtml(a[0]) + '</div>'); } catch (e) { log('error', 'Inspector', e.message); } return r; });
    wrap('deselect', (orig, a, t) => { S.sel = null; return orig.apply(t, a); });
    wrap('loadMyMap', (orig, a, t) => { try { const maps = getMaps(), mp = maps[stMapId]; if (mp) { const leg = O.migrateLegacyNpcs(mp); if (leg.converted) { mp.parts = leg.parts; mp.joints = leg.joints; mp.instances = leg.instances; setMaps(maps); setTimeout(() => showToast('🔄 ' + leg.converted + ' NPC antiguo(s) convertido(s) a Model sin comportamiento'), 600); } } } catch (e) { log('error', 'Migración', e.message); }
      const r = orig.apply(t, a); try { const m = getMaps()[stMapId]; loadFromMap(m); refreshExplorer(); } catch (e) { log('error', 'Studio', 'No se pudieron cargar los objetos: ' + e.message); } return r; });
    wrap('_loadMap', (orig, a, t) => { try { const m = a[0]; const leg = O.migrateLegacyNpcs(m || {}); if (leg.converted) { m.parts = leg.parts; m.joints = leg.joints; m.instances = leg.instances; } } catch (e) { log('error', 'Migración', e.message); } return orig.apply(t, a); });
    wrap('studioSnapshot', (orig, a, t) => { const s = orig.apply(t, a); if (!s) return s; const o = JSON.parse(s); o.joints = S.joints; o.instances = S.instances; return JSON.stringify(o); });
    wrap('applyStudioSnapshot', (orig, a, t) => { try { const st = JSON.parse(a[0]); const maps = getMaps(); if (maps[stMapId]) { maps[stMapId].joints = st.joints || []; maps[stMapId].instances = st.instances || []; setMaps(maps); S.joints = (st.joints || []).map(x => ({ ...x })); S.instances = (st.instances || []).map(x => JSON.parse(JSON.stringify(x))); } } catch (_) { /* snapshot viejo */ } const r = orig.apply(t, a); rebuildEditorFx(); refreshExplorer(); return r; });
    wrap('clearSt', (orig, a, t) => { if (S.fx) S.fx.clear(); return orig.apply(t, a); });
    wrap('stuSave', (orig, a, t) => {
      if (S.preview) stopPreview(true);
      try { const maps = getMaps(); if (stMapId && maps[stMapId]) { maps[stMapId].joints = S.joints.map(j => ({ ...j })); maps[stMapId].instances = JSON.parse(JSON.stringify(S.instances)); setMaps(maps); } } catch (e) { log('error', 'Guardar', e.message); }
      return orig.apply(t, a);
    });
    wrap('stuDelete', (orig, a, t) => { const e = typeof selPart !== 'undefined' && selPart; const id = e && e.data.id; const r = orig.apply(t, a); if (id) { S.joints = S.joints.filter(j => j.part0 !== id && j.part1 !== id); S.instances = S.instances.filter(i => i.parent !== id); rebuildEditorFx(); refreshExplorer(); } return r; });
    wrap('makeMesh', (orig, a, t) => { const m = orig.apply(t, a); try { applyLook(m, a[0] || {}); } catch (_) { /* material sin specular */ } return m; });
    wrap('stuTest', (orig, a, t) => { if (S.preview) stopPreview(true); const d = J.diagnose(S.joints, partsDict()); d.forEach(x => log('warn', 'Uniones', x)); return orig.apply(t, a); });
    window.spawnNpc = function () { spawnRig('Personaje'); };
    window.openNpcPanel = function () {
      const grid = document.getElementById('npc-grid'); if (!grid) return;
      grid.innerHTML = '<div class="npc-card" onclick="spawnNpc()" style="grid-column:1/-1"><div class="npc-icon">🧍</div><div class="npc-name">Personaje</div><div class="npc-type">Model · piezas del avatar · Motor6D · Humanoid</div></div>';
      openModal('mo-npc');
    };
    // La física de vista previa del editor ignora las piezas que mueve una unión.
    wrap('stepEditorPhysics', (orig, a, t) => { const drv = S.driven; if (!drv || !S.preview) return orig.apply(t, a); const saved = []; for (const e of stParts) if (drv.has(e.data.id) && e.data.anchored === false) { saved.push(e); e.data.anchored = true; } try { return orig.apply(t, a); } finally { saved.forEach(e => { e.data.anchored = false; }); } });
  }
  // El panel del NPC tiene id 'mo-npc'? (si no, openModal falla de forma visible en Output)
  function init() {
    installEditorHooks(); addButtons();
    try { if (window.CrixAvatar && CrixAvatar.onModelReady) CrixAvatar.onModelReady(() => { try { stParts.forEach(e => { if (e.data && e.data.avatarMesh && e.mesh) { stScene.remove(e.mesh); e.mesh = makeMesh(e.data); stScene.add(e.mesh); syncMesh(e); } }); } catch (_) { /* editor aún no listo */ } }); } catch (_) { /* sin avatar */ }
    const timer = setInterval(addButtons, 1500); setTimeout(() => clearInterval(timer), 30000);
    (function loop() { try { editorFrame(); } catch (e) { if (!S._err) { S._err = 1; log('error', 'Editor', e.message); } } requestAnimationFrame(loop); })();
  }

  // ═════════════════════════════ JUEGO ═════════════════════════════
  function gameWorldParts(all) {
    const d = {};
    for (const [id, o] of runtimeObjects) {
      if (!all && !G.used.has(id)) continue;
      const m = o.mesh; if (!m) continue;
      o.data.x = m.position.x; o.data.y = m.position.y; o.data.z = m.position.z; o.data.rx = m.rotation.x; o.data.ry = m.rotation.y; o.data.rz = m.rotation.z;
      d[id] = o.data;
    }
    return d;
  }
  function refreshGameUsed() {
    G.used = new Set(); for (const j of G.joints) { if (j.part0) G.used.add(j.part0); if (j.part1) G.used.add(j.part1); }
    const dict = {}; for (const [id, o] of runtimeObjects) dict[id] = o.data;
    G.driven = J.drivenIds(G.joints.filter(j => !netOnline() || j.local), dict);
    window.gJointDriven = G.driven;
    window.gJointDefs = () => G.joints;   // definiciones de uniones del mapa: el cliente las usa para predecir ensamblajes
    window.gJointParts = G.used;   // toda pieza que participe en CUALQUIER unión (también las del servidor): nunca se predice en local
  }
  const netOnline = () => (typeof netServerScriptsActive !== 'undefined' && netServerScriptsActive && typeof netConnected !== 'undefined' && netConnected);
  function applyGamePose(id) {
    const o = runtimeObjects.get(id); if (!o || !o.mesh) return;
    const d = o.data; o.mesh.position.set(d.x, d.y, d.z); o.mesh.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
    o._pp = { x: d.x, y: d.y, z: d.z };
    if (d.canCollide !== false && typeof _syncRuntimeCollider === 'function') _syncRuntimeCollider(o);
  }
  function gameLoad(m) {
    G.joints = ((m && m.joints) || []).map((j, i) => J.sanitize(j, 'joint-' + i));
    G.instances = ((m && m.instances) || []).map((x, i) => O.sanitizeInstance(x, 'inst-' + i));
    G.state = {}; G.vel = {}; G.t = performance.now(); G.targets.clear(); G.errors = new Set(); G.warnedBox = false;
    try { if (G.fx) G.fx.clear(); } catch (_) { /* escena anterior */ }
    G.fx = window.CrixFx ? CrixFx.create(THREE, gScene) : null;
    refreshGameUsed();
    if (G.fx) G.fx.build(G.instances.filter(i => FX_CLASSES.includes(i.class)), id => { const o = runtimeObjects.get(id); return o && o.mesh; }, (lvl, txt) => log(lvl, 'Objetos', txt));
    const dict = {}; for (const [id, o] of runtimeObjects) dict[id] = o.data;
    J.diagnose(G.joints, dict).forEach(t => log('warn', 'Uniones', t));
    if (G.joints.length) { try { gameStep(true); } catch (e) { log('error', 'Uniones', e.message); } }
  }
  function gameStep(first) {
    const now = performance.now(), dt = first ? 1 / 60 : Math.min(0.05, (now - G.t) / 1000); G.t = now;
    if (G.fx) G.fx.update(dt);
    // suavizado de las poses que manda el servidor (joint_poses llega a 20 Hz)
    if (G.targets.size) {
      const k = Math.min(1, dt * 16);
      for (const [id, t] of G.targets) {
        const o = runtimeObjects.get(id); if (!o || !o.mesh) { G.targets.delete(id); continue; }
        const d = o.data, near = Math.abs(t.x - d.x) + Math.abs(t.y - d.y) + Math.abs(t.z - d.z) + Math.abs(t.rx - (d.rx || 0)) + Math.abs(t.ry - (d.ry || 0)) + Math.abs(t.rz - (d.rz || 0)) < 1e-3;
        if (near) { Object.assign(d, t); G.targets.delete(id); } else { d.x += (t.x - d.x) * k; d.y += (t.y - d.y) * k; d.z += (t.z - d.z) * k; d.rx = (d.rx || 0) + (t.rx - (d.rx || 0)) * k; d.ry = (d.ry || 0) + (t.ry - (d.ry || 0)) * k; d.rz = (d.rz || 0) + (t.rz - (d.rz || 0)) * k; }
        applyGamePose(id);
      }
    }
    const online = netOnline(), list = online ? G.joints.filter(j => j.local) : G.joints;
    if (!list.length) return;
    const dynamic = list.some(j => J.DYNAMIC.includes(j.class));
    const parts = gameWorldParts(dynamic);
    if (!dynamic) for (const id of G.used) if (!parts[id]) { const o = runtimeObjects.get(id); if (o) parts[id] = o.data; }
    const world = { parts, joints: list, state: G.state, vel: G.vel, partBox: window.CrixWorldPhysics && CrixWorldPhysics.partBox, onError: (j, msg) => { const key = j.id + msg; if (!G.errors.has(key)) { G.errors.add(key); log('error', 'Uniones', msg); } } };
    const n = dt > 0.035 ? 2 : 1, h = dt / n;
    for (let i = 0; i < n; i++) { const res = J.step(world, h); for (const id of res.changed) applyGamePose(id); }
  }
  function netPoses(msg) {
    if (!msg || !Array.isArray(msg.parts)) return;
    for (const p of msg.parts) { if (!Array.isArray(p) || p.length < 7) continue; const jo = runtimeObjects.get(String(p[0])); if (jo) { jo.jointLinked = true; if (jo.predAt && jo.mesh && performance.now() - jo.predAt < 300 && Math.hypot(p[1] - jo.mesh.position.x, p[2] - jo.mesh.position.y, p[3] - jo.mesh.position.z) <= 2.5) continue; G.targets.set(String(p[0]), { x: p[1], y: p[2], z: p[3], rx: p[4], ry: p[5], rz: p[6] }); } }
  }
  function gameCommand(message) {
    const c = message.command, p = message.payload || {};
    if (c !== 'jointCreate' && c !== 'jointUpdate' && c !== 'jointDestroy') return false;
    try {
      const id = String(p.id || '').slice(0, 120);
      if (c === 'jointDestroy') { G.joints = G.joints.filter(j => j.id !== id); delete G.state[id]; refreshGameUsed(); return true; }
      if (c === 'jointCreate') {
        const j = J.sanitize({ ...(p.data || {}), id }, id); j.local = true;
        const A = runtimeObjects.get(j.part0), B = runtimeObjects.get(j.part1);
        if (!A || !B) { log('error', 'Uniones', `createJoint(${j.class}): no existe ${!A ? 'Part0' : 'Part1'} («${!A ? j.part0 : j.part1}»)`); return true; }
        if (!(p.data && p.data.c0) && J.KINEMATIC.includes(j.class)) { gameWorldParts(false); J.preserve(j, gameWorldParts(true)[j.part0] || A.data, gameWorldParts(true)[j.part1] || B.data); }
        G.joints.push(j); refreshGameUsed(); return true;
      }
      const i = G.joints.findIndex(j => j.id === id);
      if (i < 0) { log('error', 'Uniones', 'updateJoint: no existe la unión «' + id + '»'); return true; }
      const cur = G.joints[i], upd = J.sanitize({ ...cur, ...(p.patch || {}), id, class: cur.class }, id); upd.local = cur.local;
      G.joints[i] = upd; if (G.state[id]) G.state[id].rel = null; refreshGameUsed();
    } catch (e) { log('error', 'Uniones', e.message); }
    return true;
  }

  // ── Vista previa de animaciones en el editor (CrixAnim): pone poses temporales y las restaura al terminar ──
  function animPose(partPatches, jointPatches) {
    if (S.preview) stopPreview(true);
    if (!S.animPrev) S.animPrev = { joints: JSON.parse(JSON.stringify(S.joints)), poses: new Map(stParts.map(e => [e.data.id, { ...e.data }])), state: {}, vel: {} };
    const A = S.animPrev;
    for (const id in (partPatches || {})) { const e = entryOf(id); if (!e) continue; const p = partPatches[id]; for (const k in p) if (Number.isFinite(p[k])) e.data[k] = p[k]; const b0 = A.poses.get(id) || e.data, d = e.data; if (e.mesh && (p.sx !== undefined || p.sy !== undefined || p.sz !== undefined) && !d.avatarMesh) { if (d.type === 'ImportedMesh') e.mesh.scale.set((d.sx || 4) / 4, (d.sy || 4) / 4, (d.sz || 4) / 4); else e.mesh.scale.set((d.sx || 1) / (b0.sx || 1), (d.sy || 1) / (b0.sy || 1), (d.sz || 1) / (b0.sz || 1)); } if (e.mesh && p.transparent !== undefined && e.mesh.material && !Array.isArray(e.mesh.material)) { e.mesh.material.transparent = true; e.mesh.material.opacity = 1 - Math.max(0, Math.min(1, d.transparent || 0)); } syncMesh(e); }
    let moved = false;
    for (const id in (jointPatches || {})) { const i = S.joints.findIndex(j => j.id === id); if (i < 0) continue; S.joints[i] = J.sanitize({ ...S.joints[i], ...jointPatches[id], id, class: S.joints[i].class }, id); moved = true; }
    if (moved) {
      S.driven = drivenIds();
      const world = { parts: partsDict(), joints: S.joints, state: A.state, vel: A.vel, partBox: window.CrixWorldPhysics && CrixWorldPhysics.partBox, onError: () => {} };
      for (const e of stParts) { e.data.x = e.mesh.position.x; e.data.y = e.mesh.position.y; e.data.z = e.mesh.position.z; }
      const res = J.step(world, 1 / 60); for (const id of res.changed) { const e = entryOf(id); if (e) syncMesh(e); }
    }
    try { updateSelectionOutline(); if (typeof updateGizmoPos === 'function') updateGizmoPos(); } catch (_) { /* nada seleccionado */ }
  }
  function animPoseEnd() {
    const A = S.animPrev; if (!A) return;
    for (const e of stParts) { const p = A.poses.get(e.data.id); if (p) { Object.assign(e.data, p); if (e.mesh && !e.data.avatarMesh) { if (e.data.type === 'ImportedMesh') e.mesh.scale.set((e.data.sx || 4) / 4, (e.data.sy || 4) / 4, (e.data.sz || 4) / 4); else e.mesh.scale.set(1, 1, 1); } try { if (typeof updatePartAppearance === 'function') updatePartAppearance(e); } catch (_) { /* nada */ } syncMesh(e); } }
    S.joints = A.joints; S.driven = null; S.animPrev = null;
    try { updateSelectionOutline(); } catch (_) { /* nada */ }
  }
  window.CrixExt = { animPose, animPoseEnd, isModelMember, workspaceModelsHtml, toggleModel, moveModelTo, removeModelWithParts, spawnPreset, select, set: setProp, setCf, setPartProp, remove, insert, openCatalog, closeCatalog, addSelectedToModel, addExampleScript, isDriven, modelsInfo, gameLoad, gameStep, gameCommand, netPoses, editorFrame, state: S, game: G };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
