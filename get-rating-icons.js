// Descarga los íconos de clasificación por edad desde Wikimedia Commons a icons/ratings/<SISTEMA>-<edad>.png
// Uso (una sola vez, en una máquina con internet):   node get-rating-icons.js
// Después abrí icons/ratings/_revisar.html en el navegador: muestra cada ícono con su archivo de Commons, autor y licencia.
// (_reporte.txt tiene lo mismo en texto.) Esto es una herramienta aparte: Crix no la usa.
// Si alguno quedó mal, ponelo a mano en icons/ratings/ con el mismo nombre (el script no pisa archivos existentes;
// con --force sí). Los íconos son marcas de cada organismo: revisá sus condiciones de uso.
const fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, 'icons', 'ratings');
const TIERS = [0, 7, 12, 16, 18];
const FORCE = process.argv.includes('--force');

// SISTEMA → una consulta de búsqueda por tramo [0, 7, 12, 16, 18] (null = repetir el ícono del tramo anterior)
// y un texto que el nombre del archivo debe contener, para descartar resultados que no tengan nada que ver.
const Q = {
  GENERIC:  { must: 'IARC', q: ['IARC Generic 3+ icon', 'IARC Generic 7+ icon', 'IARC Generic 12+ icon', 'IARC Generic 16+ icon', 'IARC Generic 18+ icon'] },
  ESRB:     { must: 'ESRB', q: ['ESRB Everyone', 'ESRB Everyone 10+', 'ESRB Teen', 'ESRB Mature 17+', 'ESRB Adults Only 18+'] },
  PEGI:     { must: 'PEGI', q: ['PEGI 3', 'PEGI 7', 'PEGI 12', 'PEGI 16', 'PEGI 18'] },
  USK:      { must: 'USK',  q: ['USK 0', 'USK 6', 'USK 12', 'USK 16', 'USK 18'] },
  CLASSIND: { must: 'Classifica', q: ['Classificação indicativa livre', 'Classificação indicativa 10 anos', 'Classificação indicativa 12 anos', 'Classificação indicativa 16 anos', 'Classificação indicativa 18 anos'] },
  CERO:     { must: 'CERO', q: ['CERO A', null, 'CERO B', 'CERO D', 'CERO Z'] },
  GRAC:     { must: 'GRAC', q: ['GRAC ALL', 'GRAC 12', null, 'GRAC 15', 'GRAC 18'] },
  ACB:      { must: 'Australian Classification', q: ['Australian Classification G', 'Australian Classification PG', 'Australian Classification M', 'Australian Classification MA15+', 'Australian Classification R18+'] },
  MX:       { must: '', q: ['Clasificación RTC México A', null, 'Clasificación RTC México B', 'Clasificación RTC México B15', 'Clasificación RTC México C'] },
  AR:       { must: '', q: ['INCAA calificación ATP', null, 'INCAA calificación +13', 'INCAA calificación +16', 'INCAA calificación +18'] },
  CL:       { must: '', q: ['Consejo de Calificación Cinematográfica Chile TE', 'Calificación cinematográfica Chile TE+7', 'Calificación cinematográfica Chile +14', 'Calificación cinematográfica Chile +18', null] },
  CO:       { must: '', q: ['Colombia clasificación cine Todos', 'Colombia clasificación cine 7+', 'Colombia clasificación cine 12+', 'Colombia clasificación cine 18+', null] },
};

const UA = { 'User-Agent': 'crix-rating-icons/1.0 (script de descarga unica)' };
async function search(q, must) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=8'
    + '&gsrsearch=' + encodeURIComponent(q) + '&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=160';
  const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error('HTTP ' + r.status);
  const pages = Object.values((await r.json()).query?.pages || {}).sort((a, b) => a.index - b.index);
  for (const p of pages) {
    const ii = p.imageinfo && p.imageinfo[0]; if (!ii) continue;
    if (must && !p.title.toLowerCase().includes(must.toLowerCase())) continue;
    if (!/image\/(svg|png|jpeg|webp)/.test(ii.mime)) continue;
    const md = ii.extmetadata || {}, strip = v => String((v && v.value) || '').replace(/<[^>]*>/g, '').trim();
    return { title: p.title, url: ii.thumburl || ii.url, page: 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(p.title.replace(/ /g, '_')),
             author: strip(md.Artist) || '?', license: strip(md.LicenseShortName) || '?' };
  }
  return null;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const rep = [], rows = [];
  for (const [sys, { must, q }] of Object.entries(Q)) {
    let prev = null;
    for (let i = 0; i < TIERS.length; i++) {
      const name = `${sys}-${TIERS[i]}.png`, file = path.join(OUT, name);
      if (!FORCE && fs.existsSync(file)) { rep.push(`${name}: ya existía, no se tocó`); prev = file; continue; }
      if (q[i] === null) { if (prev) { fs.copyFileSync(prev, file); rep.push(`${name}: copia del tramo anterior`); } continue; }
      try {
        const hit = await search(q[i], must);
        if (!hit) { rep.push(`${name}: NO ENCONTRADO (buscado: "${q[i]}") → ponelo a mano`); continue; }
        const img = await fetch(hit.url, { headers: UA }); if (!img.ok) throw new Error('HTTP ' + img.status);
        fs.writeFileSync(file, Buffer.from(await img.arrayBuffer())); prev = file;
        rep.push(`${name}: ${hit.title}`); rows.push({ name, q: q[i], ...hit });
      } catch (e) { rep.push(`${name}: ERROR ${e.message}`); }
      await new Promise(r => setTimeout(r, 400));
    }
  }
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cards = rows.map(r => `<div class=c><img src="${esc(r.name)}"><b>${esc(r.name)}</b><small>Buscado: ${esc(r.q)}</small>`
    + `<a href="${esc(r.page)}" target=_blank>${esc(r.title)}</a><small>Autor: ${esc(r.author)}<br>Licencia: ${esc(r.license)}</small></div>`).join('');
  fs.writeFileSync(path.join(OUT, '_revisar.html'), `<!doctype html><meta charset=utf-8><title>Revisar íconos</title><style>body{font:14px sans-serif;background:#222;color:#eee;display:flex;flex-wrap:wrap;gap:12px;padding:16px}.c{background:#333;padding:10px;width:190px;display:flex;flex-direction:column;gap:4px}img{height:64px;object-fit:contain;background:#fff;padding:4px}a{color:#8cf;word-break:break-all;font-size:12px}small{color:#aaa}</style>${cards}`);
  fs.writeFileSync(path.join(OUT, '_reporte.txt'), rep.join('\n') + '\n');
  console.log(rep.join('\n'));
})();
