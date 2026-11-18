--- server.js.orig	2026-11-18 19:16:40.863589109 +0000
+++ server.js	2026-11-18 19:16:40.922013187 +0000
@@ -538,6 +538,14 @@
   io.emit('presence_update', { userId, username:user.username, color:user.color, ...presenceInfo(userId) });
 }
 
+// ¿El ban sigue vigente? Un ban con fecha vencida se limpia solo (antes bloqueaba la sesión hasta volver a loguearse).
+function banActive(u) {
+  const b = u && u.banned; if (!b) return false;
+  const until = b.until ? new Date(b.until) : null;
+  if (b.permanent || (until && until > new Date())) return true;
+  delete u.banned; saveDB();
+  return false;
+}
 function safeUser(u) { if (!u) return null; const {pw:_,e2eeVault:__,googleSub:___g,...s}=u; return s; }
 function publicUser(u) {
   if (!u) return null;
@@ -576,7 +584,7 @@
     return null;
   }
   const user = DB.users[session.userId];
-  if (!user || user.banned) return null;
+  if (!user || banActive(user)) return null;
   return user;
 }
 function requireAuth(req, res, next) {
@@ -809,7 +817,7 @@
   const session = DB.sessions[tokenHash(String(token))];
   if (!session || session.expiresAt <= Date.now()) return null;
   const user = DB.users[session.userId];
-  return user && !user.banned ? user : null;
+  return user && !banActive(user) ? user : null;
 }
 
 // Igual que los juegos: un video sin clasificar (cuestionario sin completar) es un borrador que solo ven su autor y los admins.
@@ -827,7 +835,7 @@
   let session = DB.sessions[tokenHash(token)];
   if (!session && persist.enabled) { try { await persist.pullFresh(0, 3000); } catch {} session = DB.sessions[tokenHash(token)]; }
   const user = session && session.expiresAt > Date.now() ? DB.users[session.userId] : null;
-  if (!user || user.banned) return next(new Error('Sesión inválida'));
+  if (!user || banActive(user)) return next(new Error('Sesión inválida'));
   socket.data.user = user;
   next();
 });
@@ -1103,7 +1111,7 @@
   if (h) handoffs.delete(key);   // un solo uso
   if (!h || h.expiresAt <= Date.now()) return res.status(410).json({ ok:false, err:'El enlace venció. Volvé a intentarlo desde la llamada.' });
   const user = DB.users[h.userId];
-  if (!user || user.banned) return res.status(403).json({ ok:false, err:'Cuenta no disponible' });
+  if (!user || banActive(user)) return res.status(403).json({ ok:false, err:'Cuenta no disponible' });
   log('HANDOFF', user.username);
   res.json({ ok:true, user: safeUser(user), token: issueSession(user), peerId: h.peerId });
 });
@@ -1134,7 +1142,11 @@
       else u.look = CrixAvatar.sanitizeLook(req.body.look, {});
     }
     const allowed = ['bio','color','games','visits','following','liked','onlineAt','avatar'];
-    if (actor.isAdmin) allowed.push('banned');
+    // Solo un admin pone/quita bans. Poner: objeto. Quitar: banned:null (o false). Antes un cuerpo SIN 'banned' (lo que mandaba
+    // "Desbanear" tras hacer delete u.banned) se ignoraba, y el ban seguía en el servidor y volvía en la próxima sincronización.
+    let unbanned = false;
+    if (actor.isAdmin && req.body.banned && typeof req.body.banned === 'object') allowed.push('banned');
+    else if (actor.isAdmin && 'banned' in req.body && !req.body.banned && u.banned) { delete u.banned; unbanned = true; }
     allowed.forEach(k => { if (req.body[k] !== undefined) u[k] = req.body[k]; });
     if (actor.isAdmin && req.body.isAdmin !== undefined) {
       u.isAdmin = !!req.body.isAdmin;
@@ -1142,6 +1154,7 @@
     }
     DB.users[req.params.id] = u;
     saveDB();
+    if (unbanned) { log('UNBAN', req.params.id); const t = onlineUsers[req.params.id]; if (t) io.to(t.socketId).emit('you_are_unbanned'); }
     io.emit('user_updated', { userId: req.params.id });
     res.json({ ok:true });
   } catch(e) { res.json({ ok:false, err:e.message }); }
