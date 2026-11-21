'use strict';
// CrixAnimator — panel «🎞 Animador» del editor: capas con loop propio, pistas por objeto/unión, fotogramas clave con curvas,
// eventos, símbolos (clips de otras animaciones) y vista previa en vivo. Las animaciones se guardan en el mapa (map.animations)
// (también la CARA de los personajes: pistas «😀 Cara» con boca, cejas, párpados, mirada y expresión) y se usan desde scripts por id:  game.animate('id', { model:'Bot' }). Cada capa tiene prioridad (Core…Action4) y manda sobre las piezas que anima.
(function () {
  const A = window.CrixAnim; if (!A) return;
  const AN = { list: [], cur: null, t: 0, playing: false, sel: null, zoom: 120, layer: 0, track: -1, model: '', player: null, raf: 0, last: 0, base: new Map(), dirty: null, faceDriven: new Set() };
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ROT = ['rx', 'ry', 'rz', 'angle'], D = 180 / Math.PI;
  const toUi = (ch, v) => ROT.includes(ch) ? +(v * D).toFixed(3) : +(+v).toFixed(4);
  const fromUi = (ch, v) => ROT.includes(ch) ? (Number(v) || 0) / D : (Number(v) || 0);
  const lib = () => new Map(AN.list.map(a => [a.id, a]));
  const toast = m => { if (typeof showToast === 'function') showToast(m); };
  const newId = () => 'anim_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

  // ── Persistencia en el mapa ──
  function save() {
    clearTimeout(AN.dirty); AN.dirty = setTimeout(() => { try { const maps = getMaps(); if (stMapId && maps[stMapId]) { maps[stMapId].animations = JSON.parse(JSON.stringify(AN.list)); setMaps(maps); } } catch (e) { console.warn('[Animador]', e); } }, 250);
  }
  function loadFrom(m) { AN.list = ((m && m.animations) || []).map(a => A.sanitize(a)); AN.cur = AN.list[0] || null; AN.sel = null; AN.layer = 0; AN.track = -1; window.CrixAnimLib = AN.list; }
  function wrap(name, fn) { const o = window[name]; if (typeof o !== 'function') return; window[name] = function () { return fn(o, arguments, this); }; }
  function hooks() {
    wrap('loadMyMap', (o, a, t) => { const r = o.apply(t, a); try { loadFrom(getMaps()[stMapId]); } catch (_) { /* sin mapa */ } return r; });
    wrap('_loadMap', (o, a, t) => { try { window.CrixAnimLib = ((a[0] && a[0].animations) || []).map(x => A.sanitize(x)); } catch (_) { /* nada */ } return o.apply(t, a); });
    wrap('studioSnapshot', (o, a, t) => { const s = o.apply(t, a); if (!s) return s; const j = JSON.parse(s); j.animations = AN.list; return JSON.stringify(j); });
    wrap('applyStudioSnapshot', (o, a, t) => { try { const st = JSON.parse(a[0]); AN.list = (st.animations || []).map(x => A.sanitize(x)); AN.cur = AN.list.find(x => AN.cur && x.id === AN.cur.id) || AN.list[0] || null; const maps = getMaps(); if (maps[stMapId]) { maps[stMapId].animations = AN.list; setMaps(maps); } } catch (_) { /* snapshot viejo */ } return o.apply(t, a); });
    wrap('stuSave', (o, a, t) => { try { const maps = getMaps(); if (stMapId && maps[stMapId]) { maps[stMapId].animations = JSON.parse(JSON.stringify(AN.list)); setMaps(maps); } } catch (_) { /* nada */ } return o.apply(t, a); });
  }

  // ── Resolución de objetivos para la vista previa ──
  const models = () => { try { return (window.CrixExt && CrixExt.modelsInfo && CrixExt.modelsInfo()) || []; } catch (_) { return []; } };
  const curModel = () => models().find(m => m.id === AN.model || m.name === AN.model) || null;
  function partEntry(name) { const m = curModel(); const id = m && m.parts && m.parts[name]; return stParts.find(e => e.data.id === (id || name)) || stParts.find(e => e.data.name === name); }
  function jointId(name) { const m = curModel(); return (m && m.joints && m.joints[name]) || name; }
  const targetNames = () => { const out = { part: [], joint: [], face: [], bone: ((window.CrixAvatar && CrixAvatar.BONES) || []).slice() }, m = curModel(); for (const e of stParts) if (e.data.avatarMesh === 'Head' && !out.face.includes(e.data.name)) out.face.push(e.data.name); if (m) { out.part = Object.keys(m.parts || {}); out.joint = Object.keys(m.joints || {}); } for (const e of stParts) if (!out.part.includes(e.data.name)) out.part.push(e.data.name); return out; };
  function baseOf(e) { if (!AN.base.has(e.data.id)) AN.base.set(e.data.id, { ...e.data }); return AN.base.get(e.data.id); }

  // ── Reproducción / vista previa ──
  function rebuild() { if (!AN.cur) { AN.player = null; return; } AN.player = A.createPlayer(AN.cur, { library: lib() }); AN.player.seek(AN.t); }
  function applyValues(values) {
    const parts = {}, joints = {}, faces = {};
    for (const k in values) {
      const e = values[k];
      if (e.kind === 'bone') continue;   // los huesos del avatar solo se ven en el juego (la vista previa del editor no tiene avatar)
      if (e.kind === 'face') { (faces[e.target] = faces[e.target] || {})[e.ch] = [e.v, e.w, e.rd, e.add]; continue; }
      if (e.kind === 'joint') { const id = jointId(e.target); (joints[id] = joints[id] || {})[e.ch] = e; continue; }
      const en = partEntry(e.target); if (!en) continue; (parts[en.data.id] = parts[en.data.id] || { _b: baseOf(en) })[e.ch] = e;
    }
    const pp = {}, jp = {};
    for (const id in parts) { const o = parts[id], b = o._b, p = {}; for (const c in o) { if (c === '_b') continue; const e = o[c], bv = Number(b[c]) || 0; p[c] = A.apply(e, bv); } pp[id] = p; }
    for (const id in joints) { const o = joints[id], p = {}, tf = {}; for (const c in o) { const e = o[c], v = A.apply(e, 0); if (c === 'angle') { p.angle = v; } else tf[c] = v; } if (Object.keys(tf).length) p.transform = tf; jp[id] = p; }
    if (window.CrixExt && CrixExt.animPose) CrixExt.animPose(pp, jp);
    applyFaces(faces);
  }
  // Cara: se pone la animación (valores ya resueltos por prioridad) en la cara de la pieza Head; al dejar de animarla vuelve a la automática.
  function applyFaces(faces) {
    const now = new Set();
    for (const name in faces) { const en = partEntry(name), av = en && en.mesh && en.mesh.userData.rigFace; if (!av || !window.CrixAvatar) continue; CrixAvatar.applyState(av, { faceAnim: faces[name] }); AN.faceDriven.add(av); now.add(av); }
    for (const av of Array.from(AN.faceDriven)) if (!now.has(av)) { try { CrixAvatar.applyState(av, { faceAnim: null }); } catch (_) { /* cara ya destruida */ } AN.faceDriven.delete(av); }
  }
  function scrub(t) { AN.t = Math.max(0, t); if (!AN.player) rebuild(); if (!AN.player) return; AN.player.seek(AN.t); AN.player.playing = false; applyValues(AN.player.sample()); updatePlayhead(); }
  function play() { if (!AN.cur) return; rebuild(); AN.player.seek(AN.t >= AN.player.length ? 0 : AN.t); AN.player.playing = true; AN.playing = true; AN.last = performance.now(); cancelAnimationFrame(AN.raf); AN.raf = requestAnimationFrame(loop); renderBar(); }
  function pause() { AN.playing = false; cancelAnimationFrame(AN.raf); if (AN.player) AN.player.playing = false; renderBar(); }
  function stop() { pause(); AN.t = 0; applyFaces({}); if (window.CrixExt && CrixExt.animPoseEnd) CrixExt.animPoseEnd(); AN.base.clear(); updatePlayhead(); }
  function loop(now) {
    if (!AN.playing) return; const dt = Math.min(0.1, (now - AN.last) / 1000); AN.last = now;
    const r = AN.player.update(dt); AN.t = AN.player.time; applyValues(r.values); updatePlayhead();
    for (const e of r.events) flash(e);
    if (r.ended) { pause(); return; } AN.raf = requestAnimationFrame(loop);
  }
  function flash(e) { const el = $('cxan-evlog'); if (el) { el.textContent = '⚡ ' + e.name + (e.layer ? ' (' + e.layer + ')' : '') + ' @' + e.t.toFixed(2) + 's'; } }

  // ── Edición ──
  function touch(structural) { if (!AN.cur) return; AN.cur = AN.list[AN.list.findIndex(a => a.id === AN.cur.id)] = A.sanitize(AN.cur); rebuild(); save(); if (structural !== false) render(); else updatePlayhead(); }
  const layerOf = () => AN.cur && AN.cur.layers[AN.layer];
  function selObj() { const s = AN.sel, l = s && AN.cur && AN.cur.layers[s.l]; if (!l) return null; if (s.k === 'key') { const t = l.tracks[s.tr]; return t && t.channels[s.ch] && t.channels[s.ch][s.i]; } if (s.k === 'lev') return l.events[s.i]; if (s.k === 'aev') return AN.cur.events[s.i]; if (s.k === 'clip') return l.clips[s.i]; return null; }
  function addKeyAt(l, tr, ch, t, v) {
    const track = AN.cur.layers[l].tracks[tr]; const arr = track.channels[ch] = track.channels[ch] || [];
    const i = arr.findIndex(k => Math.abs(k.t - t) < 1e-3); if (i >= 0) { arr[i].v = v; return i; }
    arr.push({ t, v, ease: ['emotion', 'talk', 'tear', 'teeth'].includes(ch) ? 'step' : 'quadInOut' }); arr.sort((a, b) => a.t - b.t); return arr.findIndex(k => k.t === t);
  }
  function snap(t) { const f = AN.cur ? AN.cur.fps : 30; return Math.max(0, Math.round(t * f) / f); }

  function newAnim() { const a = A.blank('Animación ' + (AN.list.length + 1)); a.id = newId(); AN.list.push(a); AN.cur = a; AN.layer = 0; AN.track = -1; AN.sel = null; stop(); rebuild(); save(); render(); }
  function dupAnim() { if (!AN.cur) return; const c = A.sanitize(JSON.parse(JSON.stringify(AN.cur))); c.id = newId(); c.name += ' copia'; AN.list.push(c); AN.cur = c; rebuild(); save(); render(); }
  function delAnim() { if (!AN.cur || !confirm('¿Borrar «' + AN.cur.name + '»?')) return; stop(); AN.list = AN.list.filter(a => a !== AN.cur); AN.cur = AN.list[0] || null; AN.sel = null; rebuild(); save(); render(); }
  function addLayer() { AN.cur.layers.push({ name: 'Capa ' + (AN.cur.layers.length + 1), priority: AN.cur.layers.length ? AN.cur.layers[AN.cur.layers.length - 1].priority : A.DEFAULT_PRIORITY, tracks: [], clips: [], events: [] }); AN.layer = AN.cur.layers.length - 1; touch(); }
  function addTrack(kind) {
    const names = targetNames()[kind]; const free = kind === 'face' || kind === 'bone';   // cara/hueso también valen para avatares de jugadores y NPC (no hace falta que estén en el mapa)
    if (!names.length && !free) { toast(kind === 'joint' ? 'No hay uniones: elegí un Model arriba' : 'No hay objetos'); return; }
    const pick = prompt((kind === 'joint' ? 'Unión' : kind === 'face' ? 'Pieza Head o avatar de la cara' : kind === 'bone' ? 'Hueso del avatar' : 'Objeto') + ' a animar:\n' + names.slice(0, 60).join(', ') + (names.length > 60 ? '…' : ''), names[0] || (kind === 'face' ? 'Head' : '')); if (!pick) return;
    let sub; if (kind === 'face') { const subs = Object.keys(A.FACE_SUBS); sub = prompt('Elemento de la cara (cada uno es una pista suelta que ponés en la capa que quieras):\n' + subs.join(', '), 'Mouth'); if (!sub || !subs.includes(sub.trim())) { toast('Elegí uno de: ' + subs.join(', ')); return; } sub = sub.trim(); }
    layerOf().tracks.push(sub ? { target: pick, kind, sub, rel: false, channels: {} } : { target: pick, kind, rel: kind === 'joint', channels: {} }); AN.track = layerOf().tracks.length - 1; touch();
  }
  function addChannel(trIdx, ch) {
    const l = layerOf(), tr = l.tracks[trIdx]; if (!tr || tr.channels[ch]) return;
    let v = 0; if (tr.kind === 'face') v = A.FACE_DEFAULTS[ch] || 0; else if (tr.kind === 'part') { const e = partEntry(tr.target); if (e && !tr.rel) v = Number(e.data[ch]) || (ch.startsWith('s') ? 1 : 0); } else if (ch.startsWith('s')) v = 1;
    addKeyAt(AN.layer, trIdx, ch, snap(AN.t), v); touch();
  }
  function recordPose() {
    const l = layerOf(), tr = l && l.tracks[AN.track]; if (!tr || tr.kind !== 'part') { toast('Elegí una pista de objeto para grabar su pose (la cara se anima con claves)'); return; }
    const e = partEntry(tr.target); if (!e) { toast('No encuentro «' + tr.target + '» en la escena'); return; }
    const b = baseOf(e), t = snap(AN.t);
    for (const ch of ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz']) { const cur = Number(e.data[ch]) || 0, bv = Number(b[ch]) || 0; if (tr.channels[ch] || Math.abs(cur - bv) > 1e-6) addKeyAt(AN.layer, AN.track, ch, t, tr.rel ? cur - bv : cur); }
    touch(); toast('🔴 Pose grabada en ' + t.toFixed(2) + 's');
  }
  function addClip() {
    const others = AN.list.filter(a => a !== AN.cur); if (!others.length) { toast('Creá otra animación para usarla como símbolo'); return; }
    const id = prompt('Símbolo (id de animación):\n' + others.map(a => a.id + ' = ' + a.name).join('\n'), others[0].id); if (!id || !AN.list.find(a => a.id === id)) return;
    layerOf().clips.push({ symbol: id, start: snap(AN.t), loop: true, speed: 1, weight: 1, targets: {} }); AN.sel = { k: 'clip', l: AN.layer, i: layerOf().clips.length - 1 }; touch();
  }
  function addEvent(scope, t) {
    const name = prompt('Nombre del evento (lo recibís con onEvent / game.onAnimationEvent):', 'Golpe'); if (!name) return;
    if (scope === 'aev') AN.cur.events.push({ t: snap(t), name }); else layerOf().events.push({ t: snap(t), name });
    touch();
  }
  function exportJson() { if (!AN.cur) return; const txt = JSON.stringify(AN.cur, null, 1); try { navigator.clipboard.writeText(txt); toast('📋 JSON copiado'); } catch (_) { prompt('JSON', txt); } }
  function importJson() { const txt = prompt('Pegá el JSON de la animación:'); if (!txt) return; try { const a = A.sanitize(JSON.parse(txt)); if (AN.list.some(x => x.id === a.id)) a.id = newId(); AN.list.push(a); AN.cur = a; rebuild(); save(); render(); } catch (e) { toast('JSON inválido: ' + e.message); } }

  // ── Interfaz ──
  const CSS = `#cxan{position:fixed;left:0;right:0;bottom:0;height:48vh;z-index:700;background:#0b0e16;border-top:2px solid #2d3650;display:none;flex-direction:column;color:var(--text,#e8ecf4);font:12px/1.35 system-ui,sans-serif}
#cxan.open{display:flex}#cxan button,#cxan select,#cxan input{font:inherit;background:#1c2230;color:inherit;border:1px solid #2d3650;border-radius:6px;padding:4px 7px}
#cxan button{cursor:pointer}#cxan button:hover{background:#27304a}#cxan button.on{background:#2a3a7a;border-color:#5b8def}
#cxan .bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid #222a3d}
#cxan .body{display:flex;flex:1;min-height:0}#cxan .tl{flex:1;overflow:auto;position:relative}#cxan .side{width:250px;border-left:1px solid #222a3d;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
#cxan .row{display:flex;height:26px;border-bottom:1px solid #1a2132;align-items:center}#cxan .lab{position:sticky;left:0;z-index:3;width:210px;min-width:210px;background:#10141f;border-right:1px solid #222a3d;padding:0 6px;display:flex;gap:4px;align-items:center;height:100%;overflow:hidden;white-space:nowrap}
#cxan .lane{position:relative;height:100%}#cxan .row.layer .lab{background:#18203a;font-weight:700}#cxan .row.sel .lab{background:#1d2a4d}
#cxan .k{position:absolute;top:7px;width:11px;height:11px;margin-left:-5px;background:#f2c14e;transform:rotate(45deg);cursor:ew-resize;border:1px solid #000}#cxan .k.s{background:#fff;outline:2px solid #5b8def}
#cxan .ev{position:absolute;top:4px;margin-left:-4px;padding:0 4px;background:#c0445e;border-radius:3px;font-size:10px;cursor:ew-resize;white-space:nowrap}#cxan .ev.s{outline:2px solid #fff}
#cxan .clip{position:absolute;top:3px;height:20px;background:#3c7a5a;border-radius:4px;font-size:10px;padding:2px 5px;overflow:hidden;cursor:ew-resize;white-space:nowrap}#cxan .clip.s{outline:2px solid #fff}
#cxan .ph{position:absolute;top:0;bottom:0;width:2px;background:#ff5b5b;z-index:2;pointer-events:none}#cxan .ruler{position:sticky;top:0;z-index:4;height:22px;background:#10141f;border-bottom:1px solid #222a3d;display:flex}
#cxan .tick{position:absolute;top:10px;border-left:1px solid #3a4560;height:12px;font-size:9px;padding-left:2px;color:#8a95b0}#cxan label{display:flex;gap:4px;align-items:center}#cxan .small{width:62px}#cxan h4{margin:4px 0 0;font-size:12px}`;
  function ensureDom() {
    if ($('cxan')) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const d = document.createElement('div'); d.id = 'cxan'; document.body.appendChild(d);
  }
  const lw = () => Math.max(900, Math.ceil(((AN.cur ? A.animLength(AN.cur, lib()) : 0) + 2) * AN.zoom));
  const X = t => Math.round(t * AN.zoom);
  function render() {
    ensureDom(); const root = $('cxan'), a = AN.cur;
    const opts = AN.list.map(x => `<option value="${esc(x.id)}" ${a && x.id === a.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    const mods = models().map(m => `<option value="${esc(m.id)}" ${AN.model === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    let h = `<div class="bar"><b>🎞 Animador</b><select id="an-sel">${opts || '<option>— sin animaciones —</option>'}</select><button data-a="new">＋ Nueva</button><button data-a="dup">⧉</button><button data-a="del">🗑</button>`;
    if (a) h += `<input id="an-name" value="${esc(a.name)}" style="width:130px"><span title="Usalo en scripts: game.animate('${esc(a.id)}')">ID <code>${esc(a.id)}</code></span><button data-a="copyid">📋</button>
      <label>Largo <input id="an-len" class="small" type="number" step="0.1" min="0" value="${(A.animLength(a, lib())).toFixed(2)}">s</label><label>FPS <input id="an-fps" class="small" type="number" min="1" value="${a.fps}"></label><label><input id="an-loop" type="checkbox" ${a.loop ? 'checked' : ''}>Loop</label>
      <select id="an-model" title="Model para la vista previa"><option value="">Model: (ninguno)</option>${mods}</select>
      <button data-a="${AN.playing ? 'pause' : 'play'}" class="${AN.playing ? 'on' : ''}">${AN.playing ? '⏸' : '▶'}</button><button data-a="stop">⏹</button><button data-a="rec" title="Graba la pose actual del objeto en el cursor">🔴 Key</button><span id="cxan-evlog" style="color:#f08a9c"></span>`;
    h += `<span style="flex:1"></span><button data-a="exp">Exportar</button><button data-a="imp">Importar</button><label>Zoom <input id="an-zoom" type="range" min="30" max="600" value="${AN.zoom}"></label><button data-a="close">✕ Cerrar</button></div>`;
    if (!a) { root.innerHTML = h + '<div style="padding:30px;color:#8a95b0">Creá una animación con «＋ Nueva». Cada animación tiene capas; cada capa tiene su prioridad, pistas (objetos o uniones), eventos y símbolos.</div>'; return bind(); }
    h += '<div class="body"><div class="tl" id="an-tl"><div style="width:' + (lw() + 214) + 'px;position:relative">';
    let ticks = ''; const step = AN.zoom >= 200 ? 0.25 : AN.zoom >= 80 ? 0.5 : 1; for (let t = 0; t * AN.zoom <= lw(); t += step) ticks += `<div class="tick" style="left:${X(t)}px">${t.toFixed(t % 1 ? 2 : 0)}s</div>`;
    h += `<div class="ruler"><div class="lab" style="height:22px">Tiempo</div><div class="lane" id="an-ruler" style="width:${lw()}px;height:22px;cursor:col-resize">${ticks}</div></div>`;
    h += `<div class="row"><div class="lab">⚡ Eventos de la animación</div><div class="lane" data-lane="aev" style="width:${lw()}px">${a.events.map((e, i) => `<div class="ev ${AN.sel && AN.sel.k === 'aev' && AN.sel.i === i ? 's' : ''}" data-ev="aev:${i}" style="left:${X(e.t)}px">${esc(e.name)}</div>`).join('')}</div></div>`;
    a.layers.forEach((l, li) => {
      h += `<div class="row layer ${li === AN.layer ? 'sel' : ''}"><div class="lab" data-layer="${li}">📚 ${esc(l.name)} <small title="Prioridad de la capa" style="opacity:.7">⬆${esc(A.priorityName(l.priority))}</small> ${l.loop === true || (l.loop === undefined && a.loop) ? '🔁' : ''}</div><div class="lane" data-lane="lev:${li}" style="width:${lw()}px">`
        + l.events.map((e, i) => `<div class="ev ${AN.sel && AN.sel.k === 'lev' && AN.sel.l === li && AN.sel.i === i ? 's' : ''}" data-ev="lev:${li}:${i}" style="left:${X(e.t)}px">${esc(e.name)}</div>`).join('')
        + l.clips.map((c, i) => `<div class="clip ${AN.sel && AN.sel.k === 'clip' && AN.sel.l === li && AN.sel.i === i ? 's' : ''}" data-clip="${li}:${i}" style="left:${X(c.start)}px;width:${Math.max(24, X((c.length || ((AN.list.find(s => s.id === c.symbol) ? A.animLength(AN.list.find(s => s.id === c.symbol), lib()) : 1) / Math.abs(c.speed || 1)))))}px">◆ ${esc((AN.list.find(s => s.id === c.symbol) || {}).name || c.symbol)}</div>`).join('') + '</div></div>';
      l.tracks.forEach((tr, ti) => {
        h += `<div class="row ${li === AN.layer && ti === AN.track ? 'sel' : ''}"><div class="lab" data-track="${li}:${ti}">${tr.kind === 'joint' ? '🔗' : tr.kind === 'face' ? '😀' : tr.kind === 'bone' ? '🦴' : '🧊'} ${esc(tr.target)}${tr.kind === 'face' ? ' · ' + esc(tr.sub) : ''}${tr.rel ? ' <small>rel</small>' : ''}</div><div class="lane" style="width:${lw()}px"></div></div>`;
        for (const ch of Object.keys(tr.channels)) {
          h += `<div class="row"><div class="lab" style="padding-left:24px">${ch}</div><div class="lane" data-chlane="${li}:${ti}:${ch}" style="width:${lw()}px">` + tr.channels[ch].map((k, i) => `<div class="k ${AN.sel && AN.sel.k === 'key' && AN.sel.l === li && AN.sel.tr === ti && AN.sel.ch === ch && AN.sel.i === i ? 's' : ''}" data-key="${li}:${ti}:${ch}:${i}" style="left:${X(k.t)}px" title="${ch === 'emotion' ? esc(A.FACE_EMOTIONS[Math.max(0, Math.min(A.FACE_EMOTIONS.length - 1, Math.round(k.v)))]) : toUi(ch, k.v)} · ${k.ease}"></div>`).join('') + '</div></div>';
        }
      });
    });
    h += `<div class="ph" id="an-ph" style="left:${210 + X(AN.t)}px"></div></div></div><div class="side">${side()}</div></div>`;
    const sy = $('an-tl') ? $('an-tl').scrollTop : 0, sx = $('an-tl') ? $('an-tl').scrollLeft : 0;
    root.innerHTML = h; const tl = $('an-tl'); tl.scrollTop = sy; tl.scrollLeft = sx; bind();
  }
  function renderBar() { render(); }
  function side() {
    const a = AN.cur, l = layerOf(); let h = '';
    if (l) {
      h += `<h4>Capa «${esc(l.name)}»</h4><label>Nombre <input data-lf="name" value="${esc(l.name)}"></label>
      <label><input type="checkbox" data-lf="loop" ${l.loop === true || (l.loop === undefined && a.loop) ? 'checked' : ''}>Loop de esta capa</label>
      <label title="Como en Roblox, pero por pieza: la capa de más prioridad manda sobre las piezas que anima; las demás piezas siguen con las capas de menor prioridad. Igual prioridad: manda la capa de más abajo en la lista.">Prioridad <input style="width:96px" list="an-prios" data-lf="priority" value="${esc(A.priorityName(l.priority))}"></label><datalist id="an-prios">${Object.keys(A.PRIORITIES).map(n => `<option value="${n}">${A.PRIORITIES[n]}</option>`).join('')}</datalist>
      <label>Peso <input class="small" type="number" step="0.1" data-lf="weight" value="${l.weight}"></label><label>Velocidad <input class="small" type="number" step="0.1" data-lf="speed" value="${l.speed}"></label>
      <label>Modo <select data-lf="mode"><option value="override" ${l.mode === 'override' ? 'selected' : ''}>Reemplaza</option><option value="additive" ${l.mode === 'additive' ? 'selected' : ''}>Suma</option></select></label>
      <label><input type="checkbox" data-lf="enabled" ${l.enabled ? 'checked' : ''}>Activa</label>
      <div style="display:flex;gap:4px;flex-wrap:wrap"><button data-a="addlayer">＋ Capa</button><button data-a="dellayer">🗑 Capa</button><button data-a="addtrack:part">＋ Objeto</button><button data-a="addtrack:joint">＋ Unión</button><button data-a="addtrack:face" title="Un elemento de la cara: boca, cada ojo, cada ceja o expresión">＋ Cara</button><button data-a="addtrack:bone" title="Un hueso del avatar de un jugador o NPC">＋ Hueso</button><button data-a="addclip">＋ Símbolo</button><button data-a="addaev">＋ Evento anim.</button><button data-a="addlev">＋ Evento capa</button></div>`;
      const tr = l.tracks[AN.track];
      if (tr) h += `<h4>Pista «${esc(tr.target)}${tr.kind === 'face' ? ' · ' + esc(tr.sub) : ''}»</h4>${tr.kind === 'face' ? '' : `<label><input type="checkbox" data-tf="rel" ${tr.rel ? 'checked' : ''}>Relativa a la pose inicial</label>`}<label>Agregar canal <select data-a="addch"><option value="">…</option>${A.channelsOf(tr.kind, tr.sub).filter(c => !tr.channels[c] && (tr.kind === 'face' || tr.kind === 'bone' ? true : tr.kind === 'part' ? c !== 'angle' : !c.startsWith('s') && c !== 'transparent')).map(c => `<option>${c}</option>`).join('')}</select></label><button data-a="deltrack">🗑 Pista</button>`;
    }
    const o = selObj(), s = AN.sel;
    if (o && s.k === 'key') h += `<h4>Fotograma clave</h4><label>Tiempo (s) <input class="small" type="number" step="0.01" data-of="t" value="${o.t}"></label><label>Valor ${ROT.includes(s.ch) ? '(°)' : ''} ${s.ch === 'emotion' ? `<select data-of="v">${A.FACE_EMOTIONS.map((n, i) => `<option value="${i}" ${i === Math.round(o.v) ? 'selected' : ''}>${n}</option>`).join('')}</select>` : `<input class="small" type="number" step="0.1" data-of="v" value="${toUi(s.ch, o.v)}">`}</label>
      <label>Curva <select data-of="ease">${A.EASINGS.map(e => `<option ${e === o.ease ? 'selected' : ''}>${e}</option>`).join('')}</select></label>${o.ease === 'bezier' ? `<label>Bézier <input data-of="bez" value="${esc((o.bez || []).join(','))}"></label>` : ''}<button data-a="delsel">🗑 Borrar clave</button>`;
    if (o && (s.k === 'lev' || s.k === 'aev')) h += `<h4>Evento</h4><label>Nombre <input data-of="name" value="${esc(o.name)}"></label><label>Tiempo <input class="small" type="number" step="0.01" data-of="t" value="${o.t}"></label><button data-a="delsel">🗑 Borrar</button>`;
    if (o && s.k === 'clip') h += `<h4>Símbolo</h4><label>Animación <select data-of="symbol">${AN.list.filter(x => x !== a).map(x => `<option value="${esc(x.id)}" ${x.id === o.symbol ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label><label>Inicio <input class="small" type="number" step="0.01" data-of="start" value="${o.start}"></label>
      <label><input type="checkbox" data-of="loop" ${o.loop ? 'checked' : ''}>Loop</label><label>Velocidad <input class="small" type="number" step="0.1" data-of="speed" value="${o.speed}"></label><label>Peso <input class="small" type="number" step="0.1" data-of="weight" value="${o.weight}"></label>
      <label>Remapear objetivos <input data-of="targets" placeholder="interno=externo, brazo=BrazoNPC" value="${esc(Object.entries(o.targets || {}).map(([k, v]) => k + '=' + v).join(', '))}"></label><button data-a="delsel">🗑 Quitar</button>`;
    h += `<div style="color:#8a95b0;margin-top:6px">Doble clic en una fila de canal = nueva clave. Arrastrá rombos, eventos y símbolos para moverlos. Clic en la regla = mover el cursor.</div>`;
    return h;
  }
  function updatePlayhead() { const p = $('an-ph'); if (p) p.style.left = (210 + X(AN.t)) + 'px'; }
  function parseTargets(s) { const o = {}; String(s).split(',').forEach(p => { const [k, v] = p.split('=').map(x => x && x.trim()); if (k && v) o[k] = v; }); return o; }

  function bind() {
    const root = $('cxan'), a = AN.cur;
    root.onclick = ev => {
      const t = ev.target; const act = t.dataset.a;
      if (t.dataset.layer !== undefined) { AN.layer = +t.dataset.layer; AN.track = -1; AN.sel = null; return render(); }
      if (t.dataset.track) { const [l, tr] = t.dataset.track.split(':').map(Number); AN.layer = l; AN.track = tr; AN.sel = null; return render(); }
      if (!act) return;
      const [name, arg] = act.split(':');
      ({ new: newAnim, dup: dupAnim, del: delAnim, play, pause, stop, rec: recordPose, exp: exportJson, imp: importJson, close: () => { stop(); root.classList.remove('open'); },
        copyid: () => { try { navigator.clipboard.writeText(a.id); toast('📋 ID copiado'); } catch (_) { prompt('ID', a.id); } },
        addlayer: addLayer, dellayer: () => { if (a.layers.length > 1 && confirm('¿Borrar la capa?')) { a.layers.splice(AN.layer, 1); AN.layer = 0; AN.track = -1; AN.sel = null; touch(); } },
        addtrack: () => addTrack(arg), addclip: addClip, addaev: () => addEvent('aev', AN.t), addlev: () => addEvent('lev', AN.t), deltrack: () => { layerOf().tracks.splice(AN.track, 1); AN.track = -1; touch(); },
        delsel: () => { const s = AN.sel; if (!s) return; const l = a.layers[s.l]; if (s.k === 'key') { l.tracks[s.tr].channels[s.ch].splice(s.i, 1); } else if (s.k === 'lev') l.events.splice(s.i, 1); else if (s.k === 'aev') a.events.splice(s.i, 1); else if (s.k === 'clip') l.clips.splice(s.i, 1); AN.sel = null; touch(); } }[name] || (() => { }))();
    };
    root.onchange = ev => {
      const t = ev.target, l = layerOf();
      if (t.id === 'an-sel') { stop(); AN.cur = AN.list.find(x => x.id === t.value); AN.layer = 0; AN.track = -1; AN.sel = null; rebuild(); return render(); }
      if (t.id === 'an-name') { a.name = t.value; return touch(); }
      if (t.id === 'an-len') { a.length = Math.max(0, +t.value) || undefined; return touch(); }
      if (t.id === 'an-fps') { a.fps = Math.max(1, +t.value || 30); return touch(); }
      if (t.id === 'an-loop') { a.loop = t.checked; return touch(); }
      if (t.id === 'an-model') { stop(); AN.model = t.value; return; }
      if (t.id === 'an-zoom') { AN.zoom = +t.value; return render(); }
      if (t.dataset.a === 'addch') { if (t.value) addChannel(AN.track, t.value); return; }
      if (t.dataset.lf && l) { const k = t.dataset.lf; l[k] = t.type === 'checkbox' ? t.checked : k === 'priority' ? A.priorityValue(t.value, l.priority) : (k === 'name' || k === 'mode' ? t.value : +t.value); return touch(); }
      if (t.dataset.tf && l && l.tracks[AN.track]) { l.tracks[AN.track][t.dataset.tf] = t.checked; return touch(); }
      if (t.dataset.of) {
        const o = selObj(), s = AN.sel; if (!o) return; const k = t.dataset.of;
        if (k === 'v') o.v = fromUi(s.ch, t.value); else if (k === 'bez') o.bez = t.value.split(',').map(Number); else if (k === 'targets') o.targets = parseTargets(t.value);
        else if (t.type === 'checkbox') o[k] = t.checked; else if (['name', 'ease', 'symbol'].includes(k)) o[k] = t.value; else o[k] = +t.value;
        if (s.k === 'key' && k === 't') a.layers[s.l].tracks[s.tr].channels[s.ch].sort((x, y) => x.t - y.t);
        return touch();
      }
    };
    const ruler = $('an-ruler'), tl = $('an-tl');
    const timeAt = (ev, el) => snap((ev.clientX - el.getBoundingClientRect().left) / AN.zoom);
    if (ruler) ruler.onpointerdown = ev => { ruler.setPointerCapture(ev.pointerId); scrub(timeAt(ev, ruler)); ruler.onpointermove = e2 => scrub(timeAt(e2, ruler)); ruler.onpointerup = () => { ruler.onpointermove = null; }; };
    if (tl) {
      tl.ondblclick = ev => {
        const lane = ev.target.closest('.lane'); if (!lane || ev.target.closest('.k,.ev,.clip')) return; const t = timeAt(ev, lane);
        if (lane.dataset.chlane) { const [l, tr, ch] = lane.dataset.chlane.split(':'); const keys = a.layers[+l].tracks[+tr].channels[ch]; const v = A.sampleKeys(keys, t); const i = addKeyAt(+l, +tr, ch, t, v === undefined ? 0 : v); AN.layer = +l; AN.track = +tr; AN.sel = { k: 'key', l: +l, tr: +tr, ch, i }; touch(); }
        else if (lane.dataset.lane === 'aev') addEvent('aev', t); else if (lane.dataset.lane && lane.dataset.lane.startsWith('lev:')) { AN.layer = +lane.dataset.lane.split(':')[1]; addEvent('lev', t); }
      };
      tl.onpointerdown = ev => {
        const el = ev.target.closest('.k,.ev,.clip'); if (!el) return; const lane = el.parentElement;
        let sel, getT, setT;
        if (el.dataset.key) { const [l, tr, ch, i] = el.dataset.key.split(':'); sel = { k: 'key', l: +l, tr: +tr, ch, i: +i }; }
        else if (el.dataset.ev) { const p = el.dataset.ev.split(':'); sel = p[0] === 'aev' ? { k: 'aev', i: +p[1] } : { k: 'lev', l: +p[1], i: +p[2] }; }
        else { const [l, i] = el.dataset.clip.split(':'); sel = { k: 'clip', l: +l, i: +i }; }
        AN.sel = sel; if (sel.l !== undefined) AN.layer = sel.l; if (sel.tr !== undefined) AN.track = sel.tr;
        const o = selObj(); const isClip = sel.k === 'clip'; getT = () => isClip ? o.start : o.t; setT = v => { if (isClip) o.start = v; else o.t = v; };
        const x0 = ev.clientX, t0 = getT(); let moved = false;
        const mv = e2 => { moved = true; setT(snap(t0 + (e2.clientX - x0) / AN.zoom)); el.style.left = X(getT()) + 'px'; if (sel.k === 'key') scrub(getT()); };
        const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (moved && sel.k === 'key') a.layers[sel.l].tracks[sel.tr].channels[sel.ch].sort((x, y) => x.t - y.t); touch(); };
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); ev.preventDefault();
      };
    }
  }

  function open() { ensureDom(); if (!AN.list.length && stMapId) { try { loadFrom(getMaps()[stMapId]); } catch (_) { /* nada */ } } AN.t = 0; AN.base.clear(); rebuild(); $('cxan').classList.add('open'); render(); }
  function addButton() {
    const ref = document.getElementById('cx-diag-btn') || document.getElementById('cx-prev-btn'); if (!ref || $('cx-anim-btn')) return;
    const b = document.createElement('button'); b.className = 'st-btn'; b.id = 'cx-anim-btn'; b.innerHTML = '🎞 Animador'; b.title = 'Animaciones con capas, fotogramas clave, eventos y símbolos'; b.onclick = open; ref.after(b);
  }
  function init() { hooks(); let n = 0; const t = setInterval(() => { addButton(); if ($('cx-anim-btn') || ++n > 40) clearInterval(t); }, 250); }
  window.CrixAnimator = { open, list: () => AN.list };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
