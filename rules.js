'use strict';
// Reglas de uso: hay que aceptarlas para registrarse y para publicar. Si cambia el texto, subí RULES_VERSION.
const RULES_VERSION = 1;
const PUBLISH = {
  post: ['/api/maps', '/api/maps/:id/textures', '/api/maps/:id/comments', '/api/videos', '/api/videos/:id/finish',
    '/api/videos/:id/comment', '/api/posts', '/api/posts/:id/reply', '/api/accessories', '/api/convs/:convId'],
  put: ['/api/maps/:id/sounds/:sid', '/api/videos/:id/file', '/api/videos/:id/chunk'],
};

module.exports = function setupRules(app, { readSession, requireAuth, saveDB }) {
  app.post('/api/register', (req, res, next) => {
    if (req.body?.acceptRules !== RULES_VERSION) return res.status(400).json({ ok:false, code:'RULES_REQUIRED', err:'Tenés que aceptar las reglas de uso de Crix' });
    next();
  });
  const gate = (req, res, next) => {
    const user = readSession(req);
    if (user && user.rulesAccepted !== RULES_VERSION) return res.status(403).json({ ok:false, code:'RULES_REQUIRED', err:'Para publicar tenés que aceptar las reglas de uso' });
    next();   // sin sesión: lo rechaza la propia ruta
  };
  for (const [method, paths] of Object.entries(PUBLISH)) for (const p of paths) app[method](p, gate);

  app.post('/api/rules/accept', requireAuth, (req, res) => {
    if (req.body?.version !== RULES_VERSION) return res.status(400).json({ ok:false, err:'Recargá la página para ver las reglas actuales' });
    req.user.rulesAccepted = RULES_VERSION;
    req.user.rulesAcceptedAt = new Date().toISOString();
    saveDB();
    res.json({ ok:true });
  });
};
module.exports.RULES_VERSION = RULES_VERSION;
