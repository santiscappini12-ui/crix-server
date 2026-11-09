// Punto de entrada: restaura la base y las texturas desde el almacenamiento externo
// (si está configurado) y recién después inicia el servidor.
//
// IMPORTANTE: el puerto se abre ANTES de restaurar. Si la restauración falla, el
// proceso NO se cierra (eso producía "upstream connect error ... Connection refused"
// en el proxy): sigue reintentando y mientras tanto muestra el motivo en pantalla.
// Nunca arranca con una base vacía, para no pisar la copia del bucket.
const http = require('http');
const persist = require('./persist');

const PORT = process.env.PORT || 3000;
let lastError = null;
let attempt = 0;

const placeholder = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '10' });
  res.end(
    'Crix está iniciando…\n\n' +
    `Intento de restauración #${attempt}\n` +
    (lastError
      ? `Último error: ${lastError}\n\nRevisá las variables CRIX_S3_* (bucket, claves, endpoint, región).`
      : 'Restaurando datos desde el almacenamiento externo.')
  );
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot() {
  await new Promise((resolve, reject) => {
    placeholder.once('error', reject);
    placeholder.listen(PORT, resolve);
  });
  console.log(`[BOOT] Puerto ${PORT} abierto, restaurando datos…`);

  for (;;) {
    attempt++;
    try {
      await persist.restore();
      lastError = null;
      break;
    } catch (err) {
      lastError = err.message;
      console.error(`[PERSIST] No se pudieron restaurar los datos (intento ${attempt}):`, err.message);
      console.error('[PERSIST] No arranco con base vacía para no reemplazar la copia del bucket. Reintento en 15 s. Revisá las variables CRIX_S3_*.');
      await sleep(15000);
    }
  }

  // Liberar el puerto y dejar que server.js lo tome.
  placeholder.closeAllConnections?.();
  await new Promise(r => placeholder.close(r));
  require('./server.js');
}

boot().catch(err => {
  console.error('[BOOT] Error fatal:', err);
  process.exit(1);
});
