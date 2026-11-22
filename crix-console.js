'use strict';
// CrixConsole — salida (Output) flotante para ver errores y mensajes EN MEDIO del juego y en el editor.
//   · Captura window.onerror, promesas rechazadas, console.error/console.warn, errores de scripts locales y de servidor.
//   · Botón 🪲 con contador de errores (arriba a la derecha) y atajo F9. Se abre sola ante el primer error si está activado.
//   · Filtros (Todo / Info / Avisos / Errores), buscador, copiar, limpiar y repetidos agrupados (×N).
// API: CrixConsole.info|warn|error(fuente, texto), CrixConsole.add(nivel, fuente, texto), CrixConsole.open()/close()/toggle().
(function () {
  if (window.CrixConsole) return;
  const MAX = 600;
  const entries = [];
  const counts = { info: 0, warn: 0, error: 0 };
  let filter = 'all', query = '', panel = null, fab = null, listEl = null, badge = null, autoScroll = true, isOpen = false;
  const prefs = (() => { try { return JSON.parse(localStorage.getItem('crix_console_prefs') || '{}'); } catch (_) { return {}; } })();
  if (prefs.autoOpen === undefined) prefs.autoOpen = true;
  const savePrefs = () => { try { localStorage.setItem('crix_console_prefs', JSON.stringify(prefs)); } catch (_) { /* sin almacenamiento */ } };
  const nativeError = console.error.bind(console), nativeWarn = console.warn.bind(console);
  let reentrant = false;

  const clock = d => [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  const level = l => (l === 'err' || l === 'error') ? 'error' : (l === 'warn' || l === 'warning') ? 'warn' : 'info';

  function add(lvl, source, text) {
    lvl = level(lvl);
    text = String(text === undefined ? '' : text).slice(0, 2000);
    source = String(source || 'Sistema').slice(0, 60);
    const last = entries[entries.length - 1];
    if (last && last.level === lvl && last.source === source && last.text === text) { last.n++; last.t = Date.now(); counts[lvl]++; render(true); updateBadge(); return; }
    entries.push({ level: lvl, source, text, n: 1, t: Date.now() });
    counts[lvl]++;
    if (entries.length > MAX) { const old = entries.shift(); counts[old.level] = Math.max(0, counts[old.level] - old.n); }
    render(true); updateBadge();
    if (lvl === 'error' && prefs.autoOpen && !isOpen && inGameOrStudio()) open();
  }

  // La salida solo se ve en las PRUEBAS de Crix Hub (▶ probar tu juego desde el editor). Ni en el editor ni en un juego subido/publicado.
  function inGameOrStudio() {
    if (document.querySelector('#s-game.active')) { try { return typeof stPlaytesting !== 'undefined' && !!stPlaytesting; } catch (_) { return false; } }
    return false;
  }

  // ── Interfaz ──────────────────────────────────────────────────────────────
  function css() {
    if (document.getElementById('crix-console-css')) return;
    const st = document.createElement('style'); st.id = 'crix-console-css';
    st.textContent = `
#cc-fab{position:fixed;top:58px;right:10px;z-index:100000;width:40px;height:40px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:rgba(15,18,30,.82);color:#fff;font-size:18px;cursor:pointer;display:none;align-items:center;justify-content:center;backdrop-filter:blur(6px);touch-action:manipulation}
#cc-fab.show{display:flex}#cc-fab .cc-badge{position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;border-radius:9px;background:#ef4444;color:#fff;font:700 10px/18px system-ui,sans-serif;text-align:center;padding:0 4px;display:none}
#cc-fab.has-warn{border-color:#f59e0b}#cc-fab.has-err{border-color:#ef4444;animation:ccpulse 1.2s ease-out 2}
@keyframes ccpulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,.7)}100%{box-shadow:0 0 0 14px rgba(239,68,68,0)}}
#cc-panel{position:fixed;left:0;right:0;bottom:0;height:42vh;min-height:150px;max-height:85vh;z-index:100001;background:rgba(8,10,18,.96);border-top:1px solid #2a3350;display:none;flex-direction:column;font-family:ui-monospace,Menlo,Consolas,monospace;color:#d6dcf0;backdrop-filter:blur(8px)}
#cc-panel.open{display:flex}
#cc-grip{height:12px;cursor:ns-resize;display:flex;align-items:center;justify-content:center;touch-action:none;flex-shrink:0}#cc-grip i{width:44px;height:4px;border-radius:2px;background:#39425f}
#cc-bar{display:flex;gap:6px;align-items:center;padding:2px 8px 6px;flex-wrap:wrap;flex-shrink:0}
#cc-bar b{font:700 11px system-ui,sans-serif;letter-spacing:1.5px;color:#8f9bc4;margin-right:4px}
#cc-bar button,#cc-bar input{font:600 11px system-ui,sans-serif;background:#161b2e;color:#c9d1ee;border:1px solid #2a3350;border-radius:7px;padding:4px 8px;cursor:pointer}
#cc-bar button.on{background:#2a3a7a;border-color:#5b8def;color:#fff}#cc-bar input{cursor:text;flex:1;min-width:70px;max-width:180px}
#cc-list{flex:1;overflow:auto;padding:2px 10px 10px;font-size:11.5px;line-height:1.5;-webkit-overflow-scrolling:touch}
.cc-row{display:flex;gap:8px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,.04);white-space:pre-wrap;word-break:break-word}
.cc-t{color:#5e6a91;flex-shrink:0}.cc-s{color:#7c8ab8;flex-shrink:0;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-row.error{color:#ff8b8b;background:rgba(239,68,68,.07)}.cc-row.warn{color:#fcd34d}.cc-row.info{color:#d6dcf0}
.cc-n{background:#2a3350;color:#fff;border-radius:8px;padding:0 6px;font-size:10px;flex-shrink:0;height:15px}
.cc-empty{color:#5e6a91;padding:14px 4px;font-family:system-ui,sans-serif}`;
    document.head.appendChild(st);
  }
  const stop = e => e.stopPropagation();
  function build() {
    if (panel) return;
    css();
    fab = document.createElement('button'); fab.id = 'cc-fab'; fab.title = 'Output (F9)'; fab.setAttribute('aria-label', 'Abrir Output');
    fab.innerHTML = '🪲<span class="cc-badge"></span>'; badge = fab.querySelector('.cc-badge');
    fab.addEventListener('click', toggle);
    ['pointerdown', 'touchstart', 'mousedown'].forEach(ev => fab.addEventListener(ev, stop));
    panel = document.createElement('div'); panel.id = 'cc-panel';
    panel.innerHTML = '<div id="cc-grip"><i></i></div><div id="cc-bar"><b>OUTPUT</b>' +
      '<button data-f="all" class="on">Todo</button><button data-f="info">Info</button><button data-f="warn">Avisos <span id="cc-w">0</span></button><button data-f="error">Errores <span id="cc-e">0</span></button>' +
      '<input id="cc-q" placeholder="Buscar…" aria-label="Buscar en Output"><button id="cc-copy" title="Copiar todo">📋</button><button id="cc-clear" title="Limpiar">🧹</button>' +
      '<button id="cc-auto" title="Abrir sola ante un error">⚡ Auto</button><button id="cc-x" title="Cerrar (F9)">✕</button></div><div id="cc-list"></div>';
    document.body.appendChild(fab); document.body.appendChild(panel);
    listEl = panel.querySelector('#cc-list');
    ['pointerdown', 'touchstart', 'mousedown', 'keydown', 'keyup', 'wheel'].forEach(ev => panel.addEventListener(ev, stop, { passive: true }));
    panel.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { filter = b.dataset.f; panel.querySelectorAll('[data-f]').forEach(x => x.classList.toggle('on', x === b)); render(); }));
    panel.querySelector('#cc-q').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); render(); });
    panel.querySelector('#cc-clear').addEventListener('click', clear);
    panel.querySelector('#cc-x').addEventListener('click', close);
    panel.querySelector('#cc-copy').addEventListener('click', copy);
    const auto = panel.querySelector('#cc-auto'); auto.classList.toggle('on', !!prefs.autoOpen);
    auto.addEventListener('click', () => { prefs.autoOpen = !prefs.autoOpen; auto.classList.toggle('on', prefs.autoOpen); savePrefs(); });
    listEl.addEventListener('scroll', () => { autoScroll = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 24; }, { passive: true });
    // redimensionar arrastrando el borde superior
    const grip = panel.querySelector('#cc-grip'); let sy = 0, sh = 0, drag = false;
    grip.addEventListener('pointerdown', e => { drag = true; sy = e.clientY; sh = panel.offsetHeight; grip.setPointerCapture(e.pointerId); });
    grip.addEventListener('pointermove', e => { if (drag) panel.style.height = Math.max(150, Math.min(innerHeight * 0.85, sh + (sy - e.clientY))) + 'px'; });
    grip.addEventListener('pointerup', () => { drag = false; });
    setInterval(() => { const ok = inGameOrStudio(); fab.classList.toggle('show', ok); if (!ok && isOpen) close(); }, 400);
    window.addEventListener('keydown', e => { if (e.key === 'F9' && inGameOrStudio()) { e.preventDefault(); toggle(); } });
    render(); updateBadge();
  }
  function updateBadge() {
    if (!fab) return;
    const bad = counts.error;
    badge.style.display = bad ? 'block' : 'none'; badge.textContent = bad > 99 ? '99+' : bad;
    fab.classList.toggle('has-err', bad > 0); fab.classList.toggle('has-warn', !bad && counts.warn > 0);
    const w = panel && panel.querySelector('#cc-w'), e = panel && panel.querySelector('#cc-e');
    if (w) w.textContent = counts.warn; if (e) e.textContent = counts.error;
  }
  function render(incremental) {
    if (!listEl) return;
    if (incremental && !isOpen) return;
    const shown = entries.filter(x => (filter === 'all' || x.level === filter) && (!query || (x.source + ' ' + x.text).toLowerCase().includes(query)));
    listEl.textContent = '';
    if (!shown.length) { const d = document.createElement('div'); d.className = 'cc-empty'; d.textContent = entries.length ? 'Nada coincide con el filtro.' : 'Sin mensajes. Los errores de tus scripts, de las uniones y del juego aparecen acá.'; listEl.appendChild(d); return; }
    const frag = document.createDocumentFragment();
    for (const x of shown) {
      const row = document.createElement('div'); row.className = 'cc-row ' + x.level;
      const t = document.createElement('span'); t.className = 'cc-t'; t.textContent = clock(new Date(x.t));
      const s = document.createElement('span'); s.className = 'cc-s'; s.textContent = x.source; s.title = x.source;
      const m = document.createElement('span'); m.style.flex = '1'; m.textContent = (x.level === 'error' ? '✖ ' : x.level === 'warn' ? '⚠ ' : '') + x.text;
      row.append(t, s, m);
      if (x.n > 1) { const n = document.createElement('span'); n.className = 'cc-n'; n.textContent = '×' + x.n; row.appendChild(n); }
      frag.appendChild(row);
    }
    listEl.appendChild(frag);
    if (autoScroll) listEl.scrollTop = listEl.scrollHeight;
  }
  function open() { build(); isOpen = true; panel.classList.add('open'); render(); }
  function close() { isOpen = false; if (panel) panel.classList.remove('open'); }
  function toggle() { build(); isOpen ? close() : open(); }
  function clear() { entries.length = 0; counts.info = counts.warn = counts.error = 0; render(); updateBadge(); }
  function copy() {
    const text = entries.map(x => '[' + clock(new Date(x.t)) + '] [' + x.level + '] ' + x.source + ': ' + x.text + (x.n > 1 ? ' (x' + x.n + ')' : '')).join('\n');
    (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text) : Promise.reject()).catch(() => {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (_) { /* nada */ } ta.remove();
    });
  }

  // ── Captura automática ────────────────────────────────────────────────────
  window.addEventListener('error', e => {
    const where = e.filename ? ' (' + String(e.filename).split('/').pop() + (e.lineno ? ':' + e.lineno : '') + ')' : '';
    if (e.message === 'Script error.' && !e.filename) return;                 // errores de otros orígenes sin detalle
    if (/ResizeObserver loop/.test(e.message || '')) return;
    add('error', 'JavaScript', (e.message || 'Error') + where);
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason; add('error', 'Promesa', r && r.message ? r.message : String(r));
  });
  console.error = function () { nativeError.apply(null, arguments); if (reentrant) return; reentrant = true; try { add('error', 'console', Array.from(arguments).map(a => a && a.message ? a.message : (typeof a === 'object' ? safeJson(a) : String(a))).join(' ')); } finally { reentrant = false; } };
  console.warn = function () { nativeWarn.apply(null, arguments); if (reentrant) return; reentrant = true; try { add('warn', 'console', Array.from(arguments).map(a => typeof a === 'object' ? safeJson(a) : String(a)).join(' ')); } finally { reentrant = false; } };
  function safeJson(v) { try { return JSON.stringify(v).slice(0, 400); } catch (_) { return String(v); } }

  window.CrixConsole = { add, info: (s, t) => add('info', s, t), warn: (s, t) => add('warn', s, t), error: (s, t) => add('error', s, t), open, close, toggle, clear, entries, counts };
  if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
})();
