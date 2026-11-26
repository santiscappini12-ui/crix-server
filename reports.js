'use strict';
// Denuncias de contenido: cualquier cuenta denuncia; solo un admin las revisa.
// "Ocultar" no borra nada: marca modHidden y el contenido queda visible solo para su autor y los admins.
const crypto = require('crypto');

const TYPES = ['map', 'video', 'post', 'user'];
const REASONS = ['sexual', 'menores', 'violencia', 'odio', 'estafa', 'copyright', 'spam', 'otro'];
const MAX_OPEN_PER_USER = 20;

module.exports = function setupReports(app, { getDB, saveDB, requireAuth, requireAdmin, onVisibility }) {
  const all = () => { const DB = getDB(); return DB.reports || (DB.reports = {}); };
  function target(type, id) {
    const DB = getDB();
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
    const rid = 'rep_' + crypto.randomUUID();
    all()[rid] = { id:rid, type, targetId:id, authorId, label:label(type, t), reason,
      detail:String(req.body?.detail || '').slice(0, 500), reporterId:req.user.id, reporterName:req.user.username,
      status:'open', created:new Date().toISOString() };
    saveDB();
    console.log(`[DENUNCIA] ${type} ${id} · ${reason}`);
    res.json({ ok:true });
  });

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
