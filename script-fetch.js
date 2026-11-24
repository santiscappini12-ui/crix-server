'use strict';
// ══════════════════════════════════════════════════════════════════
// fetch para Script de servidor (HTTP/HTTPS saliente).
//
// Los scripts los escribe cualquiera que publique un juego, así que esto es un cliente HTTP "enjaulado":
//   • Solo http/https, puertos 80, 443, 8080 y 8443, sin usuario:clave en la URL.
//   • Anti-SSRF: se resuelve el DNS y se RECHAZA cualquier dirección privada, de loopback, link-local (incluye el endpoint de
//     metadatos de la nube 169.254.169.254), CGNAT, multicast o reservada. La comprobación se hace en la propia conexión
//     (lookup propio), así que un dominio que cambie de IP entre la verificación y el uso (DNS rebinding) tampoco pasa.
//     Cada redirección (máx. 3) se vuelve a validar.
//   • Tiempo total 8 s, respuesta máx. 256 KB (se corta y se marca truncated), pedido máx. 64 KB, sin cookies del servidor.
//   • Variables de entorno: CRIX_FETCH=off lo apaga; CRIX_FETCH_ALLOW="api.ejemplo.com,otro.com" limita a esos dominios
//     (y sus subdominios); CRIX_FETCH_ALLOW_PRIVATE=1 deja ir a IPs privadas (solo para pruebas locales).
// ══════════════════════════════════════════════════════════════════
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const LIMITS = { timeoutMs: 8000, maxResponse: 256 * 1024, maxBody: 64 * 1024, maxRedirects: 3, maxHeaders: 20, maxInflight: 20 };
const PORTS = new Set(['', '80', '443', '8080', '8443']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const BLOCKED_REQ_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect', 'accept-encoding', 'proxy-authorization', 'proxy-connection']);
let inflight = 0;

class FetchError extends Error {}
const fail = msg => { throw new FetchError(msg); };

function ipv4ToInt(ip) { const p = ip.split('.').map(Number); return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0; }
function inV4(ip, base, bits) { const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask); }
const PRIVATE_V4 = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];

// true si la dirección NO es pública (hay que bloquearla).
function isPrivateIp(ip) {
  ip = String(ip || '').toLowerCase();
  if (net.isIPv4(ip)) return PRIVATE_V4.some(([base, bits]) => inV4(ip, base, bits));
  if (net.isIPv6(ip)) {
    const m = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);            // IPv4 mapeada/compatible: se evalúa como IPv4
    if (m) return isPrivateIp(m[1]);
    const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);         // ::ffff:7f00:1
    if (h) { const a = parseInt(h[1], 16), b = parseInt(h[2], 16); return isPrivateIp([a >> 8, a & 255, b >> 8, b & 255].join('.')); }
    if (ip === '::' || ip === '::1') return true;
    const first = parseInt(ip.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true;                           // fc00::/7 (ULA)
    if ((first & 0xffc0) === 0xfe80) return true;                           // fe80::/10 (link-local)
    if ((first & 0xff00) === 0xff00) return true;                           // ff00::/8 (multicast)
    if (first === 0x2001 && /^2001:(0)?:|^2001:db8:/.test(ip)) return true; // Teredo y documentación
    if (first === 0x2002) return true;                                      // 6to4: puede esconder una IPv4 privada
    if (ip.startsWith('64:ff9b:')) return true;                             // NAT64
    return false;
  }
  return true;   // no es una IP reconocible: se bloquea
}

function allowList() { return String(process.env.CRIX_FETCH_ALLOW || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }
function hostAllowed(host) { const list = allowList(); return !list.length || list.some(d => host === d || host.endsWith('.' + d)); }

function cleanHeaders(h) {
  const out = { 'user-agent': 'CrixScript/1.0 (+server)', accept: '*/*' };
  if (!h || typeof h !== 'object' || Array.isArray(h)) return out;
  for (const [k, v] of Object.entries(h).slice(0, LIMITS.maxHeaders)) {
    const name = String(k).toLowerCase();
    if (!/^[a-z0-9-]{1,40}$/.test(name) || BLOCKED_REQ_HEADERS.has(name) || name.startsWith('sec-')) continue;
    const value = String(v);
    if (value.length > 2000 || /[\r\n\0]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

function parseTarget(raw, allowPrivate) {
  let u; try { u = new URL(String(raw)); } catch (_) { fail('URL inválida'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail('Solo se permiten URL http:// y https://');
  if (u.username || u.password) fail('La URL no puede llevar usuario ni clave');
  if (!allowPrivate && !PORTS.has(u.port)) fail('Puerto no permitido (usá 80, 443, 8080 u 8443)');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) fail('URL sin dominio');
  if (!allowPrivate) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) fail('Dominio no permitido');
    if (net.isIP(host) && isPrivateIp(host)) fail('No se permiten direcciones privadas ni internas');
  }
  if (!hostAllowed(host)) fail('Dominio no permitido por el servidor (CRIX_FETCH_ALLOW)');
  return { u, host };
}

// lookup propio: valida cada dirección que devuelve el DNS justo antes de conectar.
function guardedLookup(allowPrivate) {
  return (hostname, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    dns.lookup(hostname, Object.assign({}, opts, { all: true }), (err, addrs) => {
      if (err) return cb(err);
      if (!Array.isArray(addrs) || !addrs.length) return cb(new Error('Sin direcciones'));
      if (!allowPrivate && addrs.some(a => isPrivateIp(a.address))) return cb(new Error('No se permiten direcciones privadas ni internas'));
      if (opts && opts.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

function once(u, method, headers, body, allowPrivate, deadline) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const left = deadline - Date.now(); if (left <= 0) return reject(new FetchError('Tiempo agotado'));
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + u.search, method, headers,
      lookup: guardedLookup(allowPrivate), agent: false, timeout: left,
    }, res => {
      const chunks = []; let size = 0, truncated = false;
      res.on('data', c => {
        if (truncated) return;
        size += c.length;
        if (size > LIMITS.maxResponse) { chunks.push(c.subarray(0, c.length - (size - LIMITS.maxResponse))); truncated = true; res.destroy(); return; }
        chunks.push(c);
      });
      const done = () => resolve({ status: res.statusCode || 0, statusText: res.statusMessage || '', headers: res.headers, body: Buffer.concat(chunks), truncated });
      res.on('end', done); res.on('close', done);
      res.on('error', e => { if (!truncated) reject(e); });
    });
    req.on('timeout', () => req.destroy(new FetchError('Tiempo agotado')));
    req.on('error', reject);
    if (body && method !== 'GET' && method !== 'HEAD') req.write(body);
    req.end();
  });
}

// req: { url, method?, headers?, body? }. Devuelve { ok, status, statusText, url, headers, body (texto), truncated } o tira FetchError.
async function doFetch(req, options = {}) {
  if (String(process.env.CRIX_FETCH || '').toLowerCase() === 'off') fail('fetch está desactivado en este servidor');
  if (inflight >= LIMITS.maxInflight) fail('El servidor tiene demasiadas peticiones HTTP en curso; probá de nuevo en un momento');
  const allowPrivate = options.allowPrivate === true || process.env.CRIX_FETCH_ALLOW_PRIVATE === '1';
  req = req && typeof req === 'object' ? req : {};
  const method = String(req.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) fail('Método no permitido: ' + method);
  const headers = cleanHeaders(req.headers);
  let body = null;
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') body = req.body;
    else { try { body = JSON.stringify(req.body); } catch (_) { fail('El body no se puede convertir a JSON'); } if (!headers['content-type']) headers['content-type'] = 'application/json'; }
    if (Buffer.byteLength(body) > LIMITS.maxBody) fail('El body supera ' + (LIMITS.maxBody / 1024) + ' KB');
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  let { u } = parseTarget(req.url, allowPrivate), m = method, b = body;
  const deadline = Date.now() + LIMITS.timeoutMs;
  inflight++;
  try {
    for (let hop = 0; ; hop++) {
      const r = await once(u, m, headers, b, allowPrivate, deadline);
      const loc = r.headers.location;
      if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
        if (hop >= LIMITS.maxRedirects) fail('Demasiadas redirecciones');
        u = parseTarget(new URL(String(loc), u).href, allowPrivate).u;
        if (r.status === 303 || ((r.status === 301 || r.status === 302) && m === 'POST')) { m = 'GET'; b = null; delete headers['content-length']; delete headers['content-type']; }
        if (u.host !== new URL(req.url).host) { delete headers.authorization; delete headers.cookie; }   // no se filtran credenciales a otro dominio
        continue;
      }
      const outHeaders = {};
      for (const [k, v] of Object.entries(r.headers).slice(0, 60)) outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
      delete outHeaders['set-cookie'];
      return { ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.statusText, url: u.href, headers: outHeaders, body: m === 'HEAD' ? '' : r.body.toString('utf8'), truncated: r.truncated };
    }
  } catch (e) {
    if (e instanceof FetchError) throw e;
    throw new FetchError('No se pudo conectar: ' + (e && e.code ? e.code + ' ' : '') + String(e && e.message || e).slice(0, 160));
  } finally { inflight--; }
}

module.exports = { doFetch, isPrivateIp, FetchError, LIMITS };
