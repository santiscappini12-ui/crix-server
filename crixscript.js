'use strict';

// CrixScript → JavaScript.
//
// Traductor basado en tokens (no en regex sobre el texto): respeta cadenas y comentarios, soporta
// if/elseif/else, while, for numérico, for … in pairs/ipairs, repeat … until, function (anónimas, con
// nombre, con puntos y con dos puntos), local, tablas ({a=1} y {1,2,3}), ~=, .., and/or/not, nil, #, ^ y
// llamadas con dos puntos (obj:metodo(x)). Las listas son arreglos de JavaScript (empiezan en 0).
//
// Este archivo se usa en el servidor (require) y se incrusta tal cual en el cliente (index.html).
// Debe ser un solo bloque autocontenido: no depende de nada externo.

function compileCrixScript(source) {
  const src = String(source || '');
  const toks = [];
  let i = 0, line = 1;
  const isIdStart = c => /[A-Za-z_$]/.test(c), isId = c => /[\w$]/.test(c), isDigit = c => /[0-9]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { toks.push({ t: 'nl', v: '\n', line }); line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      const m = /^--\[(=*)\[/.exec(src.slice(i, i + 40));
      if (m) {
        const close = ']' + m[1] + ']', end = src.indexOf(close, i + m[0].length);
        const stop = end < 0 ? src.length : end + close.length;
        const breaks = (src.slice(i, stop).match(/\n/g) || []).length;
        for (let b = 0; b < breaks; b++) toks.push({ t: 'nl', v: '\n', line: line + b });
        line += breaks; i = stop; continue;
      }
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      toks.push({ t: 'str', v: src.slice(i, j + 1), line }); i = j + 1; continue;
    }
    if (c === '[') {
      const m = /^\[(=*)\[/.exec(src.slice(i, i + 40));
      if (m) {
        const close = ']' + m[1] + ']', end = src.indexOf(close, i + m[0].length);
        const stop = end < 0 ? src.length : end;
        let body = src.slice(i + m[0].length, stop);
        if (body[0] === '\n') body = body.slice(1);
        toks.push({ t: 'str', v: '`' + body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`', line });
        line += (src.slice(i, stop).match(/\n/g) || []).length; i = end < 0 ? src.length : end + close.length; continue;
      }
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
      const m = /^(0[xX][0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
      toks.push({ t: 'num', v: m[0], line }); i += m[0].length; continue;
    }
    if (isIdStart(c)) {
      let j = i + 1; while (j < src.length && isId(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j), line }); i = j; continue;
    }
    const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
    if (three === '...') { toks.push({ t: 'op', v: three, line }); i += 3; continue; }
    if (['==', '~=', '<=', '>=', '..', '+=', '-=', '*=', '/=', '%=', '=>', '!=', '&&', '||'].includes(two)) { toks.push({ t: 'op', v: two, line }); i += 2; continue; }
    toks.push({ t: 'op', v: c, line }); i++;
  }

  // ── Utilidades de búsqueda sobre tokens ──
  const sig = k => { while (k < toks.length && toks[k].t === 'nl') k++; return k; };
  const open = { '(': ')', '[': ']', '{': '}' };
  // Índice del cierre que corresponde a la apertura en `k`.
  function matching(k) {
    const stack = [];
    for (let j = k; j < toks.length; j++) {
      const v = toks[j].t === 'op' ? toks[j].v : '';
      if (open[v]) stack.push(open[v]);
      else if (v === ')' || v === ']' || v === '}') { stack.pop(); if (!stack.length) return j; }
    }
    return toks.length - 1;
  }
  // ¿La llave en `k` abre un objeto (tiene `clave =` o `[expr] =` a su nivel) o una lista?
  function braceIsObject(k) {
    const end = matching(k);
    let depth = 0;
    for (let j = k + 1; j < end; j++) {
      const tk = toks[j], v = tk.t === 'op' ? tk.v : '';
      if (open[v]) { depth++; if (depth === 1 && v === '[') { const m = matching(j); const n = sig(m + 1); if (toks[n] && toks[n].t === 'op' && toks[n].v === '=') return true; } continue; }
      if (v === ')' || v === ']' || v === '}') { depth--; continue; }
      if (depth === 0 && tk.t === 'id') { const n = sig(j + 1); if (toks[n] && toks[n].t === 'op' && toks[n].v === '=' && !(toks[n + 1] && toks[n + 1].v === '=')) return true; }
    }
    return false;
  }
  // Fin de la "expresión de la línea" desde `k`: primer salto de línea fuera de paréntesis (o token de cierre de bloque).
  function lineEnd(k) {
    let depth = 0;
    for (let j = k; j < toks.length; j++) {
      const v = toks[j].t === 'op' ? toks[j].v : '';
      if (open[v]) depth++; else if (v === ')' || v === ']' || v === '}') depth--;
      if (depth <= 0 && toks[j].t === 'nl') return j;
      if (depth <= 0 && toks[j].t === 'id' && (toks[j].v === 'end' || toks[j].v === 'else' || toks[j].v === 'elseif')) return j;
    }
    return toks.length;
  }
  // Tokens (como lista) entre dos índices, ya traducidos recursivamente.
  const sub = (a, b) => compileTokens(toks.slice(a, b));

  const BLOCK_START = new Set(['if', 'while', 'for', 'function', 'repeat']);
  let tmp = 0;
  const out = [];
  const stack = []; // tipos de bloque abiertos: 'brace' | 'until'

  function compileTokens(list) {
    // Traducción recursiva de un fragmento (expresiones). Reutiliza el mismo algoritmo en una instancia aislada.
    const saved = { toks: toks.slice(), out: out.slice(), stack: stack.slice() };
    toks.length = 0; toks.push(...list); out.length = 0; stack.length = 0;
    run();
    const result = out.join('');
    toks.length = 0; toks.push(...saved.toks); out.length = 0; out.push(...saved.out); stack.length = 0; stack.push(...saved.stack);
    return result.trim();
  }

  function emitFunctionHead(k) {
    // toks[k] es `function`. Devuelve el índice del `(` de los parámetros.
    let j = sig(k + 1);
    if (toks[j] && toks[j].t === 'op' && toks[j].v === '(') { out.push('function '); return j; }
    // function a.b.c(…) | function a:b(…) | function nombre(…)
    const parts = []; let colon = false;
    while (toks[j] && (toks[j].t === 'id' || (toks[j].t === 'op' && (toks[j].v === '.' || toks[j].v === ':')))) {
      if (toks[j].v === ':') colon = true;
      parts.push(toks[j].v); j++;
    }
    const name = parts.join('').replace(':', '.');
    out.push(parts.length === 1 ? 'function ' + name : name + ' = function ');
    void colon;
    return j;
  }

  const NO_SEMI_AFTER = new Set(['function', 'local', 'if', 'elseif', 'while', 'for', 'not', 'and', 'or', 'return', 'then', 'do', 'else', 'repeat', 'until', 'in', 'end']);
  const NO_SEMI_BEFORE = new Set(['and', 'or', 'then', 'do', 'in', 'end', 'else', 'elseif', 'until']);
  let skipSemiAt = -1;
  function run() {
    skipSemiAt = -1;
    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k];
      if (tk.t === 'nl') { out.push('\n'); continue; }
      const prev = toks[k - 1];
      if (k !== skipSemiAt && prev && prev.t !== 'nl' && tk.t === 'id' && !NO_SEMI_BEFORE.has(tk.v) &&
          (prev.t === 'str' || prev.t === 'num' || (prev.t === 'id' && !NO_SEMI_AFTER.has(prev.v)) || (prev.t === 'op' && (prev.v === ')' || prev.v === ']' || prev.v === '}')))) out.push(';');
      if (tk.t === 'str' || tk.t === 'num') { out.push(tk.v); continue; }
      if (tk.t === 'op') {
        const v = tk.v;
        if (v === '~=') out.push(' !== ');
        else if (v === '==') out.push(' === ');
        else if (v === '!=') out.push(' !== ');
        else if (v === '..') out.push(' + ');
        else if (v === '^') out.push(' ** ');
        else if (v === '#') {
          // #x, #x.y, #obj[1], #f(x)
          let j = sig(k + 1), end = j;
          while (end < toks.length) {
            const n = toks[end];
            if (n.t === 'id') { end++; }
            else if (n.t === 'op' && (n.v === '.' || n.v === ':')) { end++; }
            else if (n.t === 'op' && (n.v === '(' || n.v === '[')) { end = matching(end) + 1; }
            else break;
          }
          out.push('__len(' + sub(j, end) + ')'); k = end - 1;
        } else if (v === '{') {
          const end = matching(k), isObj = braceIsObject(k);
          let body = '';
          // Contenido: claves `nombre =` → `nombre:`; `[e] =` → `[e]:`
          const inner = toks.slice(k + 1, end);
          const fixed = [];
          let depth = 0;
          for (let q = 0; q < inner.length; q++) {
            const it = inner[q], iv = it.t === 'op' ? it.v : '';
            if (open[iv]) depth++; else if (iv === ')' || iv === ']' || iv === '}') depth--;
            if (isObj && depth === 0 && it.t === 'op' && it.v === '=' && !(inner[q + 1] && inner[q + 1].v === '=') && !(inner[q - 1] && ['=', '~', '<', '>'].includes(inner[q - 1].v))) { fixed.push({ t: 'op', v: ':', objKey: true, line: it.line }); continue; }
            fixed.push(it);
          }
          body = compileTokens(fixed);
          out.push(isObj ? '{' + body + '}' : '[' + body + ']'); k = end;
        } else if (v === ':') {
          // obj:metodo(...) → obj.metodo(...)   (en tablas, `clave =` ya viene marcada como clave)
          out.push(tk.objKey ? ':' : '.');
        } else if ((v === '-' || v === '+') && /[-+]$/.test(out[out.length - 1] || '')) out.push(' ' + v);
        else out.push(v);
        continue;
      }
      // identificadores y palabras clave
      const w = tk.v;
      switch (w) {
        case 'local': {
          let j = sig(k + 1);
          if (toks[j] && toks[j].v === 'function') { k = j - 1; break; }
          // local a, b = x, y
          const names = []; let q = j;
          while (toks[q] && toks[q].t === 'id') { names.push(toks[q].v); q = sig(q + 1); if (toks[q] && toks[q].v === ',') q = sig(q + 1); else break; }
          if (names.length > 1) {
            if (toks[q] && toks[q].t === 'op' && toks[q].v === '=') {
              const end = lineEnd(q + 1);
              out.push('let [' + names.join(', ') + '] = __mv(' + sub(q + 1, end) + ')'); k = end - 1;
            } else { out.push('let ' + names.join(', ')); k = q - 1; }
          } else out.push('let ');
          if (names.length > 1) break;
          break;
        }
        case 'function': {
          const paren = emitFunctionHead(k);
          const close = matching(paren);
          const params = sub(paren + 1, close).replace(/\.\.\./g, '...args');
          // método con dos puntos: no agrega parámetro; `self` se traduce a `this`.
          out.push('(' + params + ') {'); stack.push('brace'); k = close; skipSemiAt = k + 1;
          break;
        }
        case 'if': { const end = findKeyword(k + 1, 'then'); out.push('if (' + sub(k + 1, end) + ') {'); stack.push('brace'); k = end; break; }
        case 'elseif': { const end = findKeyword(k + 1, 'then'); out.push('} else if (' + sub(k + 1, end) + ') {'); k = end; break; }
        case 'else': out.push('} else {'); break;
        case 'while': { const end = findKeyword(k + 1, 'do'); out.push('while (' + sub(k + 1, end) + ') {'); stack.push('brace'); k = end; break; }
        case 'for': {
          const doIdx = findKeyword(k + 1, 'do');
          const head = toks.slice(k + 1, doIdx);
          const inIdx = head.findIndex(t => t.t === 'id' && t.v === 'in');
          if (inIdx >= 0) {
            const names = head.slice(0, inIdx).filter(t => t.t === 'id').map(t => t.v);
            const expr = compileTokens(head.slice(inIdx + 1));
            const direct = /^i?pairs\(/.test(expr);
            out.push('for (const [' + (names.length === 1 ? names[0] + ', __' + (++tmp) : names.join(', ')) + '] of ' + (direct ? expr : '__iter(' + expr + ')') + ') {');
          } else {
            const name = head[0].v;
            const eq = head.findIndex(t => t.t === 'op' && t.v === '=');
            const rest = head.slice(eq + 1), parts = []; let cur = [], depth = 0;
            for (const t of rest) {
              const v = t.t === 'op' ? t.v : '';
              if (open[v]) depth++; else if (v === ')' || v === ']' || v === '}') depth--;
              if (v === ',' && depth === 0) { parts.push(cur); cur = []; } else cur.push(t);
            }
            parts.push(cur);
            const n = ++tmp, a = compileTokens(parts[0]), b = compileTokens(parts[1] || []), s = parts[2] ? compileTokens(parts[2]) : '1';
            out.push('for (let ' + name + ' = ' + a + ', __e' + n + ' = ' + b + ', __s' + n + ' = ' + s + '; __s' + n + ' > 0 ? ' + name + ' <= __e' + n + ' : ' + name + ' >= __e' + n + '; ' + name + ' += __s' + n + ') {');
          }
          stack.push('brace'); k = doIdx; break;
        }
        case 'do': out.push('{'); stack.push('brace'); break;
        case 'repeat': out.push('do {'); stack.push('until'); break;
        case 'until': {
          const end = lineEnd(k + 1);
          out.push('} while (!(' + sub(k + 1, end) + '))'); stack.pop(); k = end - 1; break;
        }
        case 'end': out.push('}'); stack.pop(); break;
        case 'then': case 'in': break; // ya consumidos
        case 'and': out.push(' && '); break;
        case 'or': out.push(' || '); break;
        case 'not': out.push('!'); break;
        case 'nil': out.push('null'); break;
        case 'self': out.push('this'); break;
        case 'return': {
          // return a, b  →  return [a, b]
          const end = lineEnd(k + 1);
          const seg = toks.slice(k + 1, end);
          let depth = 0, commas = false;
          for (const t of seg) { const v = t.t === 'op' ? t.v : ''; if (open[v]) depth++; else if (v === ')' || v === ']' || v === '}') depth--; if (v === ',' && depth === 0) commas = true; }
          if (commas) { out.push('return [' + compileTokens(seg) + ']'); k = end - 1; } else out.push('return ');
          break;
        }
        case 'elif': out.push(w); break;
        default: out.push(w);
      }
      // Espacio de separación entre palabras/identificadores consecutivos
      const next = toks[k + 1];
      if (next && (next.t === 'id' || next.t === 'num' || next.t === 'str') && /[\w$]$/.test(out[out.length - 1] || '')) out.push(' ');
    }
  }

  function findKeyword(from, word) {
    let depth = 0;
    for (let j = from; j < toks.length; j++) {
      const t = toks[j], v = t.t === 'op' ? t.v : '';
      if (open[v]) depth++; else if (v === ')' || v === ']' || v === '}') depth--;
      if (depth === 0 && t.t === 'id' && t.v === word) return j;
      if (depth === 0 && t.t === 'id' && word === 'then' && (t.v === 'end')) return j;
    }
    return toks.length - 1;
  }
  void BLOCK_START;

  run();
  return out.join('');
}

// Biblioteca mínima tipo Lua que viaja junto con el código traducido (se evalúa dentro del aislamiento / worker).
const CRIXSCRIPT_PRELUDE = `
const __len = v => v == null ? 0 : (typeof v === 'string' || Array.isArray(v)) ? v.length : Object.keys(v).length;
const __mv = (...a) => a.length === 1 && Array.isArray(a[0]) ? a[0] : a;
const __iter = v => { if (v && typeof v[Symbol.iterator] === 'function' && !(typeof v === 'string')) { if (Array.isArray(v)) return v.entries(); return v[Symbol.iterator](); } if (v && v.__pairs) return v.__pairs; return Object.entries(v || {}); };
const pairs = v => Array.isArray(v) ? Array.from(v.entries()).concat(Object.entries(v).filter(([k]) => !/^\\d+$/.test(k))) : Object.entries(v || {});
const ipairs = v => Array.from((v || []).entries());
const type = v => v === null || v === undefined ? 'nil' : Array.isArray(v) ? 'table' : typeof v === 'object' ? 'table' : typeof v === 'function' ? 'function' : typeof v;
const select = (n, ...a) => n === '#' ? a.length : a.slice(n - 1);
const unpack = v => v;
const table = {
  insert: (t, a, b) => { if (b === undefined) t.push(a); else t.splice(a, 0, b); },
  remove: (t, i) => i === undefined ? t.pop() : t.splice(i, 1)[0],
  concat: (t, s) => t.join(s === undefined ? '' : s),
  sort: (t, f) => t.sort(f ? (a, b) => (f(a, b) ? -1 : f(b, a) ? 1 : 0) : undefined),
  unpack: t => t, clear: t => { t.length = 0; }, find: (t, v) => { const i = t.indexOf(v); return i < 0 ? null : i; }
};
const os = { time: () => Math.floor(Date.now() / 1000), clock: () => Date.now() / 1000 };
const string = {
  upper: s => String(s).toUpperCase(), lower: s => String(s).toLowerCase(), len: s => String(s).length,
  sub: (s, i, j) => String(s).substring(i - 1, j === undefined ? undefined : j), rep: (s, n) => String(s).repeat(Math.max(0, n)),
  split: (s, sep) => String(s).split(sep), find: (s, p) => { const i = String(s).indexOf(p); return i < 0 ? null : [i + 1, i + String(p).length]; },
  format: (f, ...a) => { let n = 0; return String(f).replace(/%(-?\\d*)(?:\\.(\\d+))?([dsfxXgi%])/g, (m, w, p, c) => { if (c === '%') return '%'; const v = a[n++]; let r = c === 'd' || c === 'i' ? String(Math.trunc(Number(v))) : c === 'f' ? Number(v).toFixed(p === undefined ? 6 : Number(p)) : c === 'x' ? Number(v).toString(16) : c === 'X' ? Number(v).toString(16).toUpperCase() : String(v); const width = Math.abs(parseInt(w || '0', 10)) || 0; if (/^0/.test(w || '')) r = r.padStart(width, '0'); else if ((w || '').startsWith('-')) r = r.padEnd(width); else r = r.padStart(width); return r; }); }
};
for (const [name, fn] of Object.entries({ upper: s => s.toUpperCase(), lower: s => s.toLowerCase(), len: s => s.length })) { try { Object.defineProperty(String.prototype, name, { value: function () { return fn(String(this)); }, configurable: true }); } catch (_) {} }
`;

if (typeof module !== 'undefined' && module.exports) module.exports = { compileCrixScript, CRIXSCRIPT_PRELUDE };
