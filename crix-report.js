// Botón de denuncia y lista de denuncias para el admin.
(function () {
  const REASONS = { ilegal:'Contenido ilegal', sexual:'Contenido sexual', menores:'Pone en riesgo a menores', violencia:'Violencia o amenazas', odio:'Odio o acoso', estafa:'Estafa o robo de contraseñas', copyright:'Copia sin permiso', spam:'Spam', otro:'Otro' };
  const TYPES = { map:'Juego/app', video:'Video', post:'Post', user:'Usuario', accessory:'Accesorio' };

  async function call(url, body) {
    try {
      const r = await fetch(url, { method: body ? 'POST' : 'GET', headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + DB.get('token') }, body: body ? JSON.stringify(body) : undefined });
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

  window.crixReport = function (type, id) {
    if (!ME) return showToast('Iniciá sesión para denunciar');
    const el = box('🚩 Denunciar');
    const sel = document.createElement('select'); sel.style.cssText = field;
    for (const [k, v] of Object.entries(REASONS)) sel.add(new Option(v, k));
    const txt = document.createElement('textarea'); txt.style.cssText = field; txt.maxLength = 500; txt.rows = 3; txt.placeholder = 'Contanos qué pasa (opcional)';
    const note = document.createElement('div');
    note.style.cssText = 'font-size:12px;color:var(--text3);margin:2px 0 6px';
    note.textContent = 'Adjuntá una captura o un video que muestre lo ilegal (máx. 20 MB). La denuncia llega a crix.support@gmail.com.';
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
      const r = await call('/api/reports', { type, id, reason:sel.value, detail:txt.value, evidence });
      if (!r.ok) { send.disabled = false; return showToast(r.err || 'No se pudo enviar'); }
      document.getElementById('crix-report-box')?.remove();
      showToast(r.repeated ? 'Ya lo habías denunciado' : 'Denuncia enviada. La va a revisar un admin.');
    });
    el.append(sel, txt, note, file, send, button('Cancelar', 'btn-g', () => document.getElementById('crix-report-box').remove()));
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
      card.textContent = `${state} · ${TYPES[x.type]}: ${x.label}\nMotivo: ${REASONS[x.reason]}${x.evidence ? ' · 📎 con adjunto' : ''}${x.emailed ? ' · ✉️ enviada por mail' : ''}${x.detail ? '\n' + x.detail : ''}\nDenunció: ${x.reporterName} · ID: ${x.targetId}\n`;
      const act = async action => {
        const a = await call('/api/admin/reports/' + encodeURIComponent(x.id), { action });
        if (!a.ok) return showToast(a.err || 'Error');
        crixReportsPanel();
      };
      if (x.exists && x.type !== 'user') card.append(x.hidden ? button('Volver a mostrar', 'btn-g', () => act('restore')) : button('Ocultar', 'btn-red', () => act('hide')));
      if (x.status === 'open') card.append(button('Descartar', 'btn-g', () => act('dismiss')));
      if (x.exists) card.append(button('Banear autor', 'btn-g', () => { document.getElementById('crix-report-box').remove(); banUser(x.authorId); }));
      el.append(card);
    }
    el.append(button('Cerrar', 'btn-g', () => document.getElementById('crix-report-box').remove()));
  };
})();
