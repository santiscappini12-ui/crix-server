// Botón de denuncia y lista de denuncias para el admin.
(function () {
  // Solo se puede denunciar lo ilegal (y el abuso de los servidores). No existen motivos de contenido legal.
  const REASONS = { ilegal:'Contenido ilegal', menores:'Pone en riesgo a menores', intimas:'Imágenes íntimas sin consentimiento', violencia:'Amenazas', odio:'Odio o acoso', estafa:'Estafa o robo de contraseñas', malware:'Virus o código malicioso', copyright:'Copia sin permiso', servidor:'Ataca o explota los servidores a propósito' };
  const TYPES = { map:'Juego/app', video:'Video', post:'Post', user:'Usuario', accessory:'Accesorio' };

// Animación de "Enviado": se ve UNA vez (el GIF dura ~5 s), dice Enviado y se cierra solo, dejando al usuario donde estaba.
  const SENT_GIF = '/crix-sent.gif', SENT_MS = 4960;
  window.crixSent = function (label, onDone) {
    document.getElementById('crix-sent')?.remove();
    const bg = document.createElement('div');
    bg.id = 'crix-sent';
    bg.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(5,8,18,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;opacity:0;transition:opacity .25s ease';
    const img = document.createElement('img');
    img.alt = ''; img.draggable = false;
    img.style.cssText = 'width:min(260px,64vw);height:auto;display:block;user-select:none;-webkit-user-drag:none';
    img.src = SENT_GIF + '?t=' + Date.now();   // el query fuerza a arrancar desde el primer cuadro
    const t = document.createElement('div');
    t.textContent = label || 'Enviado';
    t.style.cssText = 'font-family:var(--display,inherit);font-size:26px;font-weight:800;color:#fff';
    bg.append(img, t);
    document.body.appendChild(bg);
    requestAnimationFrame(() => { bg.style.opacity = '1'; });
    setTimeout(() => {
      bg.style.opacity = '0';
      setTimeout(() => { bg.remove(); if (onDone) try { onDone(); } catch (_) {} }, 260);
    }, SENT_MS);
  };

  async function call(url, body, noAuth) {
    try {
      const headers = { 'Content-Type':'application/json' };
      if (!noAuth) headers.Authorization = 'Bearer ' + DB.get('token');
      const r = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
      return await r.json();
    } catch (_) { return { ok:false, err:'Sin conexión' }; }
  }
  function box(title) {
    document.getElementById('crix-report-box')?.remove();
    const bg = document.createElement('div');
    bg.id = 'crix-report-box';
    bg.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;padding:16px';
    bg.innerHTML = '<div style="background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:16px;width:100%;max-width:480px;max-height:85vh;overflow:auto"><div style="font-weight:800;font-size:18px;margin-bottom:12px"></div><div></div></div>';
    bg.firstChild.firstChild.textContent = title;
    bg.onclick = e => { if (e.target === bg) bg.remove(); };
    document.body.appendChild(bg);
    return bg.firstChild.lastChild;
  }
  function button(text, cls, fn) {
    const b = document.createElement('button');
    b.className = 'btn ' + cls; b.textContent = text; b.style.cssText = 'font-size:12px;margin:8px 8px 0 0'; b.onclick = fn;
    return b;
  }
  const field = 'width:100%;box-sizing:border-box;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:16px;margin-bottom:8px';

  const EVIDENCE_MAX = 20 * 1048576;
  const toBase64 = file => new Promise((ok, fail) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result).split(',')[1] || '');
    fr.onerror = () => fail(fr.error);
    fr.readAsDataURL(file);
  });

  // Vincula y verifica un mail (código de 6 dígitos). ctx: {} con sesión · { appealToken } o { username, pw } si la cuenta está baneada.
  window.crixLinkEmail = function (ctx, onDone, why) {
    ctx = ctx || {};
    const noAuth = !!(ctx.appealToken || ctx.username);
    const el = box('✉️ Vincular mail');
    const info = document.createElement('div');
    info.style.cssText = 'font-size:13px;color:var(--text2);margin-bottom:8px';
    info.textContent = (why ? why + ' ' : '') + 'Te mandamos un código para confirmar que el mail es tuyo. No lo mostramos a otras personas.';
    const email = document.createElement('input'); email.type = 'email'; email.maxLength = 200; email.placeholder = 'tu@mail.com'; email.autocomplete = 'email'; email.style.cssText = field;
    const code = document.createElement('input'); code.inputMode = 'numeric'; code.maxLength = 6; code.placeholder = 'Código de 6 dígitos'; code.style.cssText = field + ';display:none';
    const msg = document.createElement('div'); msg.style.cssText = 'font-size:12px;color:var(--red);min-height:16px;margin-bottom:4px';
    const body = extra => Object.assign({}, ctx.appealToken ? { appealToken:ctx.appealToken } : ctx.username ? { username:ctx.username, pw:ctx.pw } : {}, extra);
    const send = button('Enviar código', 'btn-p', async () => {
      msg.textContent = ''; send.disabled = true;
      const r = await call('/api/email/request', body({ email:email.value }), noAuth);
      send.disabled = false;
      if (!r.ok) { msg.textContent = r.err || 'No se pudo enviar el código'; return; }
      code.style.display = ''; verify.style.display = ''; send.textContent = 'Reenviar código';
      info.textContent = 'Listo: te mandamos un código a ' + email.value.trim() + '. Revisá también la carpeta de spam.';
    });
    const verify = button('Verificar', 'btn-p', async () => {
      msg.textContent = ''; verify.disabled = true;
      const r = await call('/api/email/verify', body({ code:code.value }), noAuth);
      verify.disabled = false;
      if (!r.ok) { msg.textContent = r.err || 'No se pudo verificar'; return; }
      if (!noAuth && ME) { ME.mail = r.mail; try { saveMe(); } catch (_) {} }
      document.getElementById('crix-report-box')?.remove();
      showToast('✅ Mail verificado');
      if (onDone) onDone(r);
    });
    verify.style.display = 'none';
    el.append(info, email, code, msg, send, verify, button('Cancelar', 'btn-g', () => document.getElementById('crix-report-box').remove()));
  };

  window.crixReport = function (type, id) {
    if (!ME) return showToast('Iniciá sesión para denunciar');
    const el = box('🚩 Denunciar');
    const sel = document.createElement('select'); sel.style.cssText = field;
    for (const [k, v] of Object.entries(REASONS)) sel.add(new Option(v, k));
    const txt = document.createElement('textarea'); txt.style.cssText = field; txt.maxLength = 500; txt.rows = 3; txt.placeholder = 'Contanos qué pasa (opcional). Solo se denuncia lo que rompe las reglas de uso.';
    const contact = document.createElement('input'); contact.type = 'email'; contact.maxLength = 200; contact.autocomplete = 'email'; contact.style.cssText = field;
    contact.placeholder = 'Tu mail para que te contactemos (opcional)'; contact.value = (ME.mail && ME.mail.verified && ME.mail.address) || '';
    const note = document.createElement('div');
    note.style.cssText = 'font-size:12px;color:var(--text3);margin:2px 0 6px';
    note.textContent = 'Adjuntá una captura o un video que muestre el problema (máx. 20 MB). La denuncia llega a crix.support@gmail.com y, si dejás un mail, te contactamos ahí.';
    const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime';
    file.style.cssText = 'width:100%;font-size:13px;margin-bottom:8px;color:var(--text)';
    const send = button('Enviar denuncia', 'btn-red', async () => {
      const f = file.files[0];
      if (f && f.size > EVIDENCE_MAX) return showToast('El archivo pesa más de 20 MB');
      send.disabled = true;
      let evidence;
      if (f) {
        try { evidence = { name:f.name, mime:f.type, data:await toBase64(f) }; }
        catch (_) { send.disabled = false; return showToast('No se pudo leer el archivo'); }
      }
      const r = await call('/api/reports', { type, id, reason:sel.value, detail:txt.value, contact:contact.value.trim(), evidence });
      if (!r.ok) {
        send.disabled = false;
        return showToast(r.err || 'No se pudo enviar');
      }
      document.getElementById('crix-report-box')?.remove();
      if (r.repeated) return showToast('Ya lo habías denunciado');
      crixSent('Enviado');   // la denuncia es un modal: al cerrarse queda la página donde estabas
    });
    el.append(sel, txt, contact, note, file, send, button('Cancelar', 'btn-g', () => document.getElementById('crix-report-box').remove()));
  };

  window.crixReportsPanel = async function () {
    const r = await call('/api/admin/reports');
    if (!r.ok) return showToast(r.err || 'No se pudo cargar');
    const el = box('🚩 Denuncias');
    if (!r.reports.length) el.textContent = 'No hay denuncias.';
    for (const x of r.reports) {
      const card = document.createElement('div');
      card.style.cssText = 'border-top:1px solid var(--border);padding:10px 0;font-size:13px;white-space:pre-wrap;word-break:break-word';
      const state = !x.exists ? 'Borrado' : x.hidden ? 'Oculto' : x.status === 'open' ? 'PENDIENTE' : 'Revisada';
      card.textContent = `${state} · ${TYPES[x.type]}: ${x.label}\nMotivo: ${REASONS[x.reason] || 'Motivo retirado'}${x.evidence ? ' · 📎 con adjunto' : ''}${x.emailed ? ' · ✉️ enviada por mail' : ''}${x.detail ? '\n' + x.detail : ''}\nDenunció: ${x.reporterName} · ID: ${x.targetId}\n`;
      let replyBox = null;
      if (x.status === 'open') {
        replyBox = document.createElement('textarea'); replyBox.style.cssText = field + ';margin-top:8px'; replyBox.rows = 2; replyBox.maxLength = 1000;
        replyBox.placeholder = 'Mensaje para ' + x.reporterName + ' (opcional): le llega por mail con lo que se decidió';
        card.append(replyBox);
      } else if (x.reply) card.append('Respuesta enviada: ' + x.reply + '\n');
      const act = async action => {
        const a = await call('/api/admin/reports/' + encodeURIComponent(x.id), { action, reply: replyBox ? replyBox.value : '' });
        if (!a.ok) return showToast(a.err || 'Error');
        showToast(a.emailed ? '✉️ Respuesta enviada por mail' : a.failed ? '⚠️ Resuelta, pero no se pudo mandar el mail' : 'Resuelta');
        crixReportsPanel();
      };
      if (x.exists && x.type !== 'user') card.append(x.hidden ? button('Volver a mostrar', 'btn-g', () => act('restore')) : button('Ocultar', 'btn-red', () => act('hide')));
      if (x.status === 'open') card.append(button('Descartar', 'btn-g', () => act('dismiss')));
      if (x.exists) card.append(button('Banear autor', 'btn-g', () => { document.getElementById('crix-report-box').remove(); banUser(x.authorId); }));
      el.append(card);
    }
    el.append(button('Cerrar', 'btn-g', () => document.getElementById('crix-report-box').remove()));
  };

  window.crixAppealsPanel = async function () {
    const r = await call('/api/admin/appeals');
    if (!r.ok) return showToast(r.err || 'No se pudo cargar');
    const el = box('📨 Apelaciones');
    if (!r.appeals.length) el.textContent = 'No hay apelaciones.';
    const STATE = { open:'PENDIENTE', accepted:'Aceptada', rejected:'Rechazada' };
    for (const x of r.appeals) {
      const card = document.createElement('div');
      card.style.cssText = 'border-top:1px solid var(--border);padding:10px 0;font-size:13px;white-space:pre-wrap;word-break:break-word';
      card.textContent = `${STATE[x.status] || x.status} · ${x.username}${x.stillBanned ? '' : ' (ya no está baneado)'}\nBan: ${x.ban.reason || 'sin motivo'}${x.ban.permanent ? ' · permanente' : x.ban.until ? ' · hasta ' + new Date(x.ban.until).toLocaleString('es-AR') : ''}\n\n${x.message}\n\nResponder a: ${x.email}${x.emailed ? ' · ✉️ avisada al equipo' : ''}\n`;
      if (x.status === 'open') {
        const reply = document.createElement('textarea'); reply.style.cssText = field + ';margin-top:8px'; reply.rows = 3; reply.maxLength = 2000;
        reply.placeholder = 'Respuesta para ' + x.username + ' (le llega por mail; obligatoria si rechazás)';
        const act = async action => {
          const a = await call('/api/admin/appeals/' + encodeURIComponent(x.id), { action, reply:reply.value });
          if (!a.ok) return showToast(a.err || 'Error');
          showToast(a.emailed ? '✉️ Respuesta enviada por mail' : '⚠️ Resuelta, pero no se pudo mandar el mail');
          crixAppealsPanel();
        };
        card.append(reply, button('Aceptar y desbanear', 'btn-p', () => act('accept')), button('Rechazar', 'btn-red', () => act('reject')));
      } else if (x.reply) card.append('Respuesta: ' + x.reply + '\n');
      el.append(card);
    }
    el.append(button('Cerrar', 'btn-g', () => document.getElementById('crix-report-box').remove()));
  };
})();
