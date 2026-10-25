'use strict';
// ══════════════════════════════════════════════════════════════════
// Persistencia externa de Crix.
//
// Render (plan gratis) borra el disco local en cada deploy/reinicio. Este módulo
// guarda una copia de la base de datos y de los medios (videos, texturas) en un
// bucket compatible con S3 (Backblaze B2, Cloudflare R2, Supabase Storage, etc.)
// y la restaura al arrancar. El disco local sigue siendo la fuente que usa el
// servidor; el bucket es el respaldo duradero.
//
// Variables de entorno:
//   CRIX_S3_BUCKET, CRIX_S3_ACCESS_KEY_ID, CRIX_S3_SECRET_ACCESS_KEY  (obligatorias)
//   CRIX_S3_ENDPOINT   p. ej. https://s3.us-west-004.backblazeb2.com
//   CRIX_S3_REGION     (por defecto "auto"; en B2 es la región, p. ej. us-west-004)
//   CRIX_S3_PREFIX     carpeta dentro del bucket (opcional)
//   CRIX_PERSIST_DIR   alternativa para pruebas: usa una carpeta local como "bucket"
// Sin ninguna de ellas, todo funciona como antes (solo disco local).
// ══════════════════════════════════════════════════════════════════
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);

const env = process.env;
const DATA_FILE = path.resolve(env.CRIX_DATA_FILE || path.join(__dirname, 'crix_data.json'));
const DATA_BASE = path.join(path.dirname(DATA_FILE), path.basename(DATA_FILE, path.extname(DATA_FILE)));
const VIDEO_DIR = DATA_BASE + '_videos';
const TEX_DIR = DATA_BASE + '_textures';

const DB_KEY = 'db/crix_data.json.gz';
const BACKUP_PREFIX = 'db/backup-';
const BACKUPS_TO_KEEP = 7;
const DB_MIN_INTERVAL = 3000;   // ms mínimos entre subidas de la base

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isNotFound = e => !!e && (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.Code === 'NoSuchKey' || e.code === 'ENOENT' || e.$metadata?.httpStatusCode === 404);
async function retry(fn, tries = 4, base = 800) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < tries - 1) await sleep(base * 2 ** i); }
  }
  throw last;
}
async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  }));
}

// ── Drivers: get → Buffer|null · getToFile → bool · put · del · list → [{key,size}] ──
function s3Driver() {
  const S3 = require('@aws-sdk/client-s3');
  const bucket = env.CRIX_S3_BUCKET;
  const prefix = (env.CRIX_S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
  const K = key => prefix ? `${prefix}/${key}` : key;
  const unK = key => prefix ? key.slice(prefix.length + 1) : key;
  const client = new S3.S3Client({
    region: env.CRIX_S3_REGION || 'auto',
    endpoint: env.CRIX_S3_ENDPOINT || undefined,
    forcePathStyle: env.CRIX_S3_FORCE_PATH_STYLE !== '0',
    credentials: { accessKeyId: env.CRIX_S3_ACCESS_KEY_ID, secretAccessKey: env.CRIX_S3_SECRET_ACCESS_KEY },
    // Evita checksums extra que algunos servicios compatibles con S3 no aceptan.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    name: `S3 (${bucket}${prefix ? '/' + prefix : ''})`,
    async get(key) {
      try { const r = await client.send(new S3.GetObjectCommand({ Bucket: bucket, Key: K(key) })); return Buffer.from(await r.Body.transformToByteArray()); }
      catch (e) { if (isNotFound(e)) return null; throw e; }
    },
    async getToFile(key, dest) {
      let r;
      try { r = await client.send(new S3.GetObjectCommand({ Bucket: bucket, Key: K(key) })); }
      catch (e) { if (isNotFound(e)) return false; throw e; }
      await pipeline(r.Body, fs.createWriteStream(dest));
      return true;
    },
    async put(key, body, contentType) {
      await client.send(new S3.PutObjectCommand({ Bucket: bucket, Key: K(key), Body: body, ContentLength: body.length, ContentType: contentType || 'application/octet-stream' }));
    },
    async del(key) { await client.send(new S3.DeleteObjectCommand({ Bucket: bucket, Key: K(key) })); },
    async list(pfx) {
      const out = []; let token;
      do {
        const r = await client.send(new S3.ListObjectsV2Command({ Bucket: bucket, Prefix: K(pfx), ContinuationToken: token }));
        for (const o of r.Contents || []) out.push({ key: unK(o.Key), size: o.Size });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
  };
}

function dirDriver(root) {   // pruebas locales: una carpeta hace de bucket
  const P = key => {
    const p = path.resolve(root, key);
    if (p !== root && !p.startsWith(root + path.sep)) throw new Error('Clave inválida');
    return p;
  };
  const walk = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]) : [];
  return {
    name: `carpeta ${root}`,
    async get(key) { try { return await fsp.readFile(P(key)); } catch (e) { if (isNotFound(e)) return null; throw e; } },
    async getToFile(key, dest) { try { await fsp.copyFile(P(key), dest); return true; } catch (e) { if (isNotFound(e)) return false; throw e; } },
    async put(key, body) { await fsp.mkdir(path.dirname(P(key)), { recursive: true }); await fsp.writeFile(P(key), body); },
    async del(key) { await fsp.rm(P(key), { force: true }); },
    async list(pfx) {
      return walk(root).map(f => path.relative(root, f).split(path.sep).join('/')).filter(k => k.startsWith(pfx)).map(k => ({ key: k, size: fs.statSync(path.join(root, k)).size }));
    },
  };
}

let driver = null;
if (env.CRIX_S3_BUCKET) {
  if (env.CRIX_S3_ACCESS_KEY_ID && env.CRIX_S3_SECRET_ACCESS_KEY) driver = s3Driver();
  else console.warn('[PERSIST] Falta CRIX_S3_ACCESS_KEY_ID o CRIX_S3_SECRET_ACCESS_KEY: el almacenamiento externo queda desactivado');
} else if (env.CRIX_PERSIST_DIR) driver = dirDriver(path.resolve(env.CRIX_PERSIST_DIR));

let restored = false;
const inflight = new Set();          // subidas/borrados de archivos en curso
const retryQueue = new Map();        // key → ruta local, subidas que fallaron
const downloads = new Map();         // ruta local → promesa de descarga
function track(p) { inflight.add(p); p.finally(() => inflight.delete(p)); return p; }

// ── Medios ──
function putFile(key, localPath) {
  if (!driver) return Promise.resolve(true);
  return track((async () => {
    try { await retry(async () => driver.put(key, await fsp.readFile(localPath)), 3, 1000); retryQueue.delete(key); return true; }
    catch (e) { console.error(`[PERSIST] No se pudo subir ${key}: ${e.message} (se reintentará)`); retryQueue.set(key, localPath); return false; }
  })());
}
function delKey(key) {
  if (!driver) return Promise.resolve();
  retryQueue.delete(key);
  return track((async () => { try { await retry(() => driver.del(key), 3, 800); } catch (e) { console.warn(`[PERSIST] No se pudo borrar ${key}: ${e.message}`); } })());
}
function delPrefix(prefix) {
  if (!driver) return Promise.resolve();
  return track((async () => {
    try { for (const o of await retry(() => driver.list(prefix), 3, 800)) { retryQueue.delete(o.key); await retry(() => driver.del(o.key), 3, 800); } }
    catch (e) { console.warn(`[PERSIST] No se pudo borrar ${prefix}*: ${e.message}`); }
  })());
}
async function fetchTexture(mapId, tid) {   // baja una textura del bucket si no está en el disco (la extensión se descubre listando)
  if (!driver) return null;
  try {
    const found = await retry(() => driver.list(`textures/${mapId}/${tid}.`), 3, 800);
    if (!found.length) return null;
    const dest = path.resolve(TEX_DIR, found[0].key.slice('textures/'.length));
    if (!dest.startsWith(TEX_DIR + path.sep)) return null;
    return (await ensureLocal(found[0].key, dest)) ? dest : null;
  } catch (e) { console.warn(`[PERSIST] No se pudo buscar la textura ${tid}: ${e.message}`); return null; }
}
function ensureLocal(key, localPath) {   // descarga bajo demanda si el archivo no está en el disco
  if (fs.existsSync(localPath)) return Promise.resolve(true);
  if (!driver) return Promise.resolve(false);
  if (downloads.has(localPath)) return downloads.get(localPath);
  const tmp = `${localPath}.${process.pid}.part`;
  const p = (async () => {
    try {
      await fsp.mkdir(path.dirname(localPath), { recursive: true });
      const ok = await retry(() => driver.getToFile(key, tmp), 3, 800);
      if (!ok) { await fsp.rm(tmp, { force: true }); return false; }
      await fsp.rename(tmp, localPath);
      return true;
    } catch (e) {
      console.warn(`[PERSIST] No se pudo descargar ${key}: ${e.message}`);
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return false;
    } finally { downloads.delete(localPath); }
  })();
  downloads.set(localPath, p);
  return p;
}

// ── Base de datos ──
let pendingDb = null, dbUploading = false, dbTimer = null, lastDbUpload = 0, dbFailures = 0;
function saveDb(json) {
  if (!driver || !restored) return;
  pendingDb = json; kickDb();
}
function kickDb() {
  if (dbUploading || dbTimer || pendingDb === null) return;
  const wait = Math.max(0, DB_MIN_INTERVAL - (Date.now() - lastDbUpload)) + (dbFailures ? Math.min(60000, 2000 * 2 ** dbFailures) : 0);
  dbTimer = setTimeout(uploadDb, wait);
}
async function uploadDb() {
  dbTimer = null;
  if (pendingDb === null || dbUploading) return;
  const json = pendingDb; pendingDb = null; dbUploading = true;
  try {
    const gz = await gzip(Buffer.from(json, 'utf8'));
    await driver.put(DB_KEY, gz, 'application/gzip');
    lastDbUpload = Date.now(); dbFailures = 0;
    await dailyBackup(gz).catch(e => console.warn('[PERSIST] Respaldo diario falló:', e.message));
  } catch (e) {
    dbFailures++; if (pendingDb === null) pendingDb = json;
    console.error(`[PERSIST] No se pudo subir la base (intento ${dbFailures}): ${e.message}`);
  } finally { dbUploading = false; kickDb(); }
}
async function dailyBackup(gz) {   // un respaldo por día (el primero del día), se conservan los últimos 7
  const today = `${BACKUP_PREFIX}${new Date().toISOString().slice(0, 10)}.json.gz`;
  const existing = (await driver.list(BACKUP_PREFIX)).map(o => o.key).sort();
  if (!existing.includes(today)) { await driver.put(today, gz, 'application/gzip'); existing.push(today); existing.sort(); }
  for (const key of existing.slice(0, Math.max(0, existing.length - BACKUPS_TO_KEEP))) await driver.del(key);
}

// ── Espera a que todo lo pendiente llegue al bucket (se usa al apagar) ──
async function flush(timeoutMs = 25000) {
  if (!driver) return true;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (dbTimer) { clearTimeout(dbTimer); dbTimer = null; }
    if (pendingDb !== null && !dbUploading) await uploadDb();
    if (pendingDb === null && !dbUploading && inflight.size === 0) return true;
    await sleep(100);
  }
  console.error('[PERSIST] Tiempo agotado: puede haber cambios sin subir');
  return false;
}

// ── Arranque: restaurar la base; texturas y videos se bajan bajo demanda ──
function walkLocal(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walkLocal(path.join(dir, d.name)).map(f => path.join(d.name, f)) : [d.name]);
}
async function restore() {
  if (restored) return;
  if (!driver) { restored = true; console.log('[PERSIST] Sin almacenamiento externo: los datos viven solo en el disco local'); return; }
  console.log(`[PERSIST] Restaurando desde ${driver.name}…`);

  // Si algo falla acá se lanza el error: es preferible no arrancar antes que arrancar vacío y pisar la copia remota.
  const gz = await retry(() => driver.get(DB_KEY), 5, 1000);
  if (gz) {
    const json = (await gunzip(gz)).toString('utf8');
    const remoteV = Number(JSON.parse(json)._v) || 0;
    let localV = -1;
    if (fs.existsSync(DATA_FILE)) { try { localV = Number(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))._v) || 0; } catch { localV = -1; } }
    if (remoteV >= localV) {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(`${DATA_FILE}.restore.tmp`, json, 'utf8');
      fs.renameSync(`${DATA_FILE}.restore.tmp`, DATA_FILE);
      console.log(`[PERSIST] Base restaurada (versión ${remoteV})`);
    } else console.log(`[PERSIST] La base local (v${localV}) es más nueva que la remota (v${remoteV}); se conserva la local`);
  } else console.log('[PERSIST] Todavía no hay base remota');

  const remoteTex = await retry(() => driver.list('textures/'), 5, 1000);
  console.log(`[PERSIST] Texturas en el bucket: ${remoteTex.length} (se bajan bajo demanda)`);
  restored = true;

  // Migración / reparación: sube lo que exista en disco y falte en el bucket (en segundo plano).
  (async () => {
    const remoteVid = await retry(() => driver.list('videos/'), 3, 1000);
    const have = new Set([...remoteTex, ...remoteVid].map(o => o.key));
    const local = [
      ...walkLocal(VIDEO_DIR).map(f => ({ key: 'videos/' + f.split(path.sep).join('/'), file: path.join(VIDEO_DIR, f) })),
      ...walkLocal(TEX_DIR).map(f => ({ key: 'textures/' + f.split(path.sep).join('/'), file: path.join(TEX_DIR, f) })),
    ].filter(x => !have.has(x.key) && !x.file.endsWith('.part'));
    if (local.length) console.log(`[PERSIST] Subiendo ${local.length} archivo(s) locales que faltaban en el bucket`);
    await pool(local, 3, x => putFile(x.key, x.file));
  })().catch(e => console.warn('[PERSIST] Sincronización inicial falló:', e.message));

  setInterval(() => { for (const [key, file] of [...retryQueue]) if (fs.existsSync(file)) putFile(key, file); else retryQueue.delete(key); }, 60000).unref();
}

module.exports = {
  DATA_FILE, VIDEO_DIR, TEX_DIR,
  get enabled() { return !!driver; },
  get restored() { return restored; },
  restore, saveDb, putFile, delKey, delPrefix, ensureLocal, fetchTexture, flush,
};
