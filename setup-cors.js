'use strict';
// Configura el CORS del bucket para que los navegadores puedan subir/leer medios directo.
//   CRIX_ORIGIN=https://tu-app.onrender.com  node setup-cors.js
// Necesita las mismas variables CRIX_S3_* y que la clave tenga permiso "writeBucketSettings".
// Si la clave de Render es de solo-lectura/escritura de archivos, usá la clave maestra una sola vez
// (o pegá este mismo JSON en el panel de Backblaze → Bucket → CORS Rules).
const S3 = require('@aws-sdk/client-s3');
const env = process.env, origins = (env.CRIX_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
if (!env.CRIX_S3_BUCKET || !origins.length) { console.error('Faltan CRIX_S3_BUCKET y CRIX_ORIGIN (p. ej. https://tu-app.onrender.com)'); process.exit(1); }
const client = new S3.S3Client({
  region: env.CRIX_S3_REGION || 'auto', endpoint: env.CRIX_S3_ENDPOINT, forcePathStyle: true,
  credentials: { accessKeyId: env.CRIX_S3_ACCESS_KEY_ID, secretAccessKey: env.CRIX_S3_SECRET_ACCESS_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
});
const rules = [{ ID: 'crix', AllowedOrigins: origins, AllowedMethods: ['GET', 'HEAD', 'PUT'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range', 'Accept-Ranges'], MaxAgeSeconds: 3600 }];
client.send(new S3.PutBucketCorsCommand({ Bucket: env.CRIX_S3_BUCKET, CORSConfiguration: { CORSRules: rules } }))
  .then(() => console.log('CORS configurado para', origins.join(', ')))
  .catch(e => { console.error('No se pudo configurar el CORS:', e.name, e.message, '\nPegá este JSON a mano en el panel del bucket:\n' + JSON.stringify(rules, null, 2)); process.exit(1); });
