'use strict';
// ══════════════════════════════════════════════════════════════════
// Crix · Guardia de medios
//
// Una sola pieza usada por TODAS las rutas de subida (videos, texturas, fotos, miniaturas,
// imágenes de posts, data-URIs dentro de cualquier JSON) y por el chequeo del chat E2EE:
//
//   1. Firma real del archivo (magic bytes): lo que dice el nombre/MIME no vale, manda el contenido.
//      Ejecutables, scripts, HTML y archivos comprimidos disfrazados de imagen/video se rechazan.
//   2. Hashes (MD5 / SHA-1 / SHA-256) contra listas de bloqueo de material ilegal conocido.
//      Las listas NO vienen incluidas: son de organizaciones (NCMEC, IWF, GIFCT, Project Arachnid,
//      Thorn, etc.) y se entregan solo a quien se registra con ellas. Se cargan desde:
//        · la carpeta  moderation/hashlists/*.txt   (o CRIX_HASHLIST_DIR)
//        · el bucket   moderation/hashlists/*       (sobrevive a los deploys; subí ahí tus listas)
//        · URLs        CRIX_HASHLIST_URLS="https://a/lista.txt,https://b/lista.txt"  (se refrescan cada 6 h)
//      Formato: un hash por línea, opcionalmente seguido de una etiqueta. Acepta `hash`, `hash etiqueta`,
//      `hash,etiqueta`. Las líneas que empiezan con # se ignoran.
//   3. Ganchos externos (hashes perceptuales / servicios): CRIX_SCAN_WEBHOOK o registerMatcher().
// ══════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ── 1. Firmas de formato ──
const ascii = (b, s, e) => b.toString('latin1', s, e);
function sniff(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  // Medios permitidos
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return { mime: 'image/png', ext: 'png', family: 'image' };
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { mime: 'image/jpeg', ext: 'jpg', family: 'image' };
  if (ascii(b, 0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif', family: 'image' };
  if (ascii(b, 0, 4) === 'RIFF' && b.length >= 12) {
    const t = ascii(b, 8, 12);
    if (t === 'WEBP') return { mime: 'image/webp', ext: 'webp', family: 'image' };
    if (t === 'WAVE') return { mime: 'audio/wav', ext: 'wav', family: 'audio' };
    if (t === 'AVI ') return { mime: 'video/x-msvideo', ext: 'avi', family: 'video-unsupported' };
  }
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return { mime: 'video/webm', ext: 'webm', family: 'video' };   // webm (también audio webm)
  if (ascii(b, 0, 4) === 'OggS') return { mime: 'video/ogg', ext: 'ogv', family: 'video' };
  if (b.length >= 12 && ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(ascii(b, 4, 8))) return { mime: 'video/mp4', ext: 'mp4', family: 'video' };
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)) return { mime: 'audio/mpeg', ext: 'mp3', family: 'audio' };
  // Cosas que NUNCA deben pasar como medio
  if (b[0] === 0x4D && b[1] === 0x5A) return { mime: 'application/x-msdownload', ext: 'exe', family: 'executable' };
  if (b[0] === 0x7F && ascii(b, 1, 4) === 'ELF') return { mime: 'application/x-elf', ext: 'elf', family: 'executable' };
  if ([0xFEEDFACE, 0xFEEDFACF, 0xCAFEBABE, 0xCEFAEDFE, 0xCFFAEDFE].includes(b.readUInt32BE(0))) return { mime: 'application/x-mach-binary', ext: 'macho', family: 'executable' };
  if (ascii(b, 0, 2) === '#!') return { mime: 'text/x-script', ext: 'sh', family: 'executable' };
  if (ascii(b, 0, 4) === 'PK\x03\x04' || ascii(b, 0, 4) === 'PK\x05\x06') return { mime: 'application/zip', ext: 'zip', family: 'archive' };
  if (ascii(b, 0, 4) === 'Rar!' || (b[0] === 0x37 && b[1] === 0x7A && b[2] === 0xBC && b[3] === 0xAF) || (b[0] === 0x1F && b[1] === 0x8B)) return { mime: 'application/x-archive', ext: 'bin', family: 'archive' };
  if (ascii(b, 0, 4) === '%PDF') return { mime: 'application/pdf', ext: 'pdf', family: 'document' };
  const head = ascii(b, 0, Math.min(b.length, 256)).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<script') || head.startsWith('<svg') || head.startsWith('<?xml')) return { mime: 'text/html', ext: 'html', family: 'markup' };
  return null;
}
// ¿El contenido real coincide con lo que se pretende subir?  kind: 'image' | 'video' | 'audio' | 'media' | 'any'
function verifyKind(buf, kind) {
  const info = sniff(buf);
  if (kind === 'any') return { ok: !info || !['executable'].includes(info.family) ? true : false, info };
  if (!info) return { ok: false, info, err: 'Formato de archivo no reconocido' };
  const allowed = kind === 'media' ? ['image', 'video', 'audio'] : kind === 'video' ? ['video'] : kind === 'audio' ? ['audio', 'video'] : [kind];
  if (!allowed.includes(info.family)) return { ok: false, info, err: `El contenido real del archivo (${info.mime}) no es ${kind === 'media' ? 'una imagen, video o audio' : kind}` };
  return { ok: true, info };
}

// ── 2. Hashes y listas de bloqueo ──
function newHasher() {
  const md5 = crypto.createHash('md5'), sha1 = crypto.createHash('sha1'), sha256 = crypto.createHash('sha256');
  let head = Buffer.alloc(0), size = 0;
  return {
    update(chunk) { md5.update(chunk); sha1.update(chunk); sha256.update(chunk); size += chunk.length; if (head.length < 65536) head = Buffer.concat([head, chunk.subarray(0, 65536 - head.length)]); },
    digest() { return { md5: md5.digest('hex'), sha1: sha1.digest('hex'), sha256: sha256.digest('hex'), head, size }; },
  };
}
function hashBuffer(buf) { const h = newHasher(); h.update(buf); return h.digest(); }

const ALG_BY_LEN = { 32: 'md5', 40: 'sha1', 64: 'sha256' };
const lists = new Map();        // nombreDeLista → Map(hash → etiqueta)
let flat = new Map();           // hash → { list, label }
function rebuild() { flat = new Map(); for (const [list, m] of lists) for (const [h, label] of m) if (!flat.has(h)) flat.set(h, { list, label }); }
function parseList(text) {
  const m = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line[0] === '#') continue;
    const [h, ...rest] = line.split(/[\s,;]+/); const hash = (h || '').toLowerCase();
    if (/^[0-9a-f]+$/.test(hash) && ALG_BY_LEN[hash.length]) m.set(hash, rest.join(' ').slice(0, 80));
  }
  return m;
}
function setList(name, text) { const m = parseList(text); lists.set(name, m); rebuild(); return m.size; }
function stats() { return { lists: [...lists].map(([n, m]) => ({ name: n, hashes: m.size })), total: flat.size }; }

const matchers = [];            // { name, check(info, buf) → null | { label } }
function registerMatcher(m) { matchers.push(m); }
if (process.env.CRIX_SCAN_WEBHOOK) {
  // Servicio externo (perceptual hashing, Safer, PhotoDNA propio, etc.). Por defecto manda solo los hashes.
  const url = process.env.CRIX_SCAN_WEBHOOK, sendFile = process.env.CRIX_SCAN_WEBHOOK_SEND_FILE === '1';
  registerMatcher({
    name: 'webhook',
    check: (info, buf) => new Promise(resolve => {
      const u = new URL(url), lib = u.protocol === 'https:' ? https : http;
      const body = sendFile && buf ? buf : Buffer.from(JSON.stringify({ md5: info.md5, sha1: info.sha1, sha256: info.sha256, size: info.size }));
      const req = lib.request(u, { method: 'POST', timeout: 15000, headers: { 'Content-Type': sendFile && buf ? 'application/octet-stream' : 'application/json', 'Content-Length': body.length, 'X-Crix-Sha256': info.sha256, ...(process.env.CRIX_SCAN_WEBHOOK_TOKEN ? { Authorization: 'Bearer ' + process.env.CRIX_SCAN_WEBHOOK_TOKEN } : {}) } }, res => {
        let d = ''; res.on('data', c => { if (d.length < 4096) d += c; }); res.on('end', () => { try { const j = JSON.parse(d); resolve(j && j.match ? { label: String(j.label || 'webhook').slice(0, 80) } : null); } catch { resolve(null); } });
      });
      // Si el servicio cae, NO se deja pasar en silencio: CRIX_SCAN_WEBHOOK_FAILCLOSED=1 bloquea; por defecto sigue.
      req.on('error', () => resolve(process.env.CRIX_SCAN_WEBHOOK_FAILCLOSED === '1' ? { label: 'scanner-no-disponible' } : null));
      req.on('timeout', () => { req.destroy(); });
      req.end(body);
    }),
  });
}
// info = resultado de newHasher().digest(); buf opcional (solo para ganchos que necesiten el archivo)
async function checkHashes(info, buf) {
  for (const alg of ['sha256', 'sha1', 'md5']) {
    const hit = flat.get(info[alg]);
    if (hit) return { alg, hash: info[alg], list: hit.list, label: hit.label || hit.list };
  }
  for (const m of matchers) {
    try { const r = await m.check(info, buf); if (r) return { alg: 'matcher', hash: info.sha256, list: m.name, label: r.label || m.name }; }
    catch (e) { console.warn(`[GUARD] El verificador ${m.name} falló:`, e.message); }
  }
  return null;
}
function checkSha256Only(hex) { const h = flat.get(String(hex || '').toLowerCase()); return h ? { alg: 'sha256', hash: hex, list: h.list, label: h.label || h.list } : null; }

// ── Carga de listas: carpeta local + bucket + URLs ──
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    lib.get(url, { timeout: 30000, headers: process.env.CRIX_HASHLIST_TOKEN ? { Authorization: 'Bearer ' + process.env.CRIX_HASHLIST_TOKEN } : {} }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return fetchUrl(new URL(res.headers.location, url).href).then(resolve, reject); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const parts = []; let n = 0; res.on('data', c => { n += c.length; if (n > 512 * 1024 * 1024) { res.destroy(new Error('Lista demasiado grande')); } else parts.push(c); });
      res.on('end', () => resolve(Buffer.concat(parts).toString('utf8'))); res.on('error', reject);
    }).on('error', reject);
  });
}
async function loadAll(persist) {
  const dir = path.resolve(process.env.CRIX_HASHLIST_DIR || path.join(__dirname, 'moderation', 'hashlists'));
  try { for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (/\.(txt|csv|hash|hashes)$/i.test(f)) setList('local:' + f, fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { console.warn('[GUARD] Carpeta de listas:', e.message); }
  try {
    for (const o of persist ? await persist.listKeys('moderation/hashlists/') : []) {
      if (!/\.(txt|csv|hash|hashes)$/i.test(o.key)) continue;
      const buf = await persist.getKey(o.key); if (buf) setList('bucket:' + o.key.split('/').pop(), buf.toString('utf8'));
    }
  } catch (e) { console.warn('[GUARD] Listas del bucket:', e.message); }
  for (const url of (process.env.CRIX_HASHLIST_URLS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    try { setList('url:' + new URL(url).host + new URL(url).pathname, await fetchUrl(url)); } catch (e) { console.warn(`[GUARD] No se pudo bajar ${url}: ${e.message}`); }
  }
  const s = stats(); console.log(`[GUARD] ${s.total} hashes bloqueados en ${s.lists.length} lista(s)` + (s.total ? '' : ' — SIN LISTAS: solo rige la verificación de firmas. Ver README (moderación).'));
}
function startAutoReload(persist) { loadAll(persist).catch(() => {}); setInterval(() => loadAll(persist).catch(() => {}), 6 * 3600 * 1000).unref(); }

// ── 3. data-URIs dentro de cualquier JSON ──
const DATA_URI = /^data:([^;,]*)(?:;[^,]*)?;base64,/i;
async function scanDataUris(value, depth = 0, out = []) {
  if (depth > 8 || out.length > 40) return out;
  if (typeof value === 'string') {
    if (value.length > 40 && value.startsWith('data:')) {
      const m = DATA_URI.exec(value);
      if (m) {
        const buf = Buffer.from(value.slice(m[0].length), 'base64'), info = hashBuffer(buf), real = sniff(buf);
        const bad = real && ['executable', 'archive', 'markup'].includes(real.family) ? { kind: 'signature', mime: real.mime } : null;
        const hit = await checkHashes(info, buf);
        if (hit || bad) out.push({ hit, bad, sha256: info.sha256, size: info.size });
      }
    }
  } else if (Array.isArray(value)) { for (const v of value) await scanDataUris(v, depth + 1, out); }
  else if (value && typeof value === 'object') { for (const k of Object.keys(value)) await scanDataUris(value[k], depth + 1, out); }
  return out;
}

module.exports = { sniff, verifyKind, newHasher, hashBuffer, setList, parseList, stats, registerMatcher, checkHashes, checkSha256Only, loadAll, startAutoReload, scanDataUris };
