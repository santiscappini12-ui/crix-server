'use strict';
// ══════════════════════════════════════════════════════════════════
// Crix · Subida directa de medios al bucket
//
// Los medios NO se suben a Render. El navegador los sube directo al bucket (S3/Backblaze B2) con una
// URL firmada de un solo uso, y se reproducen directo desde el bucket (el servidor solo responde
// con una redirección 302 a una URL firmada). Render solo coordina permisos y metadatos.
//
//   1. presign   → el servidor autoriza y devuelve una URL firmada hacia  quarantine/<id>
//   2. PUT       → el navegador sube el archivo directo al bucket
//   3. commit    → el servidor lee el objeto en streaming (sin guardarlo en disco), calcula MD5/SHA-1/SHA-256,
//                  verifica la firma real del archivo y lo compara con las listas de hashes. Si pasa, el
//                  bucket lo copia (server-side, sin tráfico por Render) al destino final. Si no, lo borra.
//
// Sin bucket S3 configurado (desarrollo local) el mismo flujo funciona, pero los bytes pasan por el servidor.
// ══════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const guard = require('./media-guard');
const persist = require('./persist');

const MB = 1024 * 1024;
const KINDS = {
  video:   { max: 60 * MB,   family: 'video' },
  image:   { max: 5 * MB,    family: 'image' },   // fotos de perfil, miniaturas, imágenes de posts y de GUI
  texture: { max: 450 * 1024, family: 'image' },
};
const QDIR = path.join(os.tmpdir(), 'crix_quarantine');
const MEDIA_DIR = path.join(path.dirname(persist.DATA_FILE), path.basename(persist.DATA_FILE, path.extname(persist.DATA_FILE)) + '_media');
const pending = new Map();     // uploadId → { userId, kind, ref, size, ct, exp }
const perUser = new Map();     // userId → [timestamps]

let s3 = null, Presign = null;
function init() { s3 = persist.s3; if (s3) { Presign = require('@aws-sdk/s3-request-presigner'); ensureCors(); } return !!s3; }
const direct = () => !!s3;


// ── CORS del bucket ──
// El navegador sube y lee directo del bucket, así que el bucket tiene que autorizar el origen del sitio.
// Al arrancar (y cuando llega un origen nuevo del propio sitio) el servidor lo verifica y, si falta, lo configura.
// Requiere que la clave del bucket tenga permiso de escribir configuración del bucket; si no, deja instrucciones en el log.
const corsState = { ok: null, origins: [], error: null, checkedAt: 0, relayed: 0 };
const learnedOrigins = new Set();
let corsLock = Promise.resolve();
const normOrigin = o => String(o || '').trim().replace(/\/+$/, '');
const envOrigins = () => [...(process.env.CRIX_ORIGIN || '').split(','), process.env.RENDER_EXTERNAL_URL || '', process.env.KOYEB_PUBLIC_DOMAIN ? 'https://' + process.env.KOYEB_PUBLIC_DOMAIN : ''].map(normOrigin).filter(Boolean);
function manualCorsHelp(origins) {
  return `Configurá el CORS del bucket a mano: CRIX_ORIGIN=${origins.join(',') || 'https://tu-sitio'} npm run setup-cors (con una clave que tenga permiso de escribir configuración del bucket), o pegá estas reglas en el panel del bucket: ` +
    JSON.stringify({ AllowedOrigins: origins, AllowedMethods: ['GET', 'HEAD', 'PUT'], AllowedHeaders: ['*'] });
}
function ensureCors(extra = []) {
  corsLock = corsLock.then(async () => {
    if (!s3) return;
    const want = [...new Set([...envOrigins(), ...extra.map(normOrigin), ...learnedOrigins])].filter(Boolean);
    if (!want.length) { corsState.ok = false; corsState.error = 'No sé qué origen autorizar: definí CRIX_ORIGIN con la URL de tu sitio'; console.warn('[MEDIA] ⚠ ' + corsState.error); return; }
    corsState.origins = want; corsState.checkedAt = Date.now();
    try {
      let cur = []; try { cur = (await s3.client.send(new s3.S3.GetBucketCorsCommand({ Bucket: s3.bucket }))).CORSRules || []; } catch (e) { if (!/NoSuchCORS|NotFound|404/i.test(e.name + e.message)) throw e; }
      const mine = cur.find(r => r.ID === 'crix'), have = new Set((mine && mine.AllowedOrigins) || []);
      const covered = want.every(o => have.has(o) || cur.some(r => (r.AllowedOrigins || []).includes('*') && (r.AllowedMethods || []).includes('PUT')));
      if (covered) { corsState.ok = true; corsState.error = null; console.log('[MEDIA] CORS del bucket correcto para: ' + want.join(', ')); return; }
      const origins = [...new Set([...have, ...want])];
      const rule = { ID: 'crix', AllowedOrigins: origins, AllowedMethods: ['GET', 'HEAD', 'PUT'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range', 'Accept-Ranges'], MaxAgeSeconds: 3600 };
      await s3.client.send(new s3.S3.PutBucketCorsCommand({ Bucket: s3.bucket, CORSConfiguration: { CORSRules: [...cur.filter(r => r.ID !== 'crix'), rule] } }));
      corsState.ok = true; corsState.error = null; console.log('[MEDIA] CORS del bucket configurado para: ' + origins.join(', '));
    } catch (e) {
      corsState.ok = false; corsState.error = `${e.name}: ${e.message}`;
      console.warn('[MEDIA] ⚠ No pude configurar el CORS del bucket (' + corsState.error + '). Sin CORS, el navegador bloquea la subida directa. ' + manualCorsHelp(want));
    }
  }).catch(() => {});
  return corsLock;
}
// El propio sitio (Origin == Host) siempre es un origen legítimo: se autoriza solo, p. ej. con dominio propio.
function learnOrigin(origin, host) {
  if (!s3 || !origin) return;
  let u; try { u = new URL(origin); } catch { return; }
  const o = normOrigin(u.origin);
  if (u.host !== host || learnedOrigins.has(o) || envOrigins().includes(o)) return;
  learnedOrigins.add(o); ensureCors([o]);
}
// Opcional (CRIX_RELAY_FALLBACK=1): si la subida directa falla por CORS, el servidor la reenvía al bucket. Pasa por Render: por defecto apagado.
async function receiveRelay(user, uploadId, buf) {
  const e = pending.get(uploadId); if (!e || e.userId !== user.id) return { status: 404, err: 'Subida desconocida' };
  if (buf.length > e.size + 16 || buf.length > KINDS[e.kind].max) return { status: 413, err: 'Archivo demasiado grande' };
  await s3.client.send(new s3.S3.PutObjectCommand({ Bucket: s3.bucket, Key: s3.K('quarantine/' + uploadId), Body: buf, ContentType: e.ct }));
  corsState.relayed++; console.warn(`[MEDIA] ⚠ Subida retransmitida por el servidor (#${corsState.relayed}): el CORS del bucket no está funcionando.`);
  return { status: 200 };
}
const status = () => ({ direct: !!s3, cors: corsState, relayFallback: process.env.CRIX_RELAY_FALLBACK === '1' });

function localPath(key) {
  const [top, ...rest] = key.split('/'), name = rest.join('/');
  const base = top === 'videos' ? persist.VIDEO_DIR : top === 'textures' ? persist.TEX_DIR : MEDIA_DIR;
  const p = path.resolve(base, name);
  if (!p.startsWith(path.resolve(base) + path.sep)) throw new Error('Clave inválida');
  return p;
}
const MEDIA_KEY_RE = /^[0-9a-f]{64}\.(?:jpg|png|webp|gif|mp4|webm|ogv|mp3|wav)$/;
const mediaKey = (sha256, ext) => `media/${sha256}.${ext}`;

// ── Cola de verificaciones (cuida CPU y RAM del plan gratis) ──
let active = 0; const waiting = [];
async function slot(fn) {
  if (active >= 2) await new Promise(r => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; const n = waiting.shift(); if (n) n(); }
}

function rateOk(userId) {
  const now = Date.now(), list = (perUser.get(userId) || []).filter(t => now - t < 3600e3);
  if (list.length >= 120) return false;
  list.push(now); perUser.set(userId, list); return true;
}

// ── 1. presign ──
async function presign(user, { kind, size, mime, sha256, ref }) {
  const k = KINDS[kind]; if (!k) return { status: 400, err: 'Tipo de medio inválido' };
  if (user.mediaBanned) return { status: 403, err: 'Tu cuenta no puede subir medios' };
  size = Number(size);
  if (!Number.isFinite(size) || size <= 0) return { status: 400, err: 'Tamaño inválido' };
  if (size > k.max) return { status: 413, err: `El archivo supera el máximo de ${Math.round(k.max / MB * 10) / 10} MB` };
  if (!rateOk(user.id)) return { status: 429, err: 'Demasiadas subidas seguidas. Esperá un rato.' };
  if (sha256 && /^[0-9a-f]{64}$/i.test(sha256)) {                       // aviso temprano; el control real es el de commit
    const hit = guard.checkSha256Only(sha256); if (hit) return { status: 451, blocked: hit, sha256: sha256.toLowerCase(), err: 'Contenido bloqueado' };
  }
  const ct = /^[a-z]+\/[a-z0-9.+-]+$/i.test(String(mime || '')) ? String(mime).toLowerCase() : 'application/octet-stream';
  const uploadId = crypto.randomBytes(16).toString('hex');
  pending.set(uploadId, { userId: user.id, kind, ref: ref || null, size, ct, exp: Date.now() + 20 * 60e3 });
  if (!s3) return { status: 200, mode: 'server', uploadId, url: `/api/media/${uploadId}/blob`, headers: {} };
  const url = await Presign.getSignedUrl(s3.client, new s3.S3.PutObjectCommand({ Bucket: s3.bucket, Key: s3.K('quarantine/' + uploadId), ContentType: ct }), { expiresIn: 900 });
  return { status: 200, mode: 'direct', uploadId, url, headers: { 'Content-Type': ct } };
}
// Modo local: el archivo llega al servidor (solo desarrollo)
async function receiveLocal(user, uploadId, buf) {
  const e = pending.get(uploadId); if (!e || e.userId !== user.id) return { status: 404, err: 'Subida desconocida' };
  if (buf.length > e.size + 16 || buf.length > KINDS[e.kind].max) return { status: 413, err: 'Archivo demasiado grande' };
  await fsp.mkdir(QDIR, { recursive: true }); await fsp.writeFile(path.join(QDIR, uploadId), buf);
  return { status: 200 };
}

// ── 2/3. commit: verifica y promueve ──
async function readInfo(uploadId, max) {
  const hasher = guard.newHasher(), chunks = process.env.CRIX_SCAN_WEBHOOK_SEND_FILE === '1' ? [] : null;
  const take = async stream => { for await (const c of stream) { hasher.update(c); if (chunks) chunks.push(c); } };
  if (s3) {
    const key = s3.K('quarantine/' + uploadId);
    let head; try { head = await s3.client.send(new s3.S3.HeadObjectCommand({ Bucket: s3.bucket, Key: key })); } catch { return { err: 'El archivo no llegó al almacenamiento', status: 400 }; }
    if (head.ContentLength > max) { await s3.client.send(new s3.S3.DeleteObjectCommand({ Bucket: s3.bucket, Key: key })).catch(() => {}); return { err: 'El archivo supera el máximo permitido', status: 413 }; }
    const r = await s3.client.send(new s3.S3.GetObjectCommand({ Bucket: s3.bucket, Key: key }));
    await take(r.Body);
  } else {
    const f = path.join(QDIR, uploadId); if (!fs.existsSync(f)) return { err: 'El archivo no llegó', status: 400 };
    await take(fs.createReadStream(f));
  }
  return { info: hasher.digest(), buf: chunks ? Buffer.concat(chunks) : null };
}
async function dropQuarantine(uploadId) {
  try { if (s3) await s3.client.send(new s3.S3.DeleteObjectCommand({ Bucket: s3.bucket, Key: s3.K('quarantine/' + uploadId) })); else await fsp.rm(path.join(QDIR, uploadId), { force: true }); } catch {}
}
// destKey(info) → clave final (p. ej. 'videos/abc.mp4'); recibe la firma real detectada.
async function commit(user, uploadId, destKey, expect = {}) {
  const e = pending.get(uploadId);
  if (!e || e.userId !== user.id || e.exp < Date.now()) return { status: 404, err: 'La subida expiró o no existe' };
  if ((expect.kind && e.kind !== expect.kind) || (expect.ref !== undefined && e.ref !== expect.ref)) return { status: 403, err: 'Esta subida no corresponde a este destino' };
  const kind = KINDS[e.kind];
  return slot(async () => {
    const r = await readInfo(uploadId, kind.max); if (r.err) { pending.delete(uploadId); await dropQuarantine(uploadId); return { status: r.status, err: r.err }; }
    const { info, buf } = r, v = guard.verifyKind(info.head, kind.family);
    if (!v.ok) { pending.delete(uploadId); await dropQuarantine(uploadId); return { status: 415, err: v.err || 'Formato no permitido', signature: v.info && v.info.mime, sha256: info.sha256 }; }
    const hit = await guard.checkHashes(info, buf);
    if (hit) { pending.delete(uploadId); await dropQuarantine(uploadId); return { status: 451, blocked: hit, sha256: info.sha256, err: 'Contenido bloqueado' }; }
    const key = destKey(v.info, info);
    if (s3) {
      await s3.client.send(new s3.S3.CopyObjectCommand({ Bucket: s3.bucket, Key: s3.K(key), CopySource: encodeURI(`${s3.bucket}/${s3.K('quarantine/' + uploadId)}`), ContentType: v.info.mime, MetadataDirective: 'REPLACE', CacheControl: 'public, max-age=31536000, immutable' }));
      await dropQuarantine(uploadId);
    } else {
      const dest = localPath(key); await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.join(QDIR, uploadId), dest); await dropQuarantine(uploadId);
    }
    pending.delete(uploadId);
    return { status: 200, key, mime: v.info.mime, ext: v.info.ext, size: info.size, sha256: info.sha256, ref: e.ref, kind: e.kind };
  });
}

// ── Lectura ──
// URL firmada estable por ventana de tiempo (así el navegador puede cachear entre visitas).
async function readUrl(key, { privateAccess = false } = {}) {
  if (!s3) return null;
  const win = privateAccess ? 300e3 : 3600e3;
  return Presign.getSignedUrl(s3.client, new s3.S3.GetObjectCommand({ Bucket: s3.bucket, Key: s3.K(key) }), { expiresIn: privateAccess ? 900 : 7200, signingDate: new Date(Math.floor(Date.now() / win) * win) });
}
async function removeKey(key) {
  if (s3) await s3.client.send(new s3.S3.DeleteObjectCommand({ Bucket: s3.bucket, Key: s3.K(key) })).catch(() => {});
  else { try { await fsp.rm(localPath(key), { force: true }); } catch {} }
}
async function exists(key) {
  if (s3) { try { await s3.client.send(new s3.S3.HeadObjectCommand({ Bucket: s3.bucket, Key: s3.K(key) })); return true; } catch { return false; } }
  try { await fsp.access(localPath(key)); return true; } catch { return false; }
}

// ── Limpieza de cuarentena ──
async function sweep() {
  const now = Date.now(); for (const [id, e] of pending) if (e.exp < now) pending.delete(id);
  try {
    if (s3) {
      let token; do {
        const r = await s3.client.send(new s3.S3.ListObjectsV2Command({ Bucket: s3.bucket, Prefix: s3.K('quarantine/'), ContinuationToken: token }));
        for (const o of r.Contents || []) if (now - new Date(o.LastModified).getTime() > 3600e3) await s3.client.send(new s3.S3.DeleteObjectCommand({ Bucket: s3.bucket, Key: o.Key })).catch(() => {});
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
    } else if (fs.existsSync(QDIR)) for (const f of fs.readdirSync(QDIR)) { const p = path.join(QDIR, f); if (now - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { force: true }); }
  } catch (e) { console.warn('[MEDIA] Limpieza de cuarentena:', e.message); }
}
setInterval(sweep, 10 * 60e3).unref();

module.exports = { init, direct, presign, receiveLocal, receiveRelay, ensureCors, learnOrigin, status, commit, readUrl, removeKey, exists, localPath, mediaKey, MEDIA_KEY_RE, KINDS };
