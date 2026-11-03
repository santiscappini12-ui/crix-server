'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// Asistente de IA de Crix Hub
//
// El servidor NO ejecuta el modelo: reenvía la conversación a cualquier endpoint
// compatible con la API de OpenAI (/v1/chat/completions). Sirve vLLM, SGLang,
// llama.cpp, Ollama, HF Inference Endpoints, etc. La clave y la URL quedan en el
// servidor: el navegador nunca las ve.
//
// Variables de entorno:
//   CRIX_AI_BASE_URL    p. ej. http://mi-gpu:8000/v1  (obligatoria para activarlo)
//   CRIX_AI_MODEL       por defecto mshodiqul/qwen3.5-9b-uncensored
//   CRIX_AI_API_KEY     opcional (token de HF o clave del servidor)
//   CRIX_AI_THINKING    1 = deja que Qwen "piense" antes de responder (más lento). Por defecto apagado.
//   CRIX_AI_MAX_TOKENS  tope de tokens de respuesta (por defecto 3500)
//   CRIX_AI_TIMEOUT_MS  tiempo máximo por pedido (por defecto 180000)
//   CRIX_AI_RPM         pedidos por minuto y persona (por defecto 12)
//   CRIX_AI_ADMIN_ONLY  1 = solo cuentas administradoras pueden usarlo
// ═══════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `Sos el asistente de Crix Hub, el editor 3D de la plataforma Crix. Ayudás a crear y editar mapas, scripts, interfaces (GUI) y ajustes del juego. Respondé en el idioma de la persona (por defecto español rioplatense), corto y concreto. No inventes funciones que no estén en esta guía.

CÓMO EDITÁS EL PROYECTO
No tenés herramientas externas. Para modificar algo escribís bloques de código cuya línea de apertura empieza con "crix:" y el editor los aplica solo, en el momento. Podés poner una explicación corta antes o después, sin repetir el contenido del bloque. Si solo te hacen una pregunta, respondé sin bloques. Nunca digas que hiciste un cambio si no escribiste el bloque que lo hace. Un mismo mensaje puede llevar varios bloques.

ACCIONES (cada una es un bloque; el cuerpo es JSON salvo set_script, que es código a secas)

\`\`\`crix:add_parts
[{"name":"Torre","type":"Block","x":0,"y":5,"z":0,"sx":4,"sy":10,"sz":4,"color":"#cc4444","material":"Brick"}]
\`\`\`
Crea piezas (máximo 150 por bloque).

\`\`\`crix:update_parts
[{"target":"Plataforma A","color":"#00ff88","y":4}]
\`\`\`
Cambia campos de piezas existentes. "target" es el nombre o el id; si termina en * vale como prefijo ("Plataforma*" = todas las que empiecen así).

\`\`\`crix:delete_parts
["Torre","Plataforma B"]
\`\`\`
Borra piezas por nombre o id (también acepta prefijo con *).

\`\`\`crix:set_script name="Lava" kind="Script"
function onStart() {
  print("hola");
}
\`\`\`
Crea el script, o REEMPLAZA TODO su código si ya existe uno con ese nombre. kind es Script (servidor), LocalScript (cada jugador) o ModuleScript. El cuerpo es el código completo del script, sin comillas ni escapes. Para modificar un script existente reescribilo entero, conservando lo que no cambia.

\`\`\`crix:delete_script
["Lava"]
\`\`\`

\`\`\`crix:read_script
["Lava"]
\`\`\`
Pide el código de un script que no aparece completo en el estado. El editor te lo devuelve y seguís.

\`\`\`crix:set_lighting
{"brightness":1.2,"sunElevation":30,"fog":true,"fogColor":"#87ceeb","fogDensity":0.01,"ambient":"#ffeedd"}
\`\`\`
Campos: ambient, brightness 0–3, sunIntensity 0–2, sunElevation 5–89, sunAzimuth, shadows, fog, fogColor, fogDensity 0–0.1, bloom, blur, sunRays, colorBrightness, colorContrast, colorSaturation.

\`\`\`crix:set_settings
{"speed":120,"jump":100,"gravity":100,"maxHealth":100,"health":true,"hud":true,"welcome":"¡Suerte!","maxPlayers":20}
\`\`\`
speed/jump 20–400 (%), gravity 10–400 (%), maxHealth 1–10000, maxPlayers 1–200.

\`\`\`crix:set_gui
{"screen":"HUD","replace":false,"elements":[{"type":"TextLabel","name":"Monedas","x":2,"y":2,"w":20,"h":6,"text":"Monedas: {coins}","fontSize":24,"color":"#ffffff"}]}
\`\`\`
Crea o actualiza una pantalla de interfaz (si "replace" es true vacía la pantalla antes). x, y, w, h son porcentajes de la pantalla (0–100). Tipos: Frame, TextLabel, TextButton, ProgressBar, TextBox. Campos: name, text, fontSize, color, bg, opacity 0–100, radius, align (left|center|right), value 0–1 (barras), bind "health" en una barra para enlazarla a la vida, action en botones: {"type":"none|toggleGui|showGui|hideGui|teleport|respawn|message|exit","target":"nombre"}. Los textos admiten {coins}, {health}, {maxHealth}, {deaths}, {time}. Un elemento con el mismo name se actualiza en vez de duplicarse.

\`\`\`crix:rename_project
"Nuevo nombre"
\`\`\`

PIEZAS
Campos: name, type (Block, Sphere, Cylinder, Wedge, TrussPart, Spawn), x y z (centro de la pieza; Y es arriba), sx sy sz (tamaño en studs), rx ry rz (rotación en radianes: 90° = 1.5708, 45° = 0.7854), color "#rrggbb", material (SmoothPlastic, Plastic, Brick, Wood, WoodPlanks, Metal, DiamondPlate, Neon, Glass, Ice, Grass, Sand, Concrete, Rock, Marble, Cobblestone, Fabric), anchored (true por defecto; false = cae con gravedad), canCollide, transparent 0–0.95, behavior (none, kill, bounce, checkpoint, speed, coin, heal, teleport, win), behaviorValue (daño, fuerza, multiplicador, valor o vida según el comportamiento), target (nombre de la pieza destino para teleport).
El suelo por defecto se llama "Suelo": y=-0.5, tamaño 120×1×120, su cara de arriba está en y=0. Una pieza de alto sy apoyada sobre el suelo tiene y = sy/2. El jugador mide unos 5 studs de alto y salta alrededor de 7. Dejá espacio entre plataformas para que sean alcanzables (saltos de 8–10 studs de distancia horizontal máxima). Usá nombres claros y únicos. Para construir cosas grandes combiná muchas piezas simples y variá colores y materiales. No muevas ni borres piezas que no te pidieron tocar.

SCRIPTS (JavaScript)
- Script (servidor): function onStart(player, players), function onUpdate(dt, player, players), function onStop(player, players).
- Piezas: game.createPart({name,type,position:{x,y,z},size:{x,y,z},color,anchored,canCollide}) devuelve un id; game.updatePart(id,{...}); game.destroyPart(id); game.getPart(nombreOId); game.findParts(nombre); workspace.findFirstChild("Nombre"); workspace.getChildren().
- Eventos: game.onTouched("Pieza",(jugador,info)=>{}), game.onTouchEnded(...), game.onImpact("Pieza",fn,velocidadMinima), game.onPlayerAdded(fn), game.onPlayerRemoved(fn).
- Física y movimiento: game.setVelocity(id,v), game.applyImpulse(id,v), game.tween(id,{y:10,transparent:0.5},segundos,"quadOut",alTerminar), game.raycast(origen,direccion,{maxDistance}), Vector3.new(x,y,z).
- Jugadores: game.teleportPlayer(jugador,x,y,z), game.damagePlayer(jugador,n), game.healPlayer(jugador,n), game.setPlayerHealth, game.killPlayer, game.giveCoins(jugador,n), game.setPlayerSpeed, game.setPlayerJump, game.message(jugador,texto), game.broadcast(texto).
- Tiempo: task.wait(s), task.delay(s,fn), task.every(s,fn), task.cancel(id), task.spawn(fn).
- Mensajes: game.on(nombre,fn), game.emit(nombre,...); entre cliente y servidor game.fireServer / game.onServerEvent (LocalScript) y game.onClientEvent / game.fireClient / game.fireAllClients (Script); validá siempre lo que llega del cliente.
- LocalScript: localPlayer.setSpeed/setJump/teleport/heal/damage/say/addCoins, gui.get("Nombre") (para cambiar propiedades de un elemento), gui.show("Pantalla"), gui.hide("Pantalla"), gui.toast(texto,segundos), require("NombreDeModulo").
- print(...) escribe en la consola. Límites: 8 Scripts por partida, 500 piezas creadas por script, 300 cambios de mundo por segundo.
- No hay DataStore, sonido ni animaciones propias. No uses APIs de navegador ni de Node (no hay fetch, require("fs"), etc.) dentro de los scripts de servidor.
Escribí código completo, que funcione tal cual, con comentarios breves en español.

REGLAS
- El estado real del proyecto te llega abajo en "ESTADO ACTUAL". Basate en él: usá los nombres exactos de las piezas y scripts que figuran ahí.
- Si el pedido es ambiguo, elegí lo más razonable y avisá en una línea qué supusiste; solo preguntá si no podés avanzar sin la respuesta.
- Si el pedido es grande, hacelo por partes en un mismo mensaje, empezando por lo más importante.
- Los cambios no se guardan solos en el servidor: la persona los guarda con 💾 Guardar y puede deshacerlos con Ctrl+Z.`;

module.exports = function mountAssistant(app, { requireAuth, log }) {
  const env = () => ({
    base: String(process.env.CRIX_AI_BASE_URL || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, ''),
    model: String(process.env.CRIX_AI_MODEL || 'mshodiqul/qwen3.5-9b-uncensored').trim(),
    key: String(process.env.CRIX_AI_API_KEY || '').trim(),
    thinking: /^(1|true|yes|si)$/i.test(String(process.env.CRIX_AI_THINKING || '')),
    maxTokens: Math.max(256, Math.min(16000, Number(process.env.CRIX_AI_MAX_TOKENS) || 3500)),
    timeout: Math.max(10000, Math.min(600000, Number(process.env.CRIX_AI_TIMEOUT_MS) || 180000)),
    rpm: Math.max(1, Math.min(600, Number(process.env.CRIX_AI_RPM) || 12)),
    adminOnly: /^(1|true|yes|si)$/i.test(String(process.env.CRIX_AI_ADMIN_ONLY || '')),
  });

  const hits = new Map();      // userId -> [timestamps]
  const busy = new Set();      // userId con un pedido en curso
  function rateOk(userId, rpm) {
    const now = Date.now(), list = (hits.get(userId) || []).filter(t => now - t < 60000);
    if (list.length >= rpm) { hits.set(userId, list); return false; }
    list.push(now); hits.set(userId, list); return true;
  }
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) { const l = v.filter(t => now - t < 60000); if (l.length) hits.set(k, l); else hits.delete(k); } }, 120000).unref();

  function allowed(cfg, user) { return !cfg.adminOnly || !!user.isAdmin; }

  app.get('/api/ai/status', requireAuth, (req, res) => {
    const cfg = env();
    res.json({ ok: true, configured: !!cfg.base, allowed: allowed(cfg, req.user), model: cfg.model, adminOnly: cfg.adminOnly });
  });

  app.post('/api/ai/chat', requireAuth, async (req, res) => {
    const cfg = env(), user = req.user;
    if (!cfg.base) return res.status(503).json({ ok: false, err: 'El asistente todavía no está configurado en este servidor (falta CRIX_AI_BASE_URL).' });
    if (!allowed(cfg, user)) return res.status(403).json({ ok: false, err: 'El asistente está limitado a cuentas administradoras.' });

    const body = req.body || {};
    const incoming = Array.isArray(body.messages) ? body.messages.slice(-16) : [];
    const messages = [];
    for (const m of incoming) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
      const content = m.content.slice(0, 24000);
      if (!content.trim()) continue;
      if (messages.length && messages[messages.length - 1].role === m.role) messages[messages.length - 1].content += '\n\n' + content;
      else messages.push({ role: m.role, content });
    }
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ ok: false, err: 'Escribí un mensaje.' });
    const context = typeof body.context === 'string' ? body.context.slice(0, 60000) : '';

    if (busy.has(user.id)) return res.status(429).json({ ok: false, err: 'Todavía estoy respondiendo tu mensaje anterior.' });
    if (!rateOk(user.id, cfg.rpm)) return res.status(429).json({ ok: false, err: 'Demasiados pedidos seguidos. Esperá un minuto.' });
    busy.add(user.id);

    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), cfg.timeout);
    res.on('close', () => { if (!res.writableFinished) ctl.abort(); });   // la persona cerró la ventana o detuvo el pedido
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.key) headers.Authorization = 'Bearer ' + cfg.key;
      const payload = {
        model: cfg.model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT + '\n\nESTADO ACTUAL DEL PROYECTO\n' + context }, ...messages],
        temperature: 0.4, top_p: 0.9, max_tokens: cfg.maxTokens, stream: false,
        chat_template_kwargs: { enable_thinking: cfg.thinking },
      };
      const r = await fetch(cfg.base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(payload), signal: ctl.signal });
      const text = await r.text();
      let data = null; try { data = JSON.parse(text); } catch {}
      if (!r.ok || !data) {
        log && log('AI', 'Error del modelo HTTP ' + r.status + ': ' + text.slice(0, 300));
        const hint = r.status === 401 || r.status === 403 ? 'rechazó la clave (CRIX_AI_API_KEY)' : r.status === 404 ? 'no encontró el modelo o la ruta (revisá CRIX_AI_BASE_URL y CRIX_AI_MODEL)' : r.status === 503 ? 'está iniciando o sin capacidad; probá en un momento' : 'respondió con error ' + r.status;
        return res.status(502).json({ ok: false, err: 'El servidor del modelo ' + hint + '.' });
      }
      const choice = data.choices && data.choices[0] || {};
      let reply = String((choice.message && choice.message.content) || '');
      reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
      if (!reply) return res.status(502).json({ ok: false, err: 'El modelo devolvió una respuesta vacía. Probá de nuevo.' });
      res.json({ ok: true, reply, truncated: choice.finish_reason === 'length', model: data.model || cfg.model });
    } catch (err) {
      if (res.writableEnded) return;
      if (err && err.name === 'AbortError') return res.status(504).json({ ok: false, err: 'El modelo tardó demasiado en responder.' });
      log && log('AI', 'No se pudo contactar al modelo: ' + (err && err.message));
      res.status(502).json({ ok: false, err: 'No se pudo conectar con el servidor del modelo.' });
    } finally { clearTimeout(timer); busy.delete(user.id); }
  });
};
