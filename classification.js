// Clasificación de medios (juegos, apps y videos) según el país de quien los sube.
//
// Regla de Crix: solo lo ILEGAL está prohibido. Todo lo demás se puede subir, pero hay que decir qué contiene
// (cuestionario propio de Crix, inspirado en los cuestionarios de edad habituales) para que el medio lleve una clasificación por edad en el sistema de tu país.
//   1) Bloque legal: si algo es ilegal (en todo el mundo o en tu país) el medio no se sube.
//   2) Bloque de contenido: violencia, sexo, lenguaje, drogas... → edad mínima + descriptores.
//   3) La edad se traduce a la insignia Crix de tu país (Crix AR, Crix EUU, Crix EU, Crix BR, Crix JP...).
// Se clasifica el medio ENTERO (un video, un juego completo con sus texturas y todo), no cada textura.
//
// El servidor recalcula siempre la clasificación a partir de las respuestas: el cliente nunca decide la etiqueta.
const crypto = require('crypto');
const I18N = require('./classification-i18n');   // traducciones a pt, fr, de, it

const VERSION = 1;
const KINDS = ['video', 'game', 'app'];
const TIERS = [0, 7, 12, 16, 18];   // edades mínimas internas (escala genérica de Crix)
// Humor tabú (sexo, muerte, religión, drogas...) y partes del cuerpo con fin educativo: NUNCA fuerzan 18+ por sí solos.
// Solo mostrar genitales descubiertos sin fin educativo, o sexo explícito, es 18+. La desnudez parcial y los movimientos sexuales simulados quedan en 16+. Una parte íntima SUELTA (no unida a ningún cuerpo
// ni personaje, p. ej. un objeto flotante) NO cuenta como desnudez: se declara como humor tabú. Lo mismo vale para un personaje u objeto que solo
// TIENE esa forma en caricatura (p. ej. la cabeza de un personaje con esa forma): sigue siendo humor tabú, no 18+ explícito. Sus miniaturas no se difuminan.
const AGE_TABOO_MILD = 12, AGE_TABOO_STRONG = 16, AGE_BODY_EDU = 12;

// ── Sistemas de clasificación: una etiqueta por tramo de edad [0, 7, 12, 16, 18] ──
// Son sistemas PROPIOS de Crix ("Crix AR", "Crix EUU"...), pensados a partir de las edades que suele usar cada región.
// No son clasificaciones oficiales ni usan logos, nombres ni sellos de ningún organismo. Si más adelante un organismo
// autoriza el uso de su sello, se agrega aparte (ver README). El dibujo de cada insignia está en index.html (CLS_SYS);
// si cambiás nombres o etiquetas acá, actualizá también esa tabla.
const SYSTEMS = {
  GENERIC:   { name: 'Crix Global',   labels: ['Todos', '7+', '12+', '16+', '18+'] },
  ESRB:      { name: 'Crix EUU',      labels: ['Todos', '10+', '13+', '17+', '18+'] },   // EE. UU., Canadá y Puerto Rico
  PEGI:      { name: 'Crix EU',       labels: ['3+', '7+', '12+', '16+', '18+'] },       // Europa
  USK:       { name: 'Crix DE',       labels: ['0+', '6+', '12+', '16+', '18+'] },
  CLASSIND:  { name: 'Crix BR',       labels: ['Livre', '10+', '12+', '16+', '18+'] },
  CERO:      { name: 'Crix JP',       labels: ['Todos', 'Todos', '12+', '17+', '18+'] },
  GRAC:      { name: 'Crix KR',       labels: ['Todos', '12+', '12+', '15+', '18+'] },
  ACB:       { name: 'Crix AU',       labels: ['Todos', 'Todos', '15+', '15+', '18+'],  explicit: { label: '18+ Explícito', icon: 'X' } },
  // En México, Argentina y Australia el sexo explícito tiene una categoría aparte.
  MX:        { name: 'Crix MX',       labels: ['Todos', 'Todos', '12+', '15+', '18+'],  explicit: { label: '18+ Explícito', icon: 'X' } },
  AR:        { name: 'Crix AR',       labels: ['Todos', 'Todos', '13+', '17+', '17+'],  explicit: { label: '18+ Explícito', icon: 'X' } },
  CL:        { name: 'Crix CL',       labels: ['Todos', '8+', '14+', '18+', '18+'] },
  CO:        { name: 'Crix CO',       labels: ['Todos', '7+', '12+', '18+', '18+'] },
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
  { id: 'csam',      text: T('¿Contiene contenido sexual que involucre a menores de edad o los represente de forma sexualizada? (Cuenta también si es dibujo, ficción, humor o hecho con IA.)', 'Does it contain sexual content involving minors, or sexualized depictions of minors? (This includes drawings, fiction, humor, or AI-generated content.)') },
  { id: 'ncii',      text: T('¿Muestra imágenes íntimas o sexuales de personas reales sin su consentimiento? (Cuenta también si es parodia, humor o un montaje hecho con IA.)', 'Does it show intimate or sexual images of real people without their consent? (This includes parody, humor, or AI-generated fakes.)') },
  { id: 'terror',    text: T('¿Incita a la violencia o al terrorismo, o hace propaganda o da instrucciones para cometer atentados? (La violencia de ficción, los juegos y el humor negro que claramente no incitan a nada real no cuentan.)', 'Does it incite violence or terrorism, or provide propaganda or instructions for attacks? (Fictional violence, games, and dark humor that clearly do not incite anything real do not count.)') },
  { id: 'threats',   text: T('¿Contiene amenazas reales, acoso dirigido o datos privados de otras personas publicados sin permiso? (La parodia o sátira de figuras públicas sin amenazas ni acoso no cuenta; una "broma" que acosa o expone a una persona sí.)', 'Does it contain real threats, targeted harassment, or other people’s private data shared without permission? (Parody or satire of public figures without threats or harassment does not count; a "joke" that harasses or exposes a person does.)') },
  { id: 'malware',   text: T('¿Es malware, phishing, una estafa o sirve para robar cuentas o datos? (Una broma inofensiva que no roba, daña ni bloquea nada no cuenta.)', 'Is it malware, phishing, a scam, or used to steal accounts or data? (A harmless prank that steals, damages, or locks nothing does not count.)') },
];
// Obligatoria con respuesta "sí" (si dice "no", no se puede subir).
const LEGAL_RIGHTS = { id: 'rights', text: T('¿Tenés los derechos o el permiso para publicar todo lo que incluye (imágenes, música, videos, código, modelos)?', 'Do you own the rights or have permission to publish everything it includes (images, music, videos, code, models)?') };
// Solo se pregunta en países donde la ley prohíbe estos símbolos (en la mayoría del mundo no es delito mostrarlos, ni siquiera por humor).
// Educativo, histórico, informativo, arte o sátira que claramente RECHAZA esas ideas → "no". Humor que los muestra sin ese rechazo → "sí".
const NAZI_SYMBOLS = { id: 'nazi_symbols', text: T('¿Muestra símbolos o propaganda de organizaciones nazis o inconstitucionales? Respondé "no" si es educativo, histórico, informativo, o arte o sátira que claramente rechaza esas ideas. Si es humor (incluido el absurdo) que los muestra sin rechazarlos, respondé "sí": en este país la ley puede prohibirlo aunque sea un chiste.', 'Does it show symbols or propaganda of Nazi or unconstitutional organizations? Answer "no" if it is educational, historical, informational, or art or satire that clearly rejects those ideas. If it is humor (including absurd humor) that shows them without rejecting them, answer "yes": in this country the law may prohibit it even as a joke.') };
const HOLOCAUST = { id: 'holocaust_denial', text: T('¿Niega, minimiza o justifica el Holocausto o genocidios reconocidos, también en tono de broma? (Una sátira que critica a quienes lo niegan no cuenta.)', 'Does it deny, trivialize, or justify the Holocaust or recognized genocides, including as a joke? (Satire that criticizes those who deny it does not count.)') };
// Extras por país (solo donde la ley las prohíbe de forma específica). Fácil de ampliar.
const LEGAL_EXTRA = {
  DE: [NAZI_SYMBOLS, HOLOCAUST], AT: [NAZI_SYMBOLS, HOLOCAUST], FR: [HOLOCAUST], BE: [HOLOCAUST], CH: [HOLOCAUST], PL: [NAZI_SYMBOLS, HOLOCAUST],
  CZ: [NAZI_SYMBOLS, HOLOCAUST], HU: [HOLOCAUST], RO: [HOLOCAUST], IL: [HOLOCAUST], RU: [HOLOCAUST],
};

// ── Bloque de contenido ──
// Cada opción tiene la edad mínima que implica; `d` es un descriptor opcional que se muestra en la etiqueta.
const Q = (id, text, options, only, optional) => ({ id, text, options, only, optional: !!optional });
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
    O('Desnudez parcial (pechos, glúteos o torso descubiertos) o movimientos y escenas sexuales simulados o sugeridos, sin mostrar genitales ni sexo explícito', 'Partial nudity (uncovered chest, buttocks or torso) or simulated or implied sexual movements and scenes, without showing genitals or explicit sex', 16, 'sexual'),
    O('Genitales descubiertos en un cuerpo o personaje, sin fin educativo, o actos sexuales explícitos (solo para adultos; una parte suelta o desprendida, que no está unida a ningún cuerpo, no cuenta como desnudez, ni tampoco un personaje u objeto que solo tiene esa forma, p. ej. una cabeza con esa forma, en caricatura: eso es humor tabú)', 'Uncovered genitals on a body or character with no educational purpose, or explicit sexual acts (adults only; a loose or detached part that is not attached to any body does not count as nudity, and neither does a character or object that merely has that shape, such as a head shaped like that, drawn as a caricature: that is taboo humor)', 18, 'sexual_explicit'),
  ]),
  // Humor tabú: el sexo u otros temas tabú contados COMO HUMOR (chiste, sátira, absurdo), sin erotismo, no suben a 18+.
  // Solo cambia a 18+ si se muestran partes íntimas descubiertas sin fin educativo (o si es erótico).
  Q('taboo', T('Humor sobre sexo u otros temas tabú (muerte, religión, drogas, enfermedades, cuerpo...), sin erotismo', 'Humor about sex or other taboo topics (death, religion, drugs, illness, the body...), not erotic'), [
    O('No hay', 'None', 0),
    O('Chistes o referencias tabú leves, sin mostrar partes íntimas', 'Mild taboo jokes or references, without showing intimate parts', AGE_TABOO_MILD, 'taboo_humor'),
    O('Humor tabú fuerte o crudo (contado, insinuado, con movimientos sexuales simulados, con partes íntimas sueltas, no unidas a ningún cuerpo, o con personajes u objetos que solo tienen esa forma, p. ej. una cabeza con esa forma, en caricatura), sin erotismo explícito y sin mostrar genitales en un cuerpo', 'Strong or crude taboo humor (told, implied, with simulated sexual movements, with loose intimate parts not attached to any body, or with characters or objects that merely have that shape, such as a head shaped like that, drawn as a caricature), not explicitly erotic and without showing genitals on a body', AGE_TABOO_STRONG, 'taboo_humor'),
    O('Muestra genitales con fin educativo (educación sexual, anatomía, salud), sin erotismo', 'Shows genitals for an educational purpose (sex education, anatomy, health), not erotic', AGE_BODY_EDU, 'body_edu'),
    O('Muestra genitales descubiertos en un cuerpo o personaje sin fin educativo, o es erótico explícito (solo para adultos; una parte suelta, no unida a ningún cuerpo, no cuenta, ni un personaje u objeto que solo tiene esa forma, p. ej. una cabeza con esa forma, en caricatura)', 'Shows uncovered genitals on a body or character with no educational purpose, or is explicitly erotic (adults only; a loose part not attached to any body does not count, nor does a character or object that merely has that shape, such as a head shaped like that, as a caricature)', 18, 'sexual_explicit'),
  ], null, true),
  Q('language', T('Lenguaje', 'Language'), [
    O('Sin groserías', 'No profanity', 0),
    O('Insultos muy suaves', 'Very mild insults', 7, 'language'),
    O('Groserías moderadas', 'Moderate profanity', 12, 'language'),
    O('Groserías fuertes o frecuentes', 'Strong or frequent profanity', 16, 'language'),
  ]),
  Q('discrimination', T('Discriminación, también en chistes, humor negro o sátira (que no llegue a incitar a la violencia: eso es ilegal)', 'Discrimination, including jokes, dark humor, or satire (short of inciting violence, which is illegal)'), [
    O('Ninguna', 'None', 0),
    O('Estereotipos o chistes leves', 'Mild stereotypes or jokes', 12, 'discrimination'),
    O('Lenguaje discriminatorio presente', 'Discriminatory language present', 16, 'discrimination'),
    O('Discriminación como tema central u ofensiva', 'Discrimination as a central or offensive theme', 16, 'discrimination'),   // Crix es de los sistemas más relajados: la discriminación (también como humor) nunca llega a 18+
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
  // Alcance de la clasificación: un juego puede tener partes de otras clasificaciones, o secciones +18 separadas, sin que TODO el juego pase a esa clasificación.
  // Las demás preguntas se responden por lo que es el juego en general; esta aclara lo que queda aparte. Las secciones +18 no suben la edad del juego,
  // pero hay que limitarlas a quien tiene +18 verificado (en los scripts: player.isAdult).
  Q('scope', T('¿Toda la clasificación aplica a todo el juego?', 'Does the whole rating apply to the whole game?'), [
    O('Sí: todo el juego es de la misma clasificación (lo que respondí vale para todo)', 'Yes: the whole game has the same rating (what I answered applies to all of it)', 0),
    O('Tiene partes con contenido de otras clasificaciones, variado según la zona o el modo (respondí por el contenido general; lo más fuerte está arriba en las preguntas)', 'It has parts with content from other ratings, varying by area or mode (I answered for the general content; the strongest content is covered in the questions above)', 0, 'mixed'),
    O('Tiene secciones +18 separadas u opcionales, pero el juego en su conjunto NO es +18 (respondí las preguntas sin contar esas secciones, y solo las ve quien tiene +18 verificado)', 'It has separate or optional 18+ sections, but the game as a whole is NOT 18+ (I answered the questions without counting those sections, and only users with verified 18+ can see them)', 0, 'adult_parts'),
  ], ['game', 'app'], true),
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
  taboo_humor:      T('Humor tabú', 'Taboo humor'),
  body_edu:         T('Cuerpo con fin educativo', 'Body shown for education'),
  language:         T('Lenguaje soez', 'Strong language'),
  discrimination:   T('Discriminación', 'Discrimination'),
  drugs:            T('Drogas, alcohol o tabaco', 'Drugs, alcohol, or tobacco'),
  gambling:         T('Juegos de azar', 'Gambling'),
  gambling_real:    T('Apuestas con dinero real', 'Real-money gambling'),
  purchases:        T('Compras con dinero real', 'In-app purchases'),
  loot:             T('Cajas sorpresa pagas', 'Paid random rewards'),
  online:           T('Interacción entre usuarios', 'Users interact'),
  ugc:              T('Incluye contenido de usuarios (no clasificado)', 'Includes user-generated content (not rated)'),
  mixed:            T('Contenido variado según la zona o el modo', 'Content varies by area or mode'),
  adult_parts:      T('Incluye secciones +18 separadas', 'Includes separate 18+ sections'),
  kids:             T('Para niños', 'For children'),
};

// Idiomas: es y en están escritos en este archivo; pt, fr, de, it vienen de classification-i18n.js (si falta una traducción, inglés).
const LANGS = ['es', 'en', ...I18N.LANGS];
const langOf = l => { const c = String(l || '').toLowerCase().slice(0, 2); return LANGS.includes(c) ? c : 'en'; };
const tr = (table, en, lang) => (table[en] && table[en][I18N.LANGS.indexOf(lang)]) || en;
const pick = (obj, lang) => (lang === 'es' ? obj.es : lang === 'en' ? obj.en : tr(I18N.TR, obj.en, lang));
const countryLabel = (code, name, lang) => {
  if (lang === 'es') return name;
  if (code === 'ZZ') return I18N.OTHER_COUNTRY[lang];
  try { return new Intl.DisplayNames([lang], { type: 'region' }).of(code) || name; } catch { return name; }
};

function legalFor(country) { return [...LEGAL_COMMON, ...(LEGAL_EXTRA[country] || [])]; }
function questionsFor(kind) { return CONTENT.filter(q => !q.only || q.only.includes(kind)); }

// Configuración que consume el cliente para dibujar el cuestionario.
function publicConfig(kind, lang) {
  const l = langOf(lang);
  const k = KINDS.includes(kind) ? kind : 'game';
  return {
    version: VERSION,
    countries: Object.entries(COUNTRIES).map(([code, [name, system]]) => ({ code, name: countryLabel(code, name, l), system, systemName: SYSTEMS[system].name }))
      .sort((a, b) => (a.code === 'ZZ') - (b.code === 'ZZ') || a.name.localeCompare(b.name, l)),
    legalCommon: LEGAL_COMMON.map(x => ({ id: x.id, text: pick(x.text, l) })),
    legalExtra: Object.fromEntries(Object.entries(LEGAL_EXTRA).map(([c, list]) => [c, list.map(x => ({ id: x.id, text: pick(x.text, l) }))])),
    rights: { id: LEGAL_RIGHTS.id, text: pick(LEGAL_RIGHTS.text, l) },
    questions: questionsFor(k).map(q => ({ id: q.id, text: pick(q.text, l), options: q.options.map(o => pick(o.text, l)), ...(q.optional ? { optional: true } : {}) })),
  };
}

// ── Evaluación ──
// input: { kind, country, answers:{ [questionId]: índice de opción }, legal:{ [legalId]: true|false }, declared:true }
// Devuelve { ok:true, result } o { ok:false, code, err, reasons? }.
function evaluate(input, lang) {
  const l = langOf(lang);
  const msg = (es, en) => (l === 'es' ? es : l === 'en' ? en : tr(I18N.MSG, en, l));
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
    const idx = (answers[q.id] === undefined && q.optional) ? 0 : answers[q.id];   // preguntas nuevas: si falta, "ninguno" (no rompe clasificaciones ya guardadas ni clientes de API viejos)
    if (!Number.isInteger(idx) || idx < 0 || idx >= q.options.length) return fail('CLASSIFICATION_INVALID', 'Respondé todas las preguntas de contenido.', 'Answer all the content questions.');
    clean[q.id] = idx;
    const opt = q.options[idx];
    age = Math.max(age, opt.age);
    if (opt.d) descriptors.add(opt.d);
  }
  // Un medio para niños no puede tener contenido de 13+, ni secciones +18 aparte.
  if (descriptors.has('kids') && (age > 12 || descriptors.has('adult_parts'))) {
    return fail('KIDS_CONFLICT', 'Dijiste que es para menores de 13 años pero el contenido que declaraste es para mayores.', 'You said it is for children under 13, but the content you declared is for older audiences.');
  }
  const tier = TIERS.find(t => t >= age) ?? 18;
  const tierIdx = TIERS.indexOf(tier);
  const [countryNameEs, systemId] = COUNTRIES[country];
  const countryName = countryLabel(country, countryNameEs, l);
  const system = SYSTEMS[systemId];
  const explicitSex = descriptors.has('sexual_explicit');   // algunos sistemas (AR, MX, AU) tienen una etiqueta aparte para sexo explícito
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

// ── Insignia en SVG para usar fuera de Crix (GET /api/v1/rating/badge.svg y campo `badge` de /evaluate) ──
// Mismos dibujos que CLS_SYS en index.html (forma + código por sistema). Son diseños propios de Crix, no sellos oficiales.
const BADGE_STYLE = {
  GENERIC: ['GL', 'circle'], ESRB: ['EUU', 'shield'], PEGI: ['EU', 'hexagon'], USK: ['DE', 'square'], CLASSIND: ['BR', 'diamond'],
  CERO: ['JP', 'octagon'], GRAC: ['KR', 'pentagon'], ACB: ['AU', 'pill'], MX: ['MX', 'banner'], AR: ['AR', 'ring'], CL: ['CL', 'arch'], CO: ['CO', 'hex2'],
};
const BADGE_SHAPES = {
  circle:  '<circle class="sh" cx="18" cy="20" r="17"/>',
  ring:    '<circle class="sh" cx="18" cy="20" r="17"/><circle cx="18" cy="20" r="13.5" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.2"/>',
  shield:  '<path class="sh" d="M18 2 L33 7 V20 C33 30 26 36 18 39 C10 36 3 30 3 20 V7 Z"/>',
  hexagon: '<path class="sh" d="M18 2 L33 11 V29 L18 38 L3 29 V11 Z"/>',
  square:  '<rect class="sh" x="3" y="4" width="30" height="32" rx="8"/>',
  diamond: '<path class="sh" d="M18 1 L35 20 L18 39 L1 20 Z"/>',
  octagon: '<path class="sh" d="M12 3 H24 L33 12 V28 L24 37 H12 L3 28 V12 Z"/>',
  pentagon:'<path class="sh" d="M18 2 L34 14 L28 36 H8 L2 14 Z"/>',
  pill:    '<rect class="sh" x="2" y="6" width="32" height="28" rx="14"/>',
  banner:  '<path class="sh" d="M4 3 H32 V28 L18 38 L4 28 Z"/>',
  arch:    '<path class="sh" d="M3 38 V16 Q3 2 18 2 Q33 2 33 16 V38 Z"/>',
  hex2:    '<path class="sh" d="M10 2 H26 L34 20 L26 38 H10 L2 20 Z"/>',
};
const BADGE_COLORS = { 0: '#2f9e5f', 7: '#2b9aa8', 12: '#e5b22a', 16: '#e8782a', 18: '#d93a3a' };
// Devuelve el SVG (texto) o null si el sistema o la edad no existen. `size` = alto en px.
function badgeSvg(systemId, age, explicit, size) {
  const st = BADGE_STYLE[systemId], sys = SYSTEMS[systemId], tier = TIERS.includes(Number(age)) ? Number(age) : null;
  if (!st || !sys || tier === null) return null;
  const label = explicit && sys.explicit ? sys.explicit.label : sys.labels[TIERS.indexOf(tier)];
  const num = explicit && sys.explicit ? '18' : ((label.match(/\d+/) || [])[0] || (label === 'Livre' ? 'L' : 'T'));
  const h = Math.max(16, Math.min(512, Number(size) || 64)), w = Math.round(h * 36 / 40);
  const txt = tier === 12 ? '#1b1b1b' : '#fff';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 40" width="${w}" height="${h}" role="img" aria-label="${sys.name} · ${label}"><title>${sys.name} · ${label}</title>` +
    `<style>.sh{fill:${BADGE_COLORS[tier]}}text{fill:${txt};text-anchor:middle;font-family:Arial,Helvetica,sans-serif;font-weight:900}</style>` +
    BADGE_SHAPES[st[1]] + `<text x="18" y="12.5" font-size="7">${st[0]}</text><text x="18" y="29" font-size="${num.length > 1 ? 15 : 17}">${num}</text>` +
    (explicit && sys.explicit ? '<text x="18" y="36" font-size="6">XXX</text>' : '') + '</svg>';
}

module.exports = { badgeSvg, evaluate, isValid, publicConfig, detectCountry, countryOf, clientIp, COUNTRIES, SYSTEMS, KINDS, VERSION, langOf };
