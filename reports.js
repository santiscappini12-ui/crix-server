'use strict';
// Denuncias de contenido: cualquier cuenta denuncia; solo un admin las revisa.
// "Ocultar" no borra nada: marca modHidden y el contenido queda visible solo para su autor y los admins.
const crypto = require('crypto');
const { sendReportMail, configured: mailConfigured } = require('./report-mail');

const TYPES = ['map', 'video', 'post', 'user', 'accessory'];
// Solo se puede denunciar lo ilegal (y el abuso de los servidores). No existen motivos de contenido legal.
const REASONS = ['ilegal', 'menores', 'violencia', 'estafa', 'copyright', 'servidor'];
const REASON_TEXT = { ilegal:'Contenido ilegal', menores:'Pone en riesgo a menores', violencia:'Amenazas', estafa:'Estafa o robo de contraseñas', copyright:'Copia sin permiso', servidor:'Ataca o explota los servidores a propósito' };
const TYPE_TEXT = { map:'Juego/app', video:'Video', post:'Post', user:'Usuario', accessory:'Accesorio' };
const MAX_OPEN_PER_USER = 20;
// Evidencia (captura o video) que se adjunta al mail. El cliente la manda en base64.
const EVIDENCE_MAX_BYTES = 20 * 1048576;
const EVIDENCE_TYPES = { 'image/png':'png', 'image/jpeg':'jpg', 'image/webp':'webp', 'image/gif':'gif', 'video/mp4':'mp4', 'video/webm':'webm', 'video/quicktime':'mov' };

module.exports = function setupReports(app, { getDB, saveDB, requireAuth, requireAdmin, onVisibility }) {
  const all = () => { const DB = getDB(); return DB.reports || (DB.reports = {}); };
  function target(type, id) {
    const DB = getDB();
    if (type === 'accessory') return DB.accessories && Object.prototype.hasOwnProperty.call(DB.accessories, id) ? DB.accessories[id] : null;
    if (type === 'map') return Object.prototype.hasOwnProperty.call(DB.maps, id) ? DB.maps[id] : null;
    if (type === 'user') return Object.prototype.hasOwnProperty.call(DB.users, id) ? DB.users[id] : null;
    return (DB[type + 's'] || []).find(x => x.id === id) || null;
  }
  const label = (type, t) => String((type === 'user' ? t.username : t.name || t.title || t.text) || '(sin título)').slice(0, 120);

  app.post('/api/reports', requireAuth, (req, res) => {
    const type = String(req.body?.type || ''), id = String(req.body?.id || ''), reason = String(req.body?.reason || '');
    if (!TYPES.includes(type) || !REASONS.includes(reason)) return res.status(400).json({ ok:false, err:'Denuncia inválida' });
    const t = target(type, id);
    if (!t) return res.status(404).json({ ok:false, err:'Eso ya no existe' });
    const authorId = type === 'user' ? id : t.authorId;
    if (authorId === req.user.id) return res.status(400).json({ ok:false, err:'No podés denunciar lo tuyo' });
    const open = Object.values(all()).filter(r => r.status === 'open' && r.reporterId === req.user.id);
    if (open.some(r => r.type === type && r.targetId === id)) return res.json({ ok:true, repeated:true });
    if (open.length >= MAX_OPEN_PER_USER) return res.status(429).json({ ok:false, err:'Tenés demasiadas denuncias sin revisar' });
    // Evidencia opcional: { name, mime, data(base64) }
    let evidence = null;
    const ev = req.body?.evidence;
    if (ev) {
      const mime = String(ev.mime || '').toLowerCase(), data = String(ev.data || '');
      if (!EVIDENCE_TYPES[mime]) return res.status(400).json({ ok:false, err:'El adjunto tiene que ser una captura (png, jpg, webp, gif) o un video (mp4, webm, mov)' });
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > Math.ceil(EVIDENCE_MAX_BYTES * 4 / 3) + 8) return res.status(400).json({ ok:false, err:'El adjunto es inválido o pesa más de 20 MB' });
      evidence = { mime, ext:EVIDENCE_TYPES[mime], data, size:Math.floor(data.length * 3 / 4) };
    }
    const rid = 'rep_' + crypto.randomUUID();
    all()[rid] = { id:rid, type, targetId:id, authorId, label:label(type, t), reason,
      detail:String(req.body?.detail || '').slice(0, 500), reporterId:req.user.id, reporterName:req.user.username,
      status:'open', created:new Date().toISOString(),
      evidence: evidence ? { mime:evidence.mime, size:evidence.size } : undefined, emailed:false };
    saveDB();
    console.log(`[DENUNCIA] ${type} ${id} · ${reason}${evidence ? ' · con adjunto' : ''}`);
    res.json({ ok:true });
    mailReport(all()[rid], evidence);
  });

  // Manda la denuncia a crix.support@gmail.com. Si falla, la denuncia sigue en el panel de admin.
  async function mailReport(r, evidence) {
    if (!mailConfigured()) { console.warn('[DENUNCIA] CRIX_RESEND_KEY sin configurar: no se mandó el mail de ' + r.id); return; }
    const base = String(process.env.CRIX_PUBLIC_URL || '').trim().replace(/\/+$/, '');
    const link = base && (r.type === 'map' ? `${base}/juego/${encodeURIComponent(r.targetId)}` : '');
    const text = [
      `Denuncia de ${TYPE_TEXT[r.type]}: ${r.label}`,
      `Motivo: ${REASON_TEXT[r.reason]}`,
      r.detail ? `Detalle: ${r.detail}` : '',
      '',
      `ID del contenido: ${r.targetId}` + (link ? `\nEnlace: ${link}` : ''),
      `Autor (ID): ${r.authorId}`,
      `Denunciante: ${r.reporterName} (${r.reporterId})`,
      `Fecha: ${r.created}`,
      `ID de denuncia: ${r.id}`,
      evidence ? `Adjunto: ${evidence.mime}, ${(evidence.size / 1048576).toFixed(1)} MB` : 'Sin captura ni video adjunto.',
    ].filter(x => x !== '').join('\n');
    try {
      await sendReportMail({
        subject: `[Crix] Denuncia: ${REASON_TEXT[r.reason]} · ${TYPE_TEXT[r.type]} «${r.label}»`.slice(0, 200),
        text,
        attachments: evidence ? [{ filename:`evidencia-${r.id}.${evidence.ext}`, content:evidence.data }] : [],
      });
      r.emailed = true; saveDB();
    } catch (e) { console.error('[DENUNCIA] no se pudo mandar el mail de ' + r.id + ': ' + e.message); }
  }

  app.get('/api/admin/reports', requireAuth, requireAdmin, (req, res) => {
    const list = Object.values(all())
      .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || String(b.created).localeCompare(String(a.created)))
      .slice(0, 200)
      .map(r => { const t = target(r.type, r.targetId); return { ...r, exists:!!t, hidden:!!t?.modHidden }; });
    res.json({ ok:true, reports:list });
  });

  // action: hide (ocultar) · restore (volver a mostrar) · dismiss (descartar)
  app.post('/api/admin/reports/:rid', requireAuth, requireAdmin, (req, res) => {
    const r = Object.prototype.hasOwnProperty.call(all(), req.params.rid) ? all()[req.params.rid] : null;
    const action = String(req.body?.action || '');
    if (!r) return res.status(404).json({ ok:false, err:'Denuncia no encontrada' });
    if (!['hide', 'restore', 'dismiss'].includes(action)) return res.status(400).json({ ok:false, err:'Acción inválida' });
    if (action !== 'dismiss') {
      const t = target(r.type, r.targetId);
      if (!t || r.type === 'user') return res.status(400).json({ ok:false, err:'No se puede ocultar' });
      if (action === 'hide') t.modHidden = true; else delete t.modHidden;
      onVisibility(r.type, r.targetId, action === 'hide');
    }
    const status = { hide:'hidden', restore:'dismissed', dismiss:'dismissed' }[action];
    for (const o of Object.values(all()))
      if (o.id === r.id || (action !== 'dismiss' && o.type === r.type && o.targetId === r.targetId)) Object.assign(o, { status, reviewedBy:req.user.id, reviewedAt:new Date().toISOString() });
    saveDB();
    res.json({ ok:true });
  });
};
