// Clasificación de medios (juegos, apps y videos) según el país de quien los sube.
//
// Regla de Crix: solo lo ILEGAL está prohibido. Todo lo demás se puede subir, pero hay que decir qué contiene
// (cuestionario estilo IARC) para que el medio lleve una clasificación por edad en el sistema de tu país.
//   1) Bloque legal: si algo es ilegal (en todo el mundo o en tu país) el medio no se sube.
//   2) Bloque de contenido: violencia, sexo, lenguaje, drogas... → edad mínima + descriptores.
//   3) La edad se traduce a la etiqueta de tu país (PEGI, ESRB, USK, ClassInd, CERO, GRAC, ACB, etc.).
// Se clasifica el medio ENTERO (un video, un juego completo con sus texturas y todo), no cada textura.
//
// El servidor recalcula siempre la clasificación a partir de las respuestas: el cliente nunca decide la etiqueta.
const crypto = require('crypto');

const VERSION = 1;
const KINDS = ['video', 'game', 'app'];
const TIERS = [0, 7, 12, 16, 18];   // edades mínimas internas (equivalen a la escala genérica de IARC)

// ── Sistemas de clasificación: una etiqueta por tramo de edad [0, 7, 12, 16, 18] ──
// Son equivalencias orientativas calculadas a partir del cuestionario, no una clasificación oficial.
const SYSTEMS = {
  GENERIC:   { name: 'Genérica (IARC)',           labels: ['Todos', '7+', '12+', '16+', '18+'] },
  ESRB:      { name: 'ESRB',                      labels: ['E', 'E10+', 'T', 'M 17+', 'AO 18+'] },
  PEGI:      { name: 'PEGI',                      labels: ['PEGI 3', 'PEGI 7', 'PEGI 12', 'PEGI 16', 'PEGI 18'] },
  USK:       { name: 'USK',                       labels: ['USK 0', 'USK 6', 'USK 12', 'USK 16', 'USK 18'] },
  CLASSIND:  { name: 'ClassInd',                  labels: ['L', '10', '12', '16', '18'] },
  CERO:      { name: 'CERO',                      labels: ['A', 'A', 'B 12+', 'D 17+', 'Z 18+'] },
  GRAC:      { name: 'GRAC',                      labels: ['ALL', '12', '12', '15', '18'] },
  // Íconos de la clasificación de publicaciones de Australia: Unrestricted / M / Category 1 / Category 2 (esta última, solo sexo explícito).
  ACB:       { name: 'ACB',                      labels: ['Unrestricted', 'Unrestricted', 'M', 'M', 'Category 1'], explicit: { label: 'Category 2', icon: 'C' } },
  // RTC México: "D" es solo para contenido pornográfico (sexo explícito).
  MX:        { name: 'RTC (México)',              labels: ['A', 'A', 'B', 'B15', 'C'], explicit: { label: 'D', icon: 'D' } },
  // Régimen INCAA vigente desde 2026 (Res. Conjunta 1/2026): G, SP, R-13, R-17 y C. "C" es solo para contenido pornográfico (sexo explícito).
  AR:        { name: 'INCAA (Argentina)',         labels: ['G', 'SP', 'R-13', 'R-17', 'R-17'], explicit: { label: 'C', icon: 'C' } },
  CL:        { name: 'CCC (Chile)',               labels: ['TE', '+8', '+14', '+18', '+18'] },
  CO:        { name: 'MinCultura (Colombia)',     labels: ['Todos', '7+', '12+', '18+', '18+'] },
};

// código ISO → [nombre, sistema]
const COUNTRIES = {
  AR: ['Argentina', 'AR'], BO: ['Bolivia', 'GENERIC'], CL: ['Chile', 'CL'], CO: ['Colombia', 'CO'], CR: ['Costa Rica', 'GENERIC'],
  CU: ['Cuba', 'GENERIC'], DO: ['República Dominicana', 'GENERIC'], EC: ['Ecuador', 'GENERIC'], SV: ['El Salvador', 'GENERIC'],
  ES: ['España', 'PEGI'], GT: ['Guatemala', 'GENERIC'], HN: ['Honduras', 'GENERIC'], MX: ['México', 'MX'], NI: ['Nicaragua', 'GENERIC'],
  PA: ['Panamá', 'GENERIC'], PY: ['Paraguay', 'GENERIC'], PE: ['Perú', 'GENERIC'], PR: ['Puerto Rico', 'ESRB'], UY: ['Uruguay', 'GENERIC'],
  VE: ['Venezuela', 'GENERIC'], US: ['Estados Unidos', 'ESRB'], CA: ['Canadá', 'ESRB'], BR: ['Brasil', 'CLASSIND'], PT: ['Portugal', 'PEGI'],
  FR: ['Francia', 'PEGI'], DE: ['Alemania', 'USK'], IT: ['Italia', 'PEGI'], GB: ['Reino Unido', 'PEGI'], IE: ['Irlanda', 'PEGI'],
  NL: ['Países Bajos', 'PEGI'], BE: ['Bélgica', 'PEGI'], AT: ['Austria', 'PEGI'], CH: ['Suiza', 'PEGI'], SE: ['Suecia', 'PEGI'],
  NO: ['Noruega', 'PEGI'], DK: ['Dinamarca', 'PEGI'], FI: ['Finlandia', 'PEGI'], PL: ['Polonia', 'PEGI'], CZ: ['Chequia', 'PEGI'],
  GR: ['Grecia', 'PEGI'], RO: ['Rumania', 'PEGI'], HU: ['Hungría', 'PEGI'], AU: ['Australia', 'ACB'], NZ: ['Nueva Zelanda', 'ACB'],
  JP: ['Japón', 'CERO'], KR: ['Corea del Sur', 'GRAC'], IN: ['India', 'GENERIC'], ZA: ['Sudáfrica', 'GENERIC'], MA: ['Marruecos', 'GENERIC'],
  TR: ['Turquía', 'GENERIC'], RU: ['Rusia', 'GENERIC'], UA: ['Ucrania', 'GENERIC'], CN: ['China', 'GENERIC'], PH: ['Filipinas', 'GENERIC'],
  ID: ['Indonesia', 'GENERIC'], SG: ['Singapur', 'GENERIC'], AE: ['Emiratos Árabes Unidos', 'GENERIC'], SA: ['Arabia Saudita', 'GENERIC'],
  IL: ['Israel', 'GENERIC'], EG: ['Egipto', 'GENERIC'], NG: ['Nigeria', 'GENERIC'], ZZ: ['Otro país', 'GENERIC'],
};
const countryOf = code => COUNTRIES[String(code || '').toUpperCase()] ? String(code).toUpperCase() : null;

// ── Bloque legal ──
// Cada "sí" bloquea la subida. Las comunes valen en todo el mundo; las extras dependen del país.
const T = (es, en) => ({ es, en });
const LEGAL_COMMON = [
  { id: 'csam',      text: T('¿Contiene contenido sexual que involucre a menores de edad o los represente de forma sexualizada?', 'Does it contain sexual content involving minors, or sexualized depictions of minors?') },
  { id: 'ncii',      text: T('¿Muestra imágenes íntimas o sexuales de personas reales sin su consentimiento?', 'Does it show intimate or sexual images of real people without their consent?') },
  { id: 'terror',    text: T('¿Incita a la violencia o al terrorismo, o hace propaganda o da instrucciones para cometer atentados?', 'Does it incite violence or terrorism, or provide propaganda or instructions for attacks?') },
  { id: 'threats',   text: T('¿Contiene amenazas reales, acoso dirigido o datos privados de otras personas publicados sin permiso?', 'Does it contain real threats, targeted harassment, or other people’s private data shared without permission?') },
  { id: 'malware',   text: T('¿Es malware, phishing, una estafa o sirve para robar cuentas o datos?', 'Is it malware, phishing, a scam, or used to steal accounts or data?') },
];
// Obligatoria con respuesta "sí" (si dice "no", no se puede subir).
const LEGAL_RIGHTS = { id: 'rights', text: T('¿Tenés los derechos o el permiso para publicar todo lo que incluye (imágenes, música, videos, código, modelos)?', 'Do you own the rights or have permission to publish everything it includes (images, music, videos, code, models)?') };
const NAZI_SYMBOLS = { id: 'nazi_symbols', text: T('¿Muestra símbolos o propaganda de organizaciones nazis o inconstitucionales fuera de un contexto educativo, artístico o histórico?', 'Does it show symbols or propaganda of Nazi or unconstitutional organizations outside an educational, artistic, or historical context?') };
const HOLOCAUST = { id: 'holocaust_denial', text: T('¿Niega, minimiza o justifica el Holocausto o genocidios reconocidos?', 'Does it deny, trivialize, or justify the Holocaust or recognized genocides?') };
// Extras por país (solo donde la ley las prohíbe de forma específica). Fácil de ampliar.
const LEGAL_EXTRA = {
  DE: [NAZI_SYMBOLS, HOLOCAUST], AT: [NAZI_SYMBOLS, HOLOCAUST], FR: [HOLOCAUST], BE: [HOLOCAUST], CH: [HOLOCAUST], PL: [NAZI_SYMBOLS, HOLOCAUST],
  CZ: [NAZI_SYMBOLS, HOLOCAUST], HU: [HOLOCAUST], RO: [HOLOCAUST], IL: [HOLOCAUST], RU: [HOLOCAUST],
};

// ── Bloque de contenido ──
// Cada opción tiene la edad mínima que implica; `d` es un descriptor opcional que se muestra en la etiqueta.
const Q = (id, text, options, only) => ({ id, text, options, only });
const O = (es, en, age, d) => ({ text: T(es, en), age, d });
const CONTENT = [
  Q('violence', T('Violencia', 'Violence'), [
    O('No hay violencia', 'No violence', 0),
    O('Violencia de dibujos animados o fantasía, sin sangre', 'Cartoon or fantasy violence, no blood', 7, 'violence'),
    O('Violencia de fantasía con algo de sangre', 'Fantasy violence with some blood', 12, 'violence'),
    O('Violencia realista con sangre', 'Realistic violence with blood', 16, 'violence'),
    O('Violencia extrema: gore, mutilaciones o tortura', 'Extreme violence: gore, mutilation, or torture', 18, 'violence_extreme'),
  ]),
  Q('fear', T('Miedo y terror', 'Fear and horror'), [
    O('Nada de miedo', 'Nothing scary', 0),
    O('Escenas levemente inquietantes', 'Mildly unsettling scenes', 7, 'fear'),
    O('Sustos, criaturas o ambiente de terror moderado', 'Jump scares, creatures, or moderate horror', 12, 'fear'),
    O('Terror intenso o escenas perturbadoras', 'Intense horror or disturbing scenes', 16, 'fear'),
  ]),
  Q('sexual', T('Contenido sexual y desnudez', 'Sexual content and nudity'), [
    O('Ninguno', 'None', 0),
    O('Romance leve (besos, abrazos)', 'Mild romance (kissing, hugging)', 7),
    O('Insinuaciones, ropa provocativa o humor sexual', 'Innuendo, suggestive clothing, or sexual humor', 12, 'sexual'),
    O('Desnudez parcial o escenas sexuales sugeridas, no explícitas', 'Partial nudity or implied sexual scenes, not explicit', 16, 'sexual'),
    O('Desnudez completa o actos sexuales explícitos (solo para adultos)', 'Full nudity or explicit sexual acts (adults only)', 18, 'sexual_explicit'),
  ]),
  Q('language', T('Lenguaje', 'Language'), [
    O('Sin groserías', 'No profanity', 0),
    O('Insultos muy suaves', 'Very mild insults', 7, 'language'),
    O('Groserías moderadas', 'Moderate profanity', 12, 'language'),
    O('Groserías fuertes o frecuentes', 'Strong or frequent profanity', 16, 'language'),
  ]),
  Q('discrimination', T('Discriminación (que no llegue a incitar a la violencia: eso es ilegal)', 'Discrimination (short of inciting violence, which is illegal)'), [
    O('Ninguna', 'None', 0),
    O('Estereotipos o chistes leves', 'Mild stereotypes or jokes', 12, 'discrimination'),
    O('Lenguaje discriminatorio presente', 'Discriminatory language present', 16, 'discrimination'),
    O('Discriminación como tema central u ofensiva', 'Discrimination as a central or offensive theme', 18, 'discrimination'),
  ]),
  Q('drugs', T('Alcohol, tabaco y drogas', 'Alcohol, tobacco, and drugs'), [
    O('No aparecen', 'None', 0),
    O('Se mencionan de pasada', 'Mentioned in passing', 12, 'drugs'),
    O('Se muestra consumo de alcohol o tabaco', 'Alcohol or tobacco use is shown', 16, 'drugs'),
    O('Se muestra o glorifica el consumo de drogas ilegales', 'Illegal drug use is shown or glorified', 18, 'drugs'),
  ]),
  Q('gambling', T('Apuestas y juegos de azar', 'Gambling'), [
    O('No hay', 'None', 0),
    O('Azar simulado, sin dinero real y sin enseñar a apostar', 'Simulated chance games, no real money, no teaching', 12, 'gambling'),
    O('Apuestas simuladas que imitan las reales', 'Simulated gambling that imitates the real thing', 16, 'gambling'),
    O('Apuestas con dinero real', 'Real-money gambling', 18, 'gambling_real'),
  ]),
  Q('purchases', T('Compras con dinero real', 'Real-money purchases'), [
    O('No tiene compras', 'No purchases', 0),
    O('Tiene compras dentro del juego o app', 'In-game or in-app purchases', 0, 'purchases'),
    O('Tiene cajas sorpresa pagas (loot boxes)', 'Paid random rewards (loot boxes)', 12, 'loot'),
  ], ['game', 'app']),
  Q('interaction', T('Interacción entre usuarios', 'User interaction'), [
    O('Cada persona usa el medio por separado', 'Each person uses it on their own', 0),
    O('Hay chat, multijugador o contenido creado por usuarios', 'Chat, multiplayer, or user-generated content', 0, 'online'),
  ], ['game', 'app']),
  // El contenido que suben los usuarios dentro del medio NO cuenta para la edad: se clasifica solo lo que subís vos.
  // Se muestra un aviso en la etiqueta (como el "Users Interact" de ESRB), pero no sube la edad.
  Q('ugc', T('Contenido de otros usuarios', 'Other users’ content'), [
    O('Los usuarios no pueden subir ni crear contenido dentro', 'Users cannot upload or create content inside it', 0),
    O('Los usuarios pueden subir o crear contenido propio (puede ser de cualquier intensidad; no se cuenta en esta clasificación)', 'Users can upload or create their own content (any intensity; not counted in this rating)', 0, 'ugc'),
  ], ['game', 'app']),
  Q('kids', T('¿Está pensado principalmente para menores de 13 años?', 'Is it mainly intended for children under 13?'), [
    O('No', 'No', 0),
    O('Sí, es para niños', 'Yes, it is for children', 0, 'kids'),
  ]),
];

const DESCRIPTORS = {
  violence:         T('Violencia', 'Violence'),
  violence_extreme: T('Violencia extrema', 'Extreme violence'),
  fear:             T('Miedo', 'Fear'),
  sexual:           T('Contenido sexual', 'Sexual content'),
  sexual_explicit:  T('Contenido sexual explícito', 'Explicit sexual content'),
  language:         T('Lenguaje soez', 'Strong language'),
  discrimination:   T('Discriminación', 'Discrimination'),
  drugs:            T('Drogas, alcohol o tabaco', 'Drugs, alcohol, or tobacco'),
  gambling:         T('Juegos de azar', 'Gambling'),
  gambling_real:    T('Apuestas con dinero real', 'Real-money gambling'),
  purchases:        T('Compras con dinero real', 'In-app purchases'),
  loot:             T('Cajas sorpresa pagas', 'Paid random rewards'),
  online:           T('Interacción entre usuarios', 'Users interact'),
  ugc:              T('Incluye contenido de usuarios (no clasificado)', 'Includes user-generated content (not rated)'),
  kids:             T('Para niños', 'For children'),
};

const pick = (obj, lang) => (lang === 'es' ? obj.es : obj.en);
const langOf = l => (String(l || '').toLowerCase().startsWith('es') ? 'es' : 'en');

function legalFor(country) { return [...LEGAL_COMMON, ...(LEGAL_EXTRA[country] || [])]; }
function questionsFor(kind) { return CONTENT.filter(q => !q.only || q.only.includes(kind)); }

// Configuración que consume el cliente para dibujar el cuestionario.
function publicConfig(kind, lang) {
  const l = langOf(lang);
  const k = KINDS.includes(kind) ? kind : 'game';
  return {
    version: VERSION,
    countries: Object.entries(COUNTRIES).map(([code, [name, system]]) => ({ code, name, system, systemName: SYSTEMS[system].name }))
      .sort((a, b) => (a.code === 'ZZ') - (b.code === 'ZZ') || a.name.localeCompare(b.name, 'es')),
    legalCommon: LEGAL_COMMON.map(x => ({ id: x.id, text: pick(x.text, l) })),
    legalExtra: Object.fromEntries(Object.entries(LEGAL_EXTRA).map(([c, list]) => [c, list.map(x => ({ id: x.id, text: pick(x.text, l) }))])),
    rights: { id: LEGAL_RIGHTS.id, text: pick(LEGAL_RIGHTS.text, l) },
    questions: questionsFor(k).map(q => ({ id: q.id, text: pick(q.text, l), options: q.options.map(o => pick(o.text, l)) })),
  };
}

// ── Evaluación ──
// input: { kind, country, answers:{ [questionId]: índice de opción }, legal:{ [legalId]: true|false }, declared:true }
// Devuelve { ok:true, result } o { ok:false, code, err, reasons? }.
function evaluate(input, lang) {
  const l = langOf(lang);
  const msg = (es, en) => (l === 'es' ? es : en);
  const fail = (code, es, en, reasons) => ({ ok: false, code, err: msg(es, en), reasons });
  if (!input || typeof input !== 'object') return fail('CLASSIFICATION_REQUIRED', 'Falta completar el cuestionario de clasificación.', 'The classification questionnaire is required.');
  const kind = KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) return fail('CLASSIFICATION_INVALID', 'Tipo de medio inválido.', 'Invalid media type.');
  const country = countryOf(input.country);
  if (!country) return fail('CLASSIFICATION_INVALID', 'Elegí tu país.', 'Choose your country.');

  // 1) Legalidad
  const legal = input.legal && typeof input.legal === 'object' ? input.legal : {};
  const blocked = [];
  for (const item of legalFor(country)) {
    if (typeof legal[item.id] !== 'boolean') return fail('CLASSIFICATION_INVALID', 'Respondé todas las preguntas de legalidad.', 'Answer all the legality questions.');
    if (legal[item.id]) blocked.push(item.id);
  }
  if (typeof legal[LEGAL_RIGHTS.id] !== 'boolean') return fail('CLASSIFICATION_INVALID', 'Respondé todas las preguntas de legalidad.', 'Answer all the legality questions.');
  if (!legal[LEGAL_RIGHTS.id]) blocked.push(LEGAL_RIGHTS.id);
  if (blocked.length) {
    return fail('ILLEGAL_CONTENT',
      'Este contenido no se puede subir a Crix porque es ilegal o no tenés derechos para publicarlo.',
      'This content cannot be uploaded to Crix because it is illegal or you do not have the rights to publish it.', blocked);
  }
  if (input.declared !== true) return fail('CLASSIFICATION_INVALID', 'Tenés que aceptar la declaración final.', 'You must accept the final declaration.');

  // 2) Contenido
  const answers = input.answers && typeof input.answers === 'object' ? input.answers : {};
  let age = 0; const descriptors = new Set(); const clean = {};
  for (const q of questionsFor(kind)) {
    const idx = answers[q.id];
    if (!Number.isInteger(idx) || idx < 0 || idx >= q.options.length) return fail('CLASSIFICATION_INVALID', 'Respondé todas las preguntas de contenido.', 'Answer all the content questions.');
    clean[q.id] = idx;
    const opt = q.options[idx];
    age = Math.max(age, opt.age);
    if (opt.d) descriptors.add(opt.d);
  }
  // Un medio para niños no puede tener contenido de 13+.
  if (descriptors.has('kids') && age > 12) {
    return fail('KIDS_CONFLICT', 'Dijiste que es para menores de 13 años pero el contenido que declaraste es para mayores.', 'You said it is for children under 13, but the content you declared is for older audiences.');
  }
  const tier = TIERS.find(t => t >= age) ?? 18;
  const tierIdx = TIERS.indexOf(tier);
  const [countryName, systemId] = COUNTRIES[country];
  const system = SYSTEMS[systemId];
  const explicitSex = descriptors.has('sexual_explicit');   // algunos sistemas (INCAA: "C") tienen una etiqueta aparte para sexo explícito
  return {
    ok: true,
    result: {
      v: VERSION, kind, country, countryName, system: systemId, systemName: system.name,
      label: explicitSex && system.explicit ? system.explicit.label : system.labels[tierIdx], age: tier, adult: tier >= 18,
      icon: systemId + '-' + (explicitSex && system.explicit ? system.explicit.icon : tier),
      descriptors: [...descriptors],
      descriptorLabels: [...descriptors].map(d => pick(DESCRIPTORS[d], l)),
      answers: clean,
      legal: Object.fromEntries([...legalFor(country).map(x => x.id), LEGAL_RIGHTS.id].map(id => [id, !!legal[id]])),
      declared: true,
      at: new Date().toISOString(),
    },
  };
}

// ¿Tiene el registro una clasificación válida y vigente? (se vuelve a calcular desde las respuestas guardadas)
function isValid(record) {
  const c = record && record.classification;
  if (!c || typeof c !== 'object') return false;
  return evaluate({ kind: c.kind, country: c.country, answers: c.answers, legal: c.legal, declared: c.declared }, 'es').ok;
}

// ── Detección de país (APIs) ──
// 1) Cabeceras que ponen los CDN/hosting (Cloudflare, Vercel, App Engine, CloudFront). 2) APIs públicas de geolocalización por IP.
const GEO_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'x-appengine-country', 'cloudfront-viewer-country', 'x-country-code', 'x-geo-country'];
const geoCache = new Map();   // ip → { country, at }
const GEO_TTL = 24 * 3600 * 1000;
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.headers['x-real-ip'] || req.ip || req.socket?.remoteAddress || '';
  return String(ip).replace(/^::ffff:/, '');
}
const isPrivateIp = ip => !ip || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(ip);
const GEO_APIS = [
  { url: ip => `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code`, read: j => j && j.success !== false && j.country_code },
  { url: ip => `https://ipapi.co/${encodeURIComponent(ip)}/json/`, read: j => j && !j.error && j.country_code },
  { url: ip => `https://api.country.is/${encodeURIComponent(ip)}`, read: j => j && j.country },
];
async function detectCountry(req, fetchJson) {
  for (const h of GEO_HEADERS) {
    const v = countryOf(req.headers[h]);
    if (v && v !== 'XX') return { country: v, source: h };
  }
  const ip = clientIp(req);
  if (isPrivateIp(ip)) return { country: null, source: 'none' };
  const hit = geoCache.get(ip);
  if (hit && Date.now() - hit.at < GEO_TTL) return { country: hit.country, source: 'cache' };
  for (const api of GEO_APIS) {
    try {
      const code = countryOf(api.read(await fetchJson(api.url(ip), {}, 2500)));
      if (code) {
        if (geoCache.size > 5000) geoCache.clear();
        geoCache.set(ip, { country: code, at: Date.now() });
        return { country: code, source: 'api' };
      }
    } catch { /* se prueba la siguiente API */ }
  }
  return { country: null, source: 'none' };
}

module.exports = { evaluate, isValid, publicConfig, detectCountry, countryOf, COUNTRIES, SYSTEMS, KINDS, VERSION, langOf };
