/*
 * CRIX ENGINE BRIDGE — conecta el HTML/JS con el motor C++ compilado a WASM
 * Este archivo va en public/crix_bridge.js
 * Se carga después de crix_engine.js (el output de Emscripten)
 */

const CrixBridge = (() => {
  let engine   = null;   // instancia del módulo WASM
  let canvas   = null;
  let ctx      = null;
  let rafId    = null;
  let lastTime = 0;
  let ready    = false;

  // Funciones del motor (se bindean después de cargar el WASM)
  let _init, _frame, _input, _resize, _addPart, _removePart,
      _clearParts, _selectPart, _setLighting, _setPlayerColor,
      _setPlayerPos, _setMode, _camScroll, _getPlayerState, _isReady;

  // Input state
  const keys  = {};
  let joyX=0, joyY=0;
  let mouseRMB=false, lastMX=0, lastMY=0;

  // ── Cargar el módulo WASM ──
  async function load(canvasId) {
    canvas = document.getElementById(canvasId);
    if (!canvas) { console.error('[Bridge] Canvas no encontrado:', canvasId); return false; }

    // Verificar que CrixEngine esté disponible (cargado por el script tag)
    if (typeof CrixEngine === 'undefined') {
      console.warn('[Bridge] crix_engine.js no cargado — usando fallback Three.js');
      return false;
    }

    try {
      engine = await CrixEngine({
        canvas,
        // Redirigir stdout del C++ a la consola del browser
        print:      (s) => console.log('[WASM]', s),
        printErr:   (s) => console.error('[WASM ERR]', s),
      });

      // Bindear funciones exportadas
      _init           = engine.cwrap('crix_init',            null,   ['number','number','number']);
      _frame          = engine.cwrap('crix_frame',           null,   ['number']);
      _input          = engine.cwrap('crix_input',           null,   ['number','number','number','number','number','number','number','number','number','number']);
      _resize         = engine.cwrap('crix_resize',          null,   ['number','number']);
      _addPart        = engine.cwrap('crix_add_part',        null,   ['number','number','number','number','number','number','number','number','number','number','number','number','number','number','number','number','number']);
      _removePart     = engine.cwrap('crix_remove_part',     null,   ['number']);
      _clearParts     = engine.cwrap('crix_clear_parts',     null,   []);
      _selectPart     = engine.cwrap('crix_select_part',     null,   ['number']);
      _setLighting    = engine.cwrap('crix_set_lighting',    null,   ['number','number','number','number','number','number','number','number','number','number','number','number','number']);
      _setPlayerColor = engine.cwrap('crix_set_player_color',null,   ['number','number','number']);
      _setPlayerPos   = engine.cwrap('crix_set_player_pos',  null,   ['number','number','number']);
      _setMode        = engine.cwrap('crix_set_mode',        null,   ['number']);
      _camScroll      = engine.cwrap('crix_cam_scroll',      null,   ['number']);
      _getPlayerState = engine.cwrap('crix_get_player_state','string',[]);
      _isReady        = engine.cwrap('crix_is_ready',        'number',[]);

      console.log('[Bridge] Motor C++ WASM cargado correctamente');
      return true;
    } catch(e) {
      console.error('[Bridge] Error cargando WASM:', e);
      return false;
    }
  }

  // ── Inicializar para el juego ──
  async function startGame(canvasId, mapData, playerData) {
    const ok = await load(canvasId);
    if (!ok) return false;

    const w = canvas.clientWidth  || 800;
    const h = canvas.clientHeight || 600;
    canvas.width = w; canvas.height = h;

    _init(w, h, 0); // modo GAME

    // Color del jugador
    if (playerData?.color) {
      const [r,g,b] = hexToRGB(playerData.color);
      _setPlayerColor(r, g, b);
    }

    // Cargar partes del mapa
    if (mapData?.parts) loadParts(mapData.parts);

    // Lighting del mapa
    if (mapData?.lighting) applyLighting(mapData.lighting);

    // SpawnPoint
    const spawn = mapData?.parts?.find(p => p.type === 'Spawn');
    if (spawn) _setPlayerPos(spawn.x, spawn.y + (spawn.sy||0.4)/2 + 0.1, spawn.z);

    setupInput(canvas);
    startLoop();
    ready = true;
    return true;
  }

  // ── Inicializar para el Studio ──
  async function startStudio(canvasId, mapData) {
    const ok = await load(canvasId);
    if (!ok) return false;

    const w = canvas.clientWidth  || 900;
    const h = canvas.clientHeight || 600;
    canvas.width = w; canvas.height = h;

    _init(w, h, 1); // modo STUDIO

    if (mapData?.parts) loadParts(mapData.parts);
    if (mapData?.lighting) applyLighting(mapData.lighting);

    setupInput(canvas);
    startLoop();
    ready = true;
    return true;
  }

  // ── Loop principal ──
  function startLoop() {
    lastTime = performance.now();
    function loop(now) {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      if (_isReady && _isReady()) {
        sendInput();
        _frame(dt);
      }
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    ready = false;
  }

  // ── Input ──
  function sendInput() {
    const mdx = mouseRMB ? (window._cmx||0) : 0;
    const mdy = mouseRMB ? (window._cmy||0) : 0;
    window._cmx = 0; window._cmy = 0;
    _input(
      joyX, joyY,
      keys['KeyW']?1:0, keys['KeyA']?1:0, keys['KeyS']?1:0, keys['KeyD']?1:0,
      keys['Space']?1:0,
      mouseRMB?1:0, mdx, mdy
    );
  }

  function setupInput(cvs) {
    window.addEventListener('keydown', e => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      keys[e.code] = true;
    });
    window.addEventListener('keyup',  e => { delete keys[e.code]; });

    cvs.addEventListener('mousedown', e => { if(e.button===2){mouseRMB=true;lastMX=e.clientX;lastMY=e.clientY;} });
    window.addEventListener('mouseup',  e => { if(e.button===2) mouseRMB=false; });
    window.addEventListener('mousemove',e => {
      if (mouseRMB) {
        window._cmx = (window._cmx||0) + (e.clientX-lastMX);
        window._cmy = (window._cmy||0) + (e.clientY-lastMY);
        lastMX=e.clientX; lastMY=e.clientY;
      }
    });
    cvs.addEventListener('wheel', e => { _camScroll && _camScroll(e.deltaY * 0.05); }, {passive:true});
    cvs.addEventListener('contextmenu', e => e.preventDefault());

    // Touch (móvil)
    let touchCamId=null, touchCX=0, touchCY=0;
    cvs.addEventListener('touchstart', e => {
      for(const t of e.changedTouches){
        if(touchCamId===null){ touchCamId=t.identifier; touchCX=t.clientX; touchCY=t.clientY; }
      }
    }, {passive:false});
    cvs.addEventListener('touchmove', e => {
      e.preventDefault();
      for(const t of e.changedTouches){
        if(t.identifier===touchCamId){
          window._cmx=(window._cmx||0)+(t.clientX-touchCX)*0.7;
          window._cmy=(window._cmy||0)+(t.clientY-touchCY)*0.7;
          touchCX=t.clientX; touchCY=t.clientY;
          mouseRMB=true;
        }
      }
    }, {passive:false});
    cvs.addEventListener('touchend', () => { touchCamId=null; mouseRMB=false; });

    // Resize
    const ro = new ResizeObserver(() => {
      if (!cvs || !_resize) return;
      const w=cvs.clientWidth||800, h=cvs.clientHeight||600;
      cvs.width=w; cvs.height=h;
      _resize(w, h);
    });
    ro.observe(cvs);
  }

  // ── API pública ──
  function loadParts(parts) {
    if (!_clearParts) return;
    _clearParts();
    for (const p of parts) {
      if (p.type === 'Spawn') continue;
      const [r,g,b] = hexToRGB(p.color || '#888888');
      const typeMap = {Block:0,Sphere:1,Cylinder:2,Wedge:3,Spawn:4,NPC:5};
      const t = typeMap[p.type] ?? 0;
      _addPart(
        getPartId(p.id), t,
        p.x||0, p.y||0, p.z||0,
        p.sx||4, p.sy||4, p.sz||4,
        p.ry||0,
        r, g, b,
        p.roughness ?? 0.6, p.metallic ?? 0.0, p.transparent || 0,
        p.anchored?1:0, p.canCollide!==false?1:0
      );
    }
  }

  function addPart(p) {
    if (!_addPart) return;
    const [r,g,b] = hexToRGB(p.color || '#888888');
    const typeMap = {Block:0,Sphere:1,Cylinder:2,Wedge:3,Spawn:4,NPC:5};
    _addPart(
      getPartId(p.id), typeMap[p.type]??0,
      p.x||0, p.y||0, p.z||0,
      p.sx||4, p.sy||4, p.sz||4,
      p.ry||0, r,g,b,
      p.roughness??0.6, p.metallic??0.0, p.transparent||0,
      p.anchored?1:0, p.canCollide!==false?1:0
    );
  }

  function removePart(id)   { _removePart  && _removePart(getPartId(id)); }
  function selectPart(id)   { _selectPart  && _selectPart(getPartId(id)); }
  function setMode(m)       { _setMode     && _setMode(m); }

  function applyLighting(L) {
    if (!_setLighting) return;
    const [ar,ag,ab] = hexToRGB(L.ambient  || '#334466');
    const fog        = L.fogColor || '#87ceeb';
    const [fr,fg,fb] = hexToRGB(fog);
    _setLighting(
      ar,ag,ab,       // ambient
      1,0.98,0.9,     // light color
      0.4,1,0.6,      // light dir
      fr,fg,fb,       // fog color
      L.fogDensity ?? 0.007
    );
  }

  function setPlayerColor(hex) {
    if (!_setPlayerColor) return;
    const [r,g,b] = hexToRGB(hex);
    _setPlayerColor(r,g,b);
  }

  function getPlayerState() {
    if (!_getPlayerState || !ready) return null;
    try { return JSON.parse(_getPlayerState()); } catch { return null; }
  }

  function setJoystick(x, y) { joyX=x; joyY=y; }

  // ── Helpers ──
  const _idMap = {};
  let   _idCtr = 1;
  function getPartId(strId) {
    if (!_idMap[strId]) _idMap[strId] = _idCtr++;
    return _idMap[strId];
  }

  function hexToRGB(hex) {
    const c = hex.replace('#','');
    const n = parseInt(c, 16);
    if (c.length === 6) return [(n>>16&0xff)/255, (n>>8&0xff)/255, (n&0xff)/255];
    if (c.length === 3) {
      return [((n>>8&0xf)*17)/255, ((n>>4&0xf)*17)/255, ((n&0xf)*17)/255];
    }
    return [0.5,0.5,0.5];
  }

  return {
    startGame, startStudio, stopLoop,
    loadParts, addPart, removePart, selectPart,
    setMode, applyLighting, setPlayerColor, setJoystick,
    getPlayerState,
    get ready() { return ready; },
  };
})();

window.CrixBridge = CrixBridge;
