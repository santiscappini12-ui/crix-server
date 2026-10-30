// Notificaciones push (Web Push + VAPID) para la PWA de Crix.
// Permiten avisar de mensajes, llamadas y solicitudes aunque la app esté cerrada o en segundo plano.
//
// Claves VAPID: se pueden fijar con CRIX_VAPID_PUBLIC_KEY / CRIX_VAPID_PRIVATE_KEY / CRIX_VAPID_SUBJECT.
// Si no están definidas, se generan una sola vez y se guardan en la base (DB.pushKeys), que ya se respalda
// en el bucket S3 si está configurado. Si se pierden las claves, los dispositivos tienen que volver a suscribirse.
const webpush = require('web-push');

const MAX_SUBS_PER_USER = 10;

module.exports = function createPush({ getDB, saveDB }) {
  let ready = false;
  let publicKey = '', privateKey = '', lastError = null;

  function init() {
    const DB = getDB();
    DB.push = DB.push && typeof DB.push === 'object' ? DB.push : {};
    let pub = process.env.CRIX_VAPID_PUBLIC_KEY || '';
    let priv = process.env.CRIX_VAPID_PRIVATE_KEY || '';
    if (!pub || !priv) {
      if (!DB.pushKeys || !DB.pushKeys.publicKey || !DB.pushKeys.privateKey) {
        DB.pushKeys = webpush.generateVAPIDKeys();
        saveDB();
        console.log('[PUSH] Claves VAPID generadas y guardadas en la base.');
      }
      pub = DB.pushKeys.publicKey; priv = DB.pushKeys.privateKey;
    }
    publicKey = pub; privateKey = priv;
    // Apple (iPhone/iPad) rechaza claves VAPID con un contacto falso. Se usa CRIX_VAPID_SUBJECT si existe; si no,
    // la dirección https del propio sitio, que se aprende en la primera suscripción y se guarda.
    const subject = process.env.CRIX_VAPID_SUBJECT || DB.pushSubject || 'mailto:admin@crix.local';
    try {
      webpush.setVapidDetails(subject, pub, priv);
      ready = true;
    } catch (err) {
      console.error('[PUSH] Claves VAPID inválidas, las notificaciones push quedan desactivadas:', err.message);
    }
  }

  function setSubject(origin) {
    if (!ready || process.env.CRIX_VAPID_SUBJECT) return;
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin || '') || /localhost|127\.0\.0\.1/i.test(origin)) return;
    const DB = getDB();
    if (DB.pushSubject === origin) return;
    try { webpush.setVapidDetails(origin, publicKey, privateKey); DB.pushSubject = origin; saveDB(); console.log('[PUSH] Contacto VAPID:', origin); } catch {}
  }
  function list(userId) {
    const DB = getDB();
    return Array.isArray(DB.push?.[userId]) ? DB.push[userId] : [];
  }
  function has(userId) { return ready && list(userId).length > 0; }

  function validSubscription(sub) {
    return !!sub && typeof sub === 'object' &&
      typeof sub.endpoint === 'string' && /^https:\/\//i.test(sub.endpoint) && sub.endpoint.length <= 1000 &&
      sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string' &&
      sub.keys.p256dh.length <= 200 && sub.keys.auth.length <= 100;
  }

  function subscribe(userId, sub, userAgent) {
    if (!ready) return { ok:false, err:'Las notificaciones push no están disponibles en este servidor' };
    if (!validSubscription(sub)) return { ok:false, err:'Suscripción inválida' };
    const DB = getDB();
    // Un mismo dispositivo no puede quedar suscrito a dos cuentas: se quita de las demás.
    for (const [uid, subs] of Object.entries(DB.push)) {
      if (uid === userId) continue;
      const kept = subs.filter(s => s.endpoint !== sub.endpoint);
      if (kept.length !== subs.length) { if (kept.length) DB.push[uid] = kept; else delete DB.push[uid]; }
    }
    const mine = list(userId).filter(s => s.endpoint !== sub.endpoint);
    mine.push({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      ua: String(userAgent || '').slice(0, 160),
      at: Date.now()
    });
    DB.push[userId] = mine.slice(-MAX_SUBS_PER_USER);
    saveDB();
    return { ok:true };
  }

  function unsubscribe(userId, endpoint) {
    const DB = getDB();
    const mine = list(userId);
    const kept = endpoint ? mine.filter(s => s.endpoint !== endpoint) : [];
    if (kept.length === mine.length) return;
    if (kept.length) DB.push[userId] = kept; else delete DB.push[userId];
    saveDB();
  }

  // Envía una notificación a todos los dispositivos de una cuenta. Nunca lanza errores.
  async function send(userId, payload, options = {}) {
    if (!ready) return 0;
    const skip = options.excludeEndpoints;
    const subs = list(userId).filter(sub => !(skip && skip.has(sub.endpoint)));
    if (!subs.length) return 0;
    const body = JSON.stringify(payload);
    const opts = { TTL: options.ttl ?? 60 * 60, urgency: options.urgency || 'normal' };
    if (options.topic) opts.topic = String(options.topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined;
    let sent = 0;
    await Promise.all(subs.map(async sub => {
      try {
        await webpush.sendNotification(sub, body, opts);
        sent++; lastError = null;
      } catch (err) {
        lastError = { code: err && err.statusCode || 0, body: String(err && (err.body || err.message) || '').slice(0, 200), host: (() => { try { return new URL(sub.endpoint).host; } catch { return ''; } })(), at: Date.now() };
        // 404/410: la suscripción ya no existe (se desinstaló la app o se revocó el permiso).
        if (err && (err.statusCode === 404 || err.statusCode === 410)) unsubscribe(userId, sub.endpoint);
        else console.warn('[PUSH] No se pudo enviar:', err && (err.statusCode || err.message), err && err.body ? String(err.body).slice(0, 200) : '');
      }
    }));
    return sent;
  }

  return { init, get publicKey() { return publicKey; }, get ready() { return ready; }, has, subscribe, unsubscribe, send, setSubject, get lastError() { return lastError; } };
};
