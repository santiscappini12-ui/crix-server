'use strict';
/*
 * CrixNative — puente entre los scripts de los juegos y las funciones nativas del dispositivo (PWA).
 *
 * Los LocalScript corren en un Web Worker (sin acceso a navigator.vibrate, Notification, etc.) y los juegos
 * HTML corren en un iframe aislado (sandbox, origen opaco). Los dos le piden las cosas a la página principal
 * por postMessage y este módulo las ejecuta con las APIs reales del navegador.
 *
 * Reglas de seguridad (los scripts los escribe cualquiera y corren en el dispositivo de quien juega):
 *  - Notificaciones, ubicación, micrófono (reconocimiento de voz), lectura del portapapeles y sensores piden
 *    un permiso propio de Crix POR JUEGO antes de llegar al permiso del navegador. Se recuerda la respuesta.
 *  - Las acciones que el navegador solo permite tras un toque (compartir, pantalla completa, copiar, permisos…)
 *    muestran un botón "Tocá para continuar" si el script las pidió sin toque reciente.
 *  - Límites de ritmo, de tamaño y de duración; todo se apaga al salir del juego (vibración, sensores,
 *    pantalla encendida, voz, ubicación).
 *  - Cada notificación lleva el nombre del juego en el título para que no pueda hacerse pasar por Crix.
 *
 * Se carga como script clásico (/crix-native.js). Usa de la página, si existen: swReady(), showToast().
 */
(function () {
  if (window.CrixNative) return;

  // ───────────────────────── Textos ─────────────────────────
  const TXT = {
    es: { allow: 'Permitir', deny: 'Ahora no', cancel: 'Cancelar', tap: '👆 Tocá para continuar',
      q_notifications: 'quiere enviarte notificaciones', q_location: 'quiere conocer tu ubicación',
      q_microphone: 'quiere usar el micrófono para reconocer tu voz', q_clipboard: 'quiere leer tu portapapeles',
      q_sensors: 'quiere usar los sensores de movimiento de tu dispositivo',
      note: 'Podés cambiarlo luego en los ajustes del navegador. Crix recuerda tu respuesta para este juego.',
      g_notif: 'activar notificaciones', g_share: 'compartir', g_copy: 'copiar', g_paste: 'pegar', g_full: 'pantalla completa',
      g_orient: 'bloquear orientación', g_listen: 'usar el micrófono', g_sensors: 'activar sensores', g_install: 'instalar Crix',
      g_save: 'guardar archivo', g_loc: 'ubicación', g_speak: 'hablar', iosInstall: 'En iPhone/iPad: Compartir → Agregar a inicio' },
    en: { allow: 'Allow', deny: 'Not now', cancel: 'Cancel', tap: '👆 Tap to continue',
      q_notifications: 'wants to send you notifications', q_location: 'wants to know your location',
      q_microphone: 'wants to use the microphone to recognize your voice', q_clipboard: 'wants to read your clipboard',
      q_sensors: 'wants to use your device motion sensors',
      note: 'You can change this later in your browser settings. Crix remembers your answer for this game.',
      g_notif: 'enable notifications', g_share: 'share', g_copy: 'copy', g_paste: 'paste', g_full: 'fullscreen',
      g_orient: 'lock orientation', g_listen: 'use the microphone', g_sensors: 'enable sensors', g_install: 'install Crix',
      g_save: 'save file', g_loc: 'location', g_speak: 'speak', iosInstall: 'On iPhone/iPad: Share → Add to Home Screen' },
    pt: { allow: 'Permitir', deny: 'Agora não', cancel: 'Cancelar', tap: '👆 Toque para continuar',
      q_notifications: 'quer enviar notificações', q_location: 'quer saber sua localização',
      q_microphone: 'quer usar o microfone para reconhecer sua voz', q_clipboard: 'quer ler sua área de transferência',
      q_sensors: 'quer usar os sensores de movimento do dispositivo',
      note: 'Você pode mudar isso depois nas configurações do navegador. O Crix lembra sua resposta para este jogo.',
      g_notif: 'ativar notificações', g_share: 'compartilhar', g_copy: 'copiar', g_paste: 'colar', g_full: 'tela cheia',
      g_orient: 'bloquear orientação', g_listen: 'usar o microfone', g_sensors: 'ativar sensores', g_install: 'instalar o Crix',
      g_save: 'salvar arquivo', g_loc: 'localização', g_speak: 'falar', iosInstall: 'No iPhone/iPad: Compartilhar → Adicionar à Tela de Início' }
  };
  function lang() {
    let l = 'es';
    try { l = (typeof LANG === 'string' && LANG) || localStorage.getItem('crix_lang') || (navigator.language || 'es').slice(0, 2); } catch (_) {}
    return TXT[l] ? l : 'en';
  }
  const t = k => (TXT[lang()] || TXT.en)[k] || TXT.en[k] || k;

  // ───────────────────────── Utilidades ─────────────────────────
  const UA = navigator.userAgent || '';
  const IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IS_ANDROID = /Android/i.test(UA);
  const clip = (s, n) => String(s === undefined || s === null ? '' : s).slice(0, n);
  const num = (v, d, lo, hi) => { v = Number(v); if (!Number.isFinite(v)) v = d; return Math.max(lo, Math.min(hi, v)); };
  const round = (v, p) => (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v * p) / p : null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tagClean = s => clip(s, 40).replace(/[^A-Za-z0-9_\-:.]/g, '');
  function toast(msg, ms) { try { if (typeof showToast === 'function') showToast(msg, ms || 3500); } catch (_) {} }
  function game() {
    const g = window.__crixPlaying || {};
    return { id: String(g.id || 'local'), name: clip(g.name || 'Crix', 40) };
  }
  function gameUrl(g) { return g.id && g.id !== 'local' ? '/juego/' + encodeURIComponent(g.id) : '/'; }
  function safeJson(v, max) { try { const s = JSON.stringify(v === undefined ? null : v); return s.length <= max ? JSON.parse(s) : null; } catch (_) { return null; } }
  function isGestureErr(e) { return !!e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || /gesture|activation|user/i.test(String(e.message || ''))); }
  function activated() { try { return navigator.userActivation ? navigator.userActivation.isActive : true; } catch (_) { return true; } }

  // ───────────────────────── Estado por dueño (un LocalScript o un juego HTML) ─────────────────────────
  const owners = new Map();   // id → { ctx, subs:Map<nombre, parar>, wantWake, wake, rate:{}, vib, spoke }
  function owner(ctx) {
    let o = owners.get(ctx.id);
    if (!o) { o = { id: ctx.id, ctx, subs: new Map(), wantWake: false, wake: null, rate: {}, vib: false, spoke: false }; owners.set(ctx.id, o); }
    o.ctx = ctx; return o;
  }
  function rate(o, key, max, ms) {
    const now = Date.now(), a = (o.rate[key] = (o.rate[key] || []).filter(x => now - x < ms));
    if (a.length >= max) return false;
    a.push(now); return true;
  }

  // ───────────────────────── Interfaz: permiso por juego y "tocá para continuar" ─────────────────────────
  let modalChain = Promise.resolve();
  function el(tag, style, text) { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text !== undefined) e.textContent = text; return e; }
  function modal(build) {   // build(resolve) → nodo; se serializan para no apilar cuadros
    const run = () => new Promise(resolve => {
      const back = el('div', 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:18px;font-family:system-ui,sans-serif');
      const done = v => { try { back.remove(); } catch (_) {} resolve(v); };
      back.appendChild(build(done)); document.body.appendChild(back);
    });
    const p = modalChain.then(run, run); modalChain = p.catch(() => {}); return p;
  }
  const consentMem = new Map(), consentPending = new Map();
  function consentKey(kind) { return 'crix:nc:' + game().id + ':' + kind; }
  function consentGet(kind) {
    const k = consentKey(kind); if (consentMem.has(k)) return consentMem.get(k);
    try { const v = localStorage.getItem(k); if (v === '1' || v === '0') { consentMem.set(k, v === '1'); return v === '1'; } } catch (_) {}
    return null;
  }
  function consentSet(kind, val) { const k = consentKey(kind); consentMem.set(k, val); try { localStorage.setItem(k, val ? '1' : '0'); } catch (_) {} }
  async function consent(kind) {
    const known = consentGet(kind); if (known !== null) return known;
    const k = consentKey(kind); if (consentPending.has(k)) return consentPending.get(k);
    const p = modal(done => {
      const box = el('div', 'max-width:340px;width:100%;background:var(--bg2,#0d1b3a);color:var(--text,#fff);border:1px solid var(--border,rgba(255,255,255,.18));border-radius:16px;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.5)');
      box.appendChild(el('div', 'font-size:15px;font-weight:700;line-height:1.35;margin-bottom:8px', '“' + game().name + '” ' + t('q_' + kind)));
      box.appendChild(el('div', 'font-size:11px;opacity:.7;line-height:1.5;margin-bottom:14px', t('note')));
      const row = el('div', 'display:flex;gap:8px;justify-content:flex-end');
      const no = el('button', 'padding:9px 14px;border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.25));background:transparent;color:inherit;font-weight:600;cursor:pointer', t('deny'));
      const yes = el('button', 'padding:9px 16px;border-radius:10px;border:0;background:var(--accent,#2f80ff);color:#fff;font-weight:700;cursor:pointer', t('allow'));
      no.onclick = () => done(false); yes.onclick = () => done(true);
      row.append(no, yes); box.appendChild(row); return box;
    }).then(v => { consentSet(kind, !!v); consentPending.delete(k); return !!v; });
    consentPending.set(k, p); return p;
  }
  // Algunas acciones solo funcionan justo después de un toque. Si el script las pide sin toque reciente, se muestra un botón.
  function tapPrompt(label) {
    return modal(done => {
      const box = el('div', 'max-width:320px;width:100%;text-align:center;background:var(--bg2,#0d1b3a);color:var(--text,#fff);border:1px solid var(--border,rgba(255,255,255,.18));border-radius:16px;padding:18px');
      const go = el('button', 'width:100%;padding:14px;border-radius:12px;border:0;background:var(--accent,#2f80ff);color:#fff;font-size:15px;font-weight:700;cursor:pointer', t('tap') + (label ? ': ' + label : ''));
      const cancel = el('button', 'margin-top:10px;background:none;border:0;color:inherit;opacity:.65;cursor:pointer;font-size:12px', t('cancel'));
      const timer = setTimeout(() => done(false), 25000);
      go.onclick = () => { clearTimeout(timer); done(true); }; cancel.onclick = () => { clearTimeout(timer); done(false); };
      box.append(go, cancel); return box;
    }).then(ok => { if (!ok) throw new Error('Cancelado por la persona'); });
  }
  async function withGesture(label, fn) {
    if (activated()) { try { return await fn(); } catch (e) { if (!isGestureErr(e)) throw e; } }
    await tapPrompt(label); return await fn();
  }

  // ───────────────────────── Capacidades e información ─────────────────────────
  let installEvent = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; });
  window.addEventListener('appinstalled', () => { installEvent = null; });
  function standalone() { try { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; } catch (_) { return false; } }
  function capabilities() {
    const de = document.documentElement, SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    return {
      vibrate: !!navigator.vibrate, haptic: !!navigator.vibrate || IS_IOS || !!navigator.getGamepads,
      rumble: !!navigator.getGamepads,
      notifications: ('Notification' in window) && ('serviceWorker' in navigator),
      badge: 'setAppBadge' in navigator, wakeLock: 'wakeLock' in navigator,
      share: !!navigator.share, clipboard: !!(navigator.clipboard && navigator.clipboard.writeText),
      clipboardRead: !!(navigator.clipboard && navigator.clipboard.readText),
      fullscreen: !!(de.requestFullscreen || de.webkitRequestFullscreen),
      orientationLock: !!(screen.orientation && screen.orientation.lock),
      location: !!navigator.geolocation, orientation: 'DeviceOrientationEvent' in window, motion: 'DeviceMotionEvent' in window,
      battery: !!navigator.getBattery, network: true, speak: !!window.speechSynthesis, listen: !!SR,
      install: !!installEvent || (!standalone() && !IS_IOS), saveFile: true, permissions: !!navigator.permissions
    };
  }
  function info() {
    const c = navigator.connection || {};
    return {
      platform: IS_IOS ? 'ios' : IS_ANDROID ? 'android' : /Win/.test(navigator.platform) ? 'windows' : /Mac/.test(navigator.platform) ? 'mac' : /Linux/.test(navigator.platform) ? 'linux' : 'other',
      ios: IS_IOS, android: IS_ANDROID, standalone: standalone(), touch: (navigator.maxTouchPoints || 0) > 0,
      language: navigator.language || 'es', timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ''; } })(),
      screen: { width: screen.width, height: screen.height, dpr: window.devicePixelRatio || 1 },
      cores: navigator.hardwareConcurrency || 0, memory: navigator.deviceMemory || 0, online: navigator.onLine !== false,
      reducedMotion: !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches),
      darkMode: !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches),
      secureContext: !!window.isSecureContext, saveData: !!c.saveData
    };
  }

  // ───────────────────────── Vibración y háptica ─────────────────────────
  function cleanPattern(p) {
    if (typeof p === 'number') p = [p];
    if (!Array.isArray(p)) return [];
    let total = 0; const out = [];
    for (const v of p.slice(0, 30)) { const n = Math.round(num(v, 0, 0, 5000)); if (total + n > 10000) break; total += n; out.push(n); }
    return out;
  }
  let iosLabel = null;
  function iosTick() {   // Safari de iPhone no tiene navigator.vibrate; iOS 18+ da un toque háptico al activar un <input switch>.
    try {
      if (!iosLabel) {
        iosLabel = el('label', 'position:fixed;left:-200px;top:0;opacity:0;pointer-events:none'); iosLabel.setAttribute('aria-hidden', 'true');
        const i = document.createElement('input'); i.type = 'checkbox'; i.setAttribute('switch', ''); i.tabIndex = -1; iosLabel.appendChild(i); document.body.appendChild(iosLabel);
      }
      iosLabel.click();
    } catch (_) {}
  }
  function buzz(o, pattern) {
    const p = cleanPattern(pattern);
    if (navigator.vibrate) { try { const r = navigator.vibrate(p.length ? p : 0); o.vib = p.length > 0; return !!r; } catch (_) { return false; } }
    if (IS_IOS && p.length) {   // un pulso por cada tramo "encendido"
      let pulses = 0, t0 = 0; p.forEach((ms, i) => { if (i % 2 === 0 && ms > 0 && pulses < 6) { setTimeout(iosTick, t0); pulses++; } t0 += ms; });
      return true;
    }
    return false;
  }
  function rumble(ms, strong, weak) {
    try {
      let ok = false;
      for (const gp of (navigator.getGamepads ? navigator.getGamepads() : [])) {
        const a = gp && (gp.vibrationActuator || (gp.hapticActuators && gp.hapticActuators[0])); if (!a) continue;
        if (a.playEffect) { a.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {}); ok = true; }
        else if (a.pulse) { a.pulse(Math.max(strong, weak), ms).catch(() => {}); ok = true; }
      }
      return ok;
    } catch (_) { return false; }
  }
  const HAPTICS = {
    light: [10], select: [8], tick: [6], medium: [20], heavy: [45], soft: [14], rigid: [28],
    success: [15, 50, 15], warning: [35, 60, 35], error: [50, 40, 50, 40, 50], impact: [30]
  };

  // ───────────────────────── Operaciones ─────────────────────────
  const OPS = {
    // Cartel dentro del juego (estilo ventana de Windows) para cuando el creador no hizo uno propio.
    async dialog(ctx, a) {
      const kind = ['alert', 'confirm', 'prompt'].includes(a.kind) ? a.kind : 'alert';
      const dark = !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
      const C = dark ? { bg: '#2b2b2b', fg: '#fff', bar: '#202020', line: '#3d3d3d', btn: '#3a3a3a', inp: '#1f1f1f' } : { bg: '#f3f3f3', fg: '#1a1a1a', bar: '#fff', line: '#d6d6d6', btn: '#e5e5e5', inp: '#fff' };
      const title = clip(a.title, 80) || game().name, message = clip(a.message, 1000);
      const okT = clip(a.ok, 24) || (kind === 'confirm' ? 'Aceptar' : 'Aceptar'), noT = clip(a.cancel, 24) || 'Cancelar';
      const res = await modal(done => {
        const win = el('div', 'width:min(420px,100%);background:' + C.bg + ';color:' + C.fg + ';border:1px solid ' + C.line + ';border-radius:8px;box-shadow:0 16px 48px rgba(0,0,0,.55);overflow:hidden;font-size:14px');
        const bar = el('div', 'display:flex;align-items:center;gap:8px;padding:9px 12px;background:' + C.bar + ';font-size:12px;font-weight:600;border-bottom:1px solid ' + C.line);
        bar.appendChild(el('img', 'width:16px;height:16px')); bar.firstChild.src = '/icons/icon-192.png'; bar.firstChild.alt = '';
        bar.appendChild(el('span', 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title));
        const body = el('div', 'padding:18px 16px 14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto', message);
        win.append(bar, body);
        let input = null;
        if (kind === 'prompt') { input = el('input', 'display:block;box-sizing:border-box;width:calc(100% - 32px);margin:0 16px 14px;padding:8px 10px;border-radius:4px;border:1px solid ' + C.line + ';background:' + C.inp + ';color:inherit;font-size:14px'); input.value = clip(a.value, 200); input.placeholder = clip(a.placeholder, 80); input.maxLength = 200; win.appendChild(input); }
        const row = el('div', 'display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;background:' + C.bar + ';border-top:1px solid ' + C.line);
        const mk = (txt, primary) => el('button', 'min-width:88px;padding:7px 14px;border-radius:4px;border:1px solid ' + (primary ? 'var(--accent,#0067c0)' : C.line) + ';background:' + (primary ? 'var(--accent,#0067c0)' : C.btn) + ';color:' + (primary ? '#fff' : 'inherit') + ';font-size:13px;cursor:pointer', txt);
        const ok = mk(okT, true), no = mk(noT, false);
        const finish = v => { document.removeEventListener('keydown', key, true); done(v); };
        const key = e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(kind === 'prompt' ? { v: input.value } : { v: true }); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } };
        ok.onclick = () => finish(kind === 'prompt' ? { v: input.value } : { v: true }); no.onclick = () => finish(null);
        if (kind !== 'alert') row.appendChild(no); row.appendChild(ok); win.appendChild(row);
        document.addEventListener('keydown', key, true); setTimeout(() => { try { (input || ok).focus(); } catch (_) {} }, 30);
        return win;
      });
      if (kind === 'alert') return true;
      if (kind === 'confirm') return !!res;
      return res ? clip(res.v, 200) : null;
    },
    async caps() { return capabilities(); },
    async info() { return info(); },

    async vibrate(ctx, a, o) {
      if (!rate(o, 'vib', 40, 5000)) return false;
      return buzz(o, a.pattern);
    },
    async haptic(ctx, a, o) {
      if (!rate(o, 'vib', 40, 5000)) return false;
      const kind = String(a.kind || 'medium').toLowerCase(), p = HAPTICS[kind] || HAPTICS.medium;
      const viaPad = rumble(Math.max(40, p.reduce((x, y) => x + y, 0)), 0.8, 0.5);
      return buzz(o, p) || viaPad;
    },
    async rumble(ctx, a, o) {
      if (!rate(o, 'vib', 40, 5000)) return false;
      return rumble(Math.round(num(a.ms, 200, 10, 5000)), num(a.strong, 1, 0, 1), num(a.weak, 1, 0, 1));
    },

    async notifyPermission(ctx) {
      if (!('Notification' in window)) return 'unsupported';
      if (!(await consent('notifications'))) return 'denied';
      if (Notification.permission === 'default') { try { await withGesture(t('g_notif'), () => Notification.requestPermission()); } catch (_) {} }
      return Notification.permission;
    },
    async notify(ctx, a, o) {
      if (!('Notification' in window)) return false;
      if (a.onlyHidden && document.visibilityState === 'visible') return false;
      if (!(await consent('notifications'))) return false;
      if (Notification.permission === 'default') { try { await withGesture(t('g_notif'), () => Notification.requestPermission()); } catch (_) {} }
      if (Notification.permission !== 'granted') return false;
      const g = game(), tag = tagClean(a.tag);
      const title = clip(g.name + ' · ' + clip(a.title, 80), 120);
      const opts = {
        body: clip(a.body, 240), silent: !!a.silent, requireInteraction: !!a.requireInteraction,
        icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', timestamp: Date.now(),
        tag: 'game-' + tagClean(g.id) + '-' + (tag || 'n' + Date.now().toString(36)), renotify: !!tag,
        data: { type: 'script', url: gameUrl(g), script: { game: g.id, tag, data: safeJson(a.data, 1024) } }
      };
      const vib = cleanPattern(a.vibrate); if (vib.length) opts.vibrate = vib;
      const acts = (Array.isArray(a.actions) ? a.actions : []).slice(0, 2).map(x => ({ action: tagClean(x && x.action), title: clip(x && x.title, 30) })).filter(x => x.action && x.title);
      if (acts.length) opts.actions = acts;
      const reg = (typeof swReady === 'function') ? await swReady() : null;
      try {
        if (reg && reg.showNotification) await reg.showNotification(title, opts); else new Notification(title, opts);
      } catch (_) {   // Safari/iOS rechazan opciones que no soportan: se reintenta con lo mínimo
        try {
          const min = { body: opts.body, tag: opts.tag, icon: opts.icon, data: opts.data };
          if (reg && reg.showNotification) await reg.showNotification(title, min); else new Notification(title, min);
        } catch (e2) { return false; }
      }
      return true;
    },
    async closeNotifications(ctx, a) {
      const reg = (typeof swReady === 'function') ? await swReady() : null; if (!reg || !reg.getNotifications) return false;
      const prefix = 'game-' + tagClean(game().id) + '-' + (a.tag ? tagClean(a.tag) : '');
      (await reg.getNotifications()).filter(n => (n.tag || '').startsWith(prefix)).forEach(n => n.close()); return true;
    },
    async badge(ctx, a) {
      try {
        const n = Math.round(num(a.count, 0, 0, 99999));
        if (n > 0 && navigator.setAppBadge) { await navigator.setAppBadge(n); return true; }
        if (n === 0 && navigator.clearAppBadge) { await navigator.clearAppBadge(); return true; }
      } catch (_) {}
      return false;
    },

    async wake(ctx, a, o) {
      if (a.on === false) { o.wantWake = false; await releaseWake(o); return true; }
      if (!('wakeLock' in navigator)) return false;
      o.wantWake = true; await acquireWake(o); return !!o.wake;
    },

    async share(ctx, a) {
      if (!navigator.share) return 'unsupported';
      const data = { title: clip(a.title, 120), text: clip(a.text, 500) };
      if (a.url) { try { const u = new URL(String(a.url), location.origin); if (/^https?:$/.test(u.protocol)) data.url = u.href; } catch (_) {} }
      try { await withGesture(t('g_share'), () => navigator.share(data)); return 'shared'; }
      catch (e) { return e && e.name === 'AbortError' ? 'cancelled' : 'error'; }
    },
    async copy(ctx, a) {
      const text = clip(a.text, 20000);
      try { await withGesture(t('g_copy'), () => navigator.clipboard.writeText(text)); return true; }
      catch (_) {
        try { const ta = el('textarea', 'position:fixed;left:-999px;opacity:0'); ta.value = text; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return !!ok; } catch (_e) { return false; }
      }
    },
    async paste() {
      if (!(navigator.clipboard && navigator.clipboard.readText)) return null;
      if (!(await consent('clipboard'))) return null;
      try { return clip(await withGesture(t('g_paste'), () => navigator.clipboard.readText()), 20000); } catch (_) { return null; }
    },

    async fullscreen(ctx, a) {
      const de = document.documentElement;
      try {
        if (a.on === false) { if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen(); return true; }
        const req = de.requestFullscreen || de.webkitRequestFullscreen; if (!req) return false;
        await withGesture(t('g_full'), () => req.call(de)); return true;
      } catch (_) { return false; }
    },
    async orientation(ctx, a) {
      const mode = String(a.mode || 'any').toLowerCase();
      const map = { any: null, unlock: null, landscape: 'landscape', portrait: 'portrait', natural: 'natural' };
      if (!(mode in map)) return false;
      const so = screen.orientation; if (!so) return false;
      try {
        if (map[mode] === null) { so.unlock && so.unlock(); return true; }
        if (!so.lock) return false;
        try { await so.lock(map[mode]); return true; }
        catch (e) {   // Chrome en Android solo deja bloquear estando en pantalla completa
          if (document.fullscreenElement || !document.documentElement.requestFullscreen) return false;
          await withGesture(t('g_orient'), () => document.documentElement.requestFullscreen());
          await so.lock(map[mode]); return true;
        }
      } catch (_) { return false; }
    },

    async location(ctx, a) {
      if (!navigator.geolocation) return null;
      if (!(await consent('location'))) return null;
      return new Promise(res => navigator.geolocation.getCurrentPosition(p => res(posObj(p)), () => res(null),
        { enableHighAccuracy: !!a.high, timeout: 10000, maximumAge: num(a.maxAge, 30000, 0, 600000) }));
    },
    async battery() {
      if (!navigator.getBattery) return null;
      try { const b = await navigator.getBattery(); return battObj(b); } catch (_) { return null; }
    },
    async network() { return netObj(); },

    async speak(ctx, a, o) {
      if (!window.speechSynthesis) return false;
      if (!rate(o, 'speak', 10, 10000)) return false;
      try {
        const u = new SpeechSynthesisUtterance(clip(a.text, 400));
        u.lang = clip(a.lang, 12) || document.documentElement.lang || navigator.language || 'es';
        u.rate = num(a.rate, 1, 0.5, 2); u.pitch = num(a.pitch, 1, 0.5, 2); u.volume = num(a.volume, 1, 0, 1);
        speechSynthesis.speak(u); o.spoke = true; return true;
      } catch (_) { return false; }
    },
    async speakStop(ctx, a, o) { try { speechSynthesis.cancel(); } catch (_) {} return true; },
    async listen(ctx, a) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return null;
      if (!(await consent('microphone'))) return null;
      return withGesture(t('g_listen'), () => new Promise(res => {
        const r = new SR(); r.lang = clip(a.lang, 12) || document.documentElement.lang || navigator.language || 'es'; r.interimResults = false; r.maxAlternatives = 1;
        let fin = false; const end = v => { if (fin) return; fin = true; clearTimeout(tm); try { r.stop(); } catch (_) {} res(v); };
        const tm = setTimeout(() => end(null), 12000);
        r.onresult = e => end(clip(e.results[0][0].transcript, 400)); r.onerror = () => end(null); r.onend = () => end(null);
        r.start();
      })).catch(() => null);
    },

    async install() {
      if (standalone()) return 'installed';
      if (installEvent) {
        const ev = installEvent; installEvent = null;
        try { await withGesture(t('g_install'), () => ev.prompt()); const c = await ev.userChoice; return c && c.outcome === 'accepted' ? 'accepted' : 'dismissed'; } catch (_) { return 'unavailable'; }
      }
      if (IS_IOS) { toast(t('iosInstall'), 6000); return 'ios-manual'; }
      return 'unavailable';
    },
    async saveFile(ctx, a) {
      const name = clip(a.name || 'crix.txt', 80).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'crix.txt';
      const content = String(a.content === undefined ? '' : a.content); if (content.length > 2000000) throw new Error('Archivo demasiado grande (máx. 2 MB)');
      const mime = /^[\w.+-]+\/[\w.+-]+$/.test(String(a.mime || '')) && !/html|javascript|xml/i.test(String(a.mime)) ? String(a.mime) : 'text/plain';
      try {
        await withGesture(t('g_save'), async () => {
          const url = URL.createObjectURL(new Blob([content], { type: mime + ';charset=utf-8' }));
          const link = el('a'); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 8000);
        }); return true;
      } catch (_) { return false; }
    },
    async permission(ctx, a) {
      const name = String(a.name || ''); if (!['notifications', 'geolocation', 'microphone', 'camera', 'clipboard-read', 'clipboard-write', 'persistent-storage'].includes(name)) return 'unknown';
      if (name === 'notifications' && 'Notification' in window) return Notification.permission === 'default' ? 'prompt' : Notification.permission;
      try { return (await navigator.permissions.query({ name })).state; } catch (_) { return 'unknown'; }
    },

    async subscribe(ctx, a, o) { return subscribe(o, String(a.name || '')); },
    async unsubscribe(ctx, a, o) { return unsubscribe(o, String(a.name || '')); }
  };

  // ───────────────────────── Pantalla encendida ─────────────────────────
  async function acquireWake(o) {
    if (o.wake || !o.wantWake || document.visibilityState !== 'visible') return;
    try { o.wake = await navigator.wakeLock.request('screen'); o.wake.addEventListener('release', () => { o.wake = null; }); } catch (_) { o.wake = null; }
  }
  async function releaseWake(o) { try { if (o.wake) await o.wake.release(); } catch (_) {} o.wake = null; }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') owners.forEach(o => { if (o.wantWake) acquireWake(o); }); });

  // ───────────────────────── Eventos hacia los scripts ─────────────────────────
  function posObj(p) {
    const c = p.coords;
    return { lat: round(c.latitude, 1e6), lng: round(c.longitude, 1e6), accuracy: round(c.accuracy, 10), altitude: round(c.altitude, 10), speed: round(c.speed, 100), heading: round(c.heading, 10), timestamp: p.timestamp };
  }
  function battObj(b) { return { level: round(b.level, 100), charging: !!b.charging, chargingTime: Number.isFinite(b.chargingTime) ? b.chargingTime : null, dischargingTime: Number.isFinite(b.dischargingTime) ? b.dischargingTime : null }; }
  function netObj() {
    const c = navigator.connection || {};
    return { online: navigator.onLine !== false, type: c.effectiveType || null, downlink: c.downlink || null, rtt: c.rtt || null, saveData: !!c.saveData };
  }
  async function sensorPermission(kind) {
    if (!(await consent('sensors'))) throw new Error('Sensores no permitidos');
    const E = kind === 'motion' ? window.DeviceMotionEvent : window.DeviceOrientationEvent;
    if (E && typeof E.requestPermission === 'function') {
      const r = await withGesture(t('g_sensors'), () => E.requestPermission());
      if (r !== 'granted') throw new Error('Permiso de sensores denegado');
    }
  }
  function throttled(fn, ms) { let last = 0; return e => { const n = performance.now(); if (n - last < ms) return; last = n; fn(e); }; }
  const SUBS = {
    async orientation(o) {
      if (!('DeviceOrientationEvent' in window)) throw new Error('Este dispositivo no tiene sensor de orientación');
      await sensorPermission('orientation');
      const h = throttled(e => o.ctx.emit('orientation', { alpha: round(e.alpha, 10), beta: round(e.beta, 10), gamma: round(e.gamma, 10), absolute: !!e.absolute }), 33);
      window.addEventListener('deviceorientation', h); return () => window.removeEventListener('deviceorientation', h);
    },
    async motion(o) {
      if (!('DeviceMotionEvent' in window)) throw new Error('Este dispositivo no tiene sensor de movimiento');
      await sensorPermission('motion');
      const v = x => x ? { x: round(x.x, 100), y: round(x.y, 100), z: round(x.z, 100) } : null;
      const h = throttled(e => o.ctx.emit('motion', { acceleration: v(e.acceleration), accelerationIncludingGravity: v(e.accelerationIncludingGravity), rotationRate: e.rotationRate ? { alpha: round(e.rotationRate.alpha, 10), beta: round(e.rotationRate.beta, 10), gamma: round(e.rotationRate.gamma, 10) } : null, interval: e.interval }), 33);
      window.addEventListener('devicemotion', h); return () => window.removeEventListener('devicemotion', h);
    },
    async shake(o) {
      if (!('DeviceMotionEvent' in window)) throw new Error('Este dispositivo no tiene sensor de movimiento');
      await sensorPermission('motion');
      let last = 0;
      const h = e => {
        const a = e.accelerationIncludingGravity || e.acceleration; if (!a) return;
        const m = Math.hypot(a.x || 0, a.y || 0, a.z || 0) - (e.acceleration ? 0 : 9.8);
        const now = Date.now(); if (Math.abs(m) > 14 && now - last > 900) { last = now; o.ctx.emit('shake', { force: round(Math.abs(m), 10) }); }
      };
      window.addEventListener('devicemotion', h); return () => window.removeEventListener('devicemotion', h);
    },
    async location(o) {
      if (!navigator.geolocation) throw new Error('Este dispositivo no tiene ubicación');
      if (!(await consent('location'))) throw new Error('Ubicación no permitida');
      const id = navigator.geolocation.watchPosition(p => o.ctx.emit('location', posObj(p)), () => {}, { enableHighAccuracy: false, maximumAge: 10000, timeout: 20000 });
      return () => navigator.geolocation.clearWatch(id);
    },
    async online(o) { const h = () => o.ctx.emit('online', netObj()); window.addEventListener('online', h); return () => window.removeEventListener('online', h); },
    async offline(o) { const h = () => o.ctx.emit('offline', netObj()); window.addEventListener('offline', h); return () => window.removeEventListener('offline', h); },
    async network(o) {
      const c = navigator.connection; if (!c || !c.addEventListener) throw new Error('Este navegador no informa el tipo de red');
      const h = () => o.ctx.emit('network', netObj()); c.addEventListener('change', h); return () => c.removeEventListener('change', h);
    },
    async visibility(o) { const h = () => o.ctx.emit('visibility', { visible: document.visibilityState === 'visible' }); document.addEventListener('visibilitychange', h); return () => document.removeEventListener('visibilitychange', h); },
    async battery(o) {
      if (!navigator.getBattery) throw new Error('Este navegador no informa la batería');
      const b = await navigator.getBattery(), h = () => o.ctx.emit('battery', battObj(b));
      ['levelchange', 'chargingchange'].forEach(n => b.addEventListener(n, h)); return () => ['levelchange', 'chargingchange'].forEach(n => b.removeEventListener(n, h));
    },
    async gamepad(o) {
      const c = e => o.ctx.emit('gamepad', { connected: true, index: e.gamepad.index, id: clip(e.gamepad.id, 80) });
      const d = e => o.ctx.emit('gamepad', { connected: false, index: e.gamepad.index, id: clip(e.gamepad.id, 80) });
      window.addEventListener('gamepadconnected', c); window.addEventListener('gamepaddisconnected', d);
      return () => { window.removeEventListener('gamepadconnected', c); window.removeEventListener('gamepaddisconnected', d); };
    },
    async install(o) {
      const a = () => o.ctx.emit('install', { available: true }), b = () => o.ctx.emit('install', { installed: true });
      window.addEventListener('beforeinstallprompt', a); window.addEventListener('appinstalled', b);
      return () => { window.removeEventListener('beforeinstallprompt', a); window.removeEventListener('appinstalled', b); };
    },
    async screen(o) {
      const so = screen.orientation; if (!so || !so.addEventListener) throw new Error('Este navegador no informa la orientación de pantalla');
      const h = () => o.ctx.emit('screen', { type: so.type, angle: so.angle }); so.addEventListener('change', h); return () => so.removeEventListener('change', h);
    },
    async fullscreen(o) { const h = () => o.ctx.emit('fullscreen', { on: !!document.fullscreenElement }); document.addEventListener('fullscreenchange', h); return () => document.removeEventListener('fullscreenchange', h); },
    async notificationclick(o) {
      const p = pendingClick; pendingClick = null;
      if (p && Date.now() - p.at < 60000) setTimeout(() => o.ctx.emit('notificationclick', p.data), 0);
      return () => {};
    }
  };
  async function subscribe(o, name) {
    if (!SUBS[name]) throw new Error('Evento de dispositivo desconocido: ' + name);
    if (o.subs.has(name)) return true;
    if (o.subs.size >= 12) throw new Error('Demasiadas suscripciones');
    const placeholder = () => {}; o.subs.set(name, placeholder);   // evita doble suscripción mientras se piden permisos
    try { o.subs.set(name, await SUBS[name](o)); return true; }
    catch (e) { o.subs.delete(name); throw e; }
  }
  function unsubscribe(o, name) { const stop = o.subs.get(name); if (stop) { try { stop(); } catch (_) {} o.subs.delete(name); } return true; }

  // Toque en una notificación de un juego (lo manda el service worker).
  let pendingClick = null;
  function notifClick(m) {
    const s = m && m.script; if (!s || String(s.game) !== game().id) return;
    const data = { tag: String(s.tag || ''), action: String(m.action || ''), data: s.data === undefined ? null : s.data };
    let delivered = false;
    owners.forEach(o => { if (o.subs.has('notificationclick')) { try { o.ctx.emit('notificationclick', data); delivered = true; } catch (_) {} } });
    if (!delivered) pendingClick = { at: Date.now(), data };
  }

  // ───────────────────────── API pública ─────────────────────────
  async function exec(ctx, op, args) {
    const fn = OPS[op]; if (!fn || op === 'constructor') throw new Error('Operación de dispositivo desconocida: ' + op);
    args = (args && typeof args === 'object') ? args : {};
    const o = owner(ctx);
    if (op === 'dialog') return await fn(ctx, args, o);   // espera a la persona, sin límite de tiempo
    return await Promise.race([fn(ctx, args, o), sleep(75000).then(() => { throw new Error('La operación tardó demasiado'); })]);
  }
  function release(id) {
    const o = owners.get(id); if (!o) return; owners.delete(id);
    o.subs.forEach(stop => { try { stop(); } catch (_) {} }); o.subs.clear();
    o.wantWake = false; releaseWake(o);
    if (o.vib) { try { navigator.vibrate && navigator.vibrate(0); } catch (_) {} }
    if (o.spoke) { try { speechSynthesis.cancel(); } catch (_) {} }
  }
  function resetConsent() {
    consentMem.clear();
    try { Object.keys(localStorage).filter(k => k.indexOf('crix:nc:') === 0).forEach(k => localStorage.removeItem(k)); } catch (_) {}
  }

  window.CrixNative = { exec, release, snapshot: () => ({ caps: capabilities(), info: info() }), capabilities, info, notifClick, resetConsent, ops: Object.keys(OPS) };
})();
