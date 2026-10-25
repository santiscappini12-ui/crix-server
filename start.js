// Punto de entrada: restaura la base y las texturas desde el almacenamiento externo
// (si está configurado) y recién después inicia el servidor.
const persist = require('./persist');
persist.restore()
  .then(() => require('./server.js'))
  .catch(err => {
    console.error('[PERSIST] No se pudieron restaurar los datos:', err.message);
    console.error('[PERSIST] No arranco para no reemplazar la copia del bucket con una base vacía. Revisá las variables CRIX_S3_* y reiniciá.');
    process.exit(1);
  });
