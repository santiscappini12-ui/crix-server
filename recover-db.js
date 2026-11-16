'use strict';
// Recupera la base de Crix desde un respaldo del bucket (db/backup-*.json.gz). Supabase Storage no tiene versionado de objetos,
// así que los respaldos diarios son la fuente; si el proveedor sí versiona (B2, S3), también lista las versiones.
//
//   node recover-db.js list                     → versiones de la base y respaldos, con tamaño y fecha
//   node recover-db.js inspect <key> [versionId> → baja esa copia y muestra cuántos usuarios/juegos/videos/posts tiene
//   node recover-db.js restore <key> [versionId] → FUSIONA esa copia dentro de la base actual (no borra nada de lo actual)
//
// Usa las mismas variables que el servidor: CRIX_S3_BUCKET, CRIX_S3_ACCESS_KEY_ID, CRIX_S3_SECRET_ACCESS_KEY,
// CRIX_S3_ENDPOINT, CRIX_S3_REGION y (si lo usás) CRIX_S3_PREFIX.
// Antes de escribir guarda la base actual como db/pre-recover-<fecha>.json.gz.
const zlib = require('zlib');
const S3 = require('@aws-sdk/client-s3');
const env = process.env;
const bucket = env.CRIX_S3_BUCKET;
const prefix = (env.CRIX_S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
const K = k => prefix ? `${prefix}/${k}` : k;
const unK = k => prefix ? k.slice(prefix.length + 1) : k;
const DB_KEY = 'db/crix_data.json.gz';
if (!bucket || !env.CRIX_S3_ACCESS_KEY_ID || !env.CRIX_S3_SECRET_ACCESS_KEY) { console.error('Faltan variables CRIX_S3_BUCKET / CRIX_S3_ACCESS_KEY_ID / CRIX_S3_SECRET_ACCESS_KEY'); process.exit(1); }
const client = new S3.S3Client({
  region: env.CRIX_S3_REGION || 'us-east-1', endpoint: env.CRIX_S3_ENDPOINT || undefined, forcePathStyle: true,
  credentials: { accessKeyId: env.CRIX_S3_ACCESS_KEY_ID, secretAccessKey: env.CRIX_S3_SECRET_ACCESS_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
});
const fmt = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
async function get(key, versionId) {
  const r = await client.send(new S3.GetObjectCommand({ Bucket: bucket, Key: K(key), VersionId: versionId || undefined }));
  return Buffer.from(await r.Body.transformToByteArray());
}
const parse = gz => JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
const counts = db => ({ users: Object.keys(db.users || {}).length, maps: Object.keys(db.maps || {}).length, videos: (db.videos || []).length, posts: (db.posts || []).length, v: db._v });

async function list() {
  let any = false;
  try {
    let km, vm;
    do {
      const r = await client.send(new S3.ListObjectVersionsCommand({ Bucket: bucket, Prefix: K('db/'), KeyMarker: km, VersionIdMarker: vm }));
      for (const v of r.Versions || []) { any = true; console.log(`${unK(v.Key)}  versionId=${v.VersionId}  ${fmt(v.Size)}  ${v.LastModified.toISOString()}${v.IsLatest ? '  (actual)' : ''}`); }
      km = r.IsTruncated ? r.NextKeyMarker : undefined; vm = r.IsTruncated ? r.NextVersionIdMarker : undefined;
    } while (km);
  } catch (e) { console.warn('Este bucket no ofrece versiones de objetos (normal en Supabase); listo los objetos actuales y los respaldos diarios'); }
  if (!any) {
    const r = await client.send(new S3.ListObjectsV2Command({ Bucket: bucket, Prefix: K('db/') }));
    for (const o of r.Contents || []) console.log(`${unK(o.Key)}  ${fmt(o.Size)}  ${o.LastModified.toISOString()}`);
  }
}
async function inspect(key, versionId) { const db = parse(await get(key, versionId)); console.log(key, versionId || '', JSON.stringify(counts(db))); }

async function restore(key, versionId) {
  const old = parse(await get(key, versionId));
  const cur = parse(await get(DB_KEY));
  console.log('Copia vieja :', JSON.stringify(counts(old)));
  console.log('Base actual :', JSON.stringify(counts(cur)));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await client.send(new S3.PutObjectCommand({ Bucket: bucket, Key: K(`db/pre-recover-${stamp}.json.gz`), Body: zlib.gzipSync(Buffer.from(JSON.stringify(cur))), ContentType: 'application/gzip' }));
  console.log(`Base actual respaldada en db/pre-recover-${stamp}.json.gz`);
  const now = Date.now(), added = { users: 0, maps: 0, videos: 0, posts: 0 };
  cur.tomb = cur.tomb && typeof cur.tomb === 'object' ? cur.tomb : {};
  const untomb = (col, id) => { if (cur.tomb[col]) delete cur.tomb[col][id]; };
  for (const col of ['users', 'maps']) {
    cur[col] = cur[col] || {};
    for (const [id, rec] of Object.entries(old[col] || {})) {
      if (cur[col][id]) continue;
      cur[col][id] = { ...rec, _u: now }; untomb(col, id); added[col]++;   // `_u` nuevo: gana a cualquier lápida vieja
    }
  }
  for (const col of ['videos', 'posts']) {
    cur[col] = Array.isArray(cur[col]) ? cur[col] : [];
    const have = new Set(cur[col].map(r => String(r.id)));
    for (const rec of old[col] || []) { if (rec && rec.id != null && !have.has(String(rec.id))) { cur[col].push({ ...rec, _u: now }); untomb(col, String(rec.id)); added[col]++; } }
  }
  cur._v = Math.max(Number(cur._v) || 0, Number(old._v) || 0) + 1000;   // para que gane al archivo local del servidor al reiniciar
  await client.send(new S3.PutObjectCommand({ Bucket: bucket, Key: K(DB_KEY), Body: zlib.gzipSync(Buffer.from(JSON.stringify(cur))), ContentType: 'application/gzip' }));
  console.log('Recuperado y subido. Agregados:', JSON.stringify(added), '→ ahora:', JSON.stringify(counts(cur)));
  console.log('Ahora reiniciá el servicio en Suga para que cargue la base nueva.');
}
const [cmd, a, b] = process.argv.slice(2);
(async () => {
  if (cmd === 'list') await list();
  else if (cmd === 'inspect' && a) await inspect(a, b);
  else if (cmd === 'restore' && a) await restore(a, b);
  else console.log('Uso: node recover-db.js list | inspect <key> [versionId] | restore <key> [versionId]');
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
