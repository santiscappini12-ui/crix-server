'use strict';
// Detecta los recursos reales del contenedor (límite de memoria y de CPU del cgroup) para que el servidor se adapte.
// Planes pequeños (p. ej. suga.app Free: 0,1 vCPU y 256 MiB) no aguantan la configuración pensada para un servidor normal:
// física a 30 Hz, scripts con 512 MB de memoria, etc. terminaban en cuelgues, ping timeouts o en que el sistema mataba el proceso.
// Se puede forzar con CRIX_LOW_RESOURCE=1 (modo ligero) o =0 (desactivarlo).
const fs = require('fs'), os = require('os');
const read = f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };

function memLimitMB() {
  let bytes = Infinity;
  const v2 = read('/sys/fs/cgroup/memory.max'), v1 = read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  for (const v of [v2, v1]) { const n = Number(v); if (v && Number.isFinite(n) && n > 0) bytes = Math.min(bytes, n); }
  const total = os.totalmem(); if (total > 0) bytes = Math.min(bytes, total);
  return Math.round(bytes / 1048576);
}
function cpuLimit() {
  const cm = read('/sys/fs/cgroup/cpu.max');
  if (cm) { const [q, p] = cm.split(/\s+/); const quota = Number(q), period = Number(p); if (Number.isFinite(quota) && quota > 0 && period > 0) return quota / period; }
  const q1 = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')), p1 = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
  if (q1 > 0 && p1 > 0) return q1 / p1;
  return os.cpus().length || 1;
}
const memMB = memLimitMB(), cpus = cpuLimit();
const forced = process.env.CRIX_LOW_RESOURCE;
const low = forced === '1' ? true : forced === '0' ? false : (memMB <= 768 || cpus < 0.75);
module.exports = { memMB, cpus, low };
