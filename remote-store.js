// Almacenamiento externo GRATUITO para que cuentas, mapas y mensajes sobrevivan a cada deploy
// en hostings con disco efímero (Render free, etc.). Usa cualquier Postgres: Neon, Supabase, etc.
// Se activa definiendo la variable de entorno DATABASE_URL.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const URL_ = process.env.DATABASE_URL;
const enabled = !!URL_;
let pool = null;
function getPool() {
  if (pool) return pool;
  const local = /@(localhost|127\.0\.0\.1)/.test(URL_) || /sslmode=disable/.test(URL_);
  pool = new Pool({ connectionString: URL_, max: 2, connectionTimeoutMillis: 15000, ssl: local ? false : { rejectUnauthorized: false } });
  pool.on('error', e => console.error('[Remote] Error de conexión:', e.message));
  return pool;
}
async function ensureTable() {
  await getPool().query('CREATE TABLE IF NOT EXISTS crix_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  await getPool().query('CREATE TABLE IF NOT EXISTS crix_files (key TEXT PRIMARY KEY, data BYTEA NOT NULL, size INTEGER NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
}
// id 1 = estado actual · id 2 = copia anterior (rotada cada 10 min)
async function fetchSnapshot() {
  await ensureTable();
  const r = await getPool().query('SELECT data FROM crix_state WHERE id = 1');
  return r.rows[0]?.data || null;
}

let lastBackup = 0, inflight = false, pending = null, idleWaiters = [];
async function writeNow(json) {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    if (Date.now() - lastBackup > 10 * 60 * 1000) {
      await c.query("INSERT INTO crix_state (id, data) SELECT 2, data FROM crix_state WHERE id = 1 ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()");
      lastBackup = Date.now();
    }
    await c.query('INSERT INTO crix_state (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [json]);
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
  finally { c.release(); }
}
// Encola el último estado; si ya hay una escritura en curso, solo se conserva la más reciente.
function push(json) {
  if (!enabled) return;
  pending = json;
  if (inflight) return;
  inflight = true;
  (async () => {
    while (pending !== null) {
      const j = pending; pending = null;
      try { await writeNow(j); }
      catch (e) { console.error('[Remote] Error al guardar (se reintentará):', e.message); if (pending === null) pending = j; await new Promise(r => setTimeout(r, 5000)); }
    }
    inflight = false;
    notifyIdle();
  })();
}
function notifyIdle() { if (!inflight && pending === null && !fileBusy) idleWaiters.splice(0).forEach(r => r()); }

// ── Archivos binarios (videos y texturas) ──
// Cola serializada: respeta el orden (borrar → subir) y reintenta si Postgres falla un momento.
const fileOps = []; let fileBusy = false;
function enqueueFile(label, fn) {
  if (!enabled) return;
  fileOps.push({ label, fn });
  if (fileBusy) return;
  fileBusy = true;
  (async () => {
    while (fileOps.length) {
      const op = fileOps[0];
      let ok = false;
      for (let attempt = 1; attempt <= 30 && !ok; attempt++) {
        try { await op.fn(); ok = true; }
        catch (e) { console.error(`[Remote] ${op.label} falló (intento ${attempt}/30): ${e.message}`); await new Promise(r => setTimeout(r, 5000)); }
      }
      if (!ok) console.error(`[Remote] ❌ NO se pudo sincronizar ${op.label}. Revisá el espacio de tu base de datos.`);
      fileOps.shift();
    }
    fileBusy = false;
    notifyIdle();
  })();
}
function putFile(key, buffer) {
  enqueueFile(`subir ${key}`, async () => { await ensureTable(); await getPool().query('INSERT INTO crix_files (key, data, size, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, size = EXCLUDED.size, updated_at = now()', [key, buffer, buffer.length]); });
}
function delFile(key) { enqueueFile(`borrar ${key}`, () => getPool().query('DELETE FROM crix_files WHERE key = $1', [key])); }
function delPrefix(prefix) { enqueueFile(`borrar ${prefix}*`, () => getPool().query('DELETE FROM crix_files WHERE left(key, length($1)) = $1', [prefix])); }

// Descarga bajo demanda a disco local (cache). Devuelve true si el archivo queda disponible.
const restoring = new Map();
function writeLocal(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data); fs.renameSync(tmp, file);
}
function ensureFile(key, localFile) {
  if (fs.existsSync(localFile)) return Promise.resolve(true);
  if (!enabled) return Promise.resolve(false);
  if (restoring.has(key)) return restoring.get(key);
  const pr = (async () => {
    try {
      const r = await getPool().query('SELECT data FROM crix_files WHERE key = $1', [key]);
      if (!r.rows[0]) return false;
      writeLocal(localFile, r.rows[0].data); return true;
    } catch (e) { console.error(`[Remote] No se pudo restaurar ${key}:`, e.message); return false; }
    finally { restoring.delete(key); }
  })();
  restoring.set(key, pr); return pr;
}
function ensureDir(prefix, localDir) {
  if (!enabled) return Promise.resolve(false);
  const k = 'dir:' + prefix;
  if (restoring.has(k)) return restoring.get(k);
  const pr = (async () => {
    try {
      const r = await getPool().query('SELECT key, data FROM crix_files WHERE left(key, length($1)) = $1', [prefix]);
      for (const row of r.rows) { const f = path.join(localDir, row.key.slice(prefix.length)); if (!fs.existsSync(f)) writeLocal(f, row.data); }
      return r.rows.length > 0;
    } catch (e) { console.error(`[Remote] No se pudo restaurar ${prefix}:`, e.message); return false; }
    finally { restoring.delete(k); }
  })();
  restoring.set(k, pr); return pr;
}
function walk(dir, base = dir, out = []) {
  let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f, base, out); else if (!e.name.endsWith('.tmp')) out.push({ file: f, rel: path.relative(base, f).split(path.sep).join('/') }); }
  return out;
}
// Sube a Postgres los archivos locales que todavía no estén (migración inicial / reparación).
async function syncUp(dirs) {
  if (!enabled) return;
  try {
    await ensureTable();
    const have = new Set((await getPool().query('SELECT key FROM crix_files')).rows.map(r => r.key));
    let n = 0;
    for (const { dir, prefix } of dirs) for (const { file, rel } of walk(dir)) {
      const key = prefix + rel; if (have.has(key)) continue;
      try { putFile(key, fs.readFileSync(file)); n++; } catch {}
    }
    if (n) console.log(`[Remote] Subiendo ${n} archivo(s) locales que faltaban en Postgres`);
    const u = await usage();
    console.log(`[Remote] Archivos en Postgres: ${u.files} (${(u.bytes / 1048576).toFixed(1)} MB)`);
  } catch (e) { console.error('[Remote] syncUp:', e.message); }
}
async function usage() {
  await ensureTable();
  const f = (await getPool().query('SELECT count(*)::int AS n, COALESCE(sum(size),0)::bigint AS b FROM crix_files')).rows[0];
  const db = (await getPool().query('SELECT pg_database_size(current_database())::bigint AS b')).rows[0];
  return { files: f.n, bytes: Number(f.b), dbBytes: Number(db.b) };
}
function flush(timeoutMs = 25000) {
  if (!enabled) return Promise.resolve();
  if (!inflight && pending === null && !fileBusy) return Promise.resolve();
  return Promise.race([new Promise(r => idleWaiters.push(r)), new Promise(r => setTimeout(r, timeoutMs))]);
}

// Modo CLI: `node remote-store.js restore <ruta>` — lo usa server.js al arrancar (de forma síncrona).
if (require.main === module && process.argv[2] === 'restore') {
  const target = process.argv[3];
  (async () => {
    if (!enabled) process.exit(0);
    const remote = await fetchSnapshot();
    if (remote) {
      JSON.parse(remote); // validar antes de escribir
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target + '.tmp', remote, 'utf8'); fs.renameSync(target + '.tmp', target);
      console.log(`[Remote] Base restaurada desde Postgres (${(remote.length / 1024).toFixed(0)} KB)`);
    } else if (fs.existsSync(target)) {
      await writeNow(fs.readFileSync(target, 'utf8'));
      console.log('[Remote] Postgres vacío: se subieron los datos locales existentes');
    } else {
      console.log('[Remote] Postgres vacío: se empieza con una base nueva');
    }
    await getPool().end();
  })().catch(e => { console.error('[Remote] ERROR:', e.message); process.exit(2); });
}
module.exports = { enabled, push, flush, putFile, delFile, delPrefix, ensureFile, ensureDir, syncUp, usage };
