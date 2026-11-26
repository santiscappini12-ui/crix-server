// Reglas de uso de Crix: casilla al registrarse y aceptación obligatoria para las cuentas que todavía no las aceptaron.
(function () {
  const VERSION = 1;   // igual que RULES_VERSION en rules.js
  const BANNED = ['Nada ilegal, incluido promoverlo o violar derechos de otros.', 'Contenido sexual con menores o que los ponga en riesgo.',
    'Imágenes íntimas sin consentimiento, reales o falsas.', 'Terrorismo, violencia extrema o contenido que busque causar daño.',
    'Odio, acoso o discriminación.', 'Estafas, engaños dañinos, suplantación o logins falsos.', 'Virus o código malicioso.',
    'Copiar obras o marcas sin permiso.', 'Vender drogas, armas, falsificaciones u otros productos ilegales, o apuestas ilegales.', 'Spam.'];
  const SERVERS = 'Tampoco se permite abusar de los servidores: atacarlos o saturarlos, saltarse límites o seguridad, hacer pruebas de vulnerabilidad sin permiso, minar criptomonedas, usarlos como proxy, VPN o túnel, hacer scraping no autorizado o crear cuentas para evadir sanciones o límites.';
  const END = 'Podemos ocultar o borrar contenido y suspender cuentas que incumplan.';

  function show(mustAccept) {
    document.getElementById('crix-rules-box')?.remove();
    const bg = document.createElement('div');
    bg.id = 'crix-rules-box';
    bg.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:16px';
    bg.innerHTML = '<div style="background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:16px;width:100%;max-width:520px;max-height:85vh;overflow:auto;font-size:14px;line-height:1.5">' +
      '<div style="font-weight:800;font-size:18px">Reglas de uso de Crix</div><p><b>No se permite:</b></p><ol style="padding-left:20px">' +
      BANNED.map(t => '<li>' + t + '</li>').join('') + '</ol><p>' + SERVERS + '</p><p>' + END + '</p></div>';
    const box = bg.firstChild;
    const button = (text, cls, fn) => {
      const b = document.createElement('button');
      b.className = 'btn ' + cls; b.textContent = text; b.style.cssText = 'margin:0 8px 8px 0'; b.onclick = fn;
      box.appendChild(b); return b;
    };
    if (mustAccept) {
      const ok = button('Acepto las reglas', 'btn-p', async () => {
        ok.disabled = true;
        try {
          await apiRequest('/api/rules/accept', { method:'POST', body:{ version:VERSION } });
          ME.rulesAccepted = VERSION; bg.remove();
        } catch (e) { ok.disabled = false; showToast(e.message || 'No se pudo guardar'); }
      });
      button('No acepto (salir)', 'btn-g', () => { bg.remove(); logout(); });
    } else button('Cerrar', 'btn-g', () => bg.remove());
    document.body.appendChild(bg);
  }
  window.crixShowRules = () => show(false);

  // Cubre todas las formas de entrar (contraseña, Google, sesión guardada). Sin conexión no se pide: no se puede publicar.
  setInterval(() => {
    const open = document.getElementById('crix-rules-box');
    if (typeof ME === 'undefined' || !ME || !DB.get('token') || !navigator.onLine) return;
    if (ME.rulesAccepted !== VERSION && !open) show(true);
  }, 1500);
})();
