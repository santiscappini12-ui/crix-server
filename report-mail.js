'use strict';
// Envío de denuncias por mail a crix.support@gmail.com (con la captura o el video adjunto).
// Usa la API HTTP de Resend (https://resend.com) porque Render gratis bloquea SMTP y así no hace falta ninguna dependencia.
// Variables de entorno:
//   CRIX_RESEND_KEY  clave de API de Resend (sin ella las denuncias se guardan igual, pero no se manda el mail)
//   CRIX_MAIL_FROM   remitente, p. ej. "Crix <soporte@tudominio.com>". IMPORTANTE: para mandarle mails a los usuarios (códigos de
//                    verificación y respuestas a denuncias/apelaciones) hace falta un dominio verificado en Resend. El remitente por
//                    defecto onboarding@resend.dev solo puede escribirle a la cuenta dueña de la clave de Resend.
//   CRIX_REPORT_TO   destino (por defecto crix.support@gmail.com)

const TO = () => String(process.env.CRIX_REPORT_TO || 'crix.support@gmail.com').trim();
const FROM = () => String(process.env.CRIX_MAIL_FROM || 'Crix <onboarding@resend.dev>').trim();

function configured() { return !!process.env.CRIX_RESEND_KEY; }

// attachments: [{ filename, content (base64) }]; to: destino (por defecto crix.support@gmail.com)
async function sendReportMail({ subject, text, attachments = [], replyTo, to }) {
  if (!configured()) throw new Error('CRIX_RESEND_KEY sin configurar');
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.CRIX_RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM(), to: [to ? String(to).trim() : TO()], subject, text, attachments, ...(replyTo ? { reply_to: replyTo } : {}) }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('Resend ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 300));
    return true;
  } finally { clearTimeout(timer); }
}

module.exports = { sendReportMail, configured, TO };
