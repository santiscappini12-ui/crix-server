// Reglas de uso de Crix: casilla al registrarse y aceptación obligatoria para las cuentas que todavía no las aceptaron.
(function () {
  const VERSION = 2;   // igual que RULES_VERSION en rules.js
  // Textos propios por idioma (la ventana lleva .no-i18n para que Crix no la vuelva a traducir).
  const TEXT = {
 "es": {
  "title": "Reglas de uso de Crix",
  "no": "No se permite:",
  "items": [
   "Nada ilegal, incluido promoverlo o violar derechos de otros.",
   "Contenido sexual con menores o que los ponga en riesgo.",
   "Imágenes íntimas sin consentimiento, reales o falsas.",
   "Terrorismo, violencia extrema o contenido que busque causar daño.",
   "Odio o acoso contra personas o grupos por raza, origen, religión, género, orientación sexual, discapacidad, edad u otra característica protegida. El contexto importa: satirizar o criticar el odio para denunciarlo está permitido, incluso usando estereotipos del grupo o chistes ofensivos, siempre que sean parte de la sátira y el blanco sea el agresor; si el blanco es el grupo o una persona, no.",
   "Estafas, engaños dañinos, suplantación o logins falsos.",
   "Virus o código malicioso.",
   "Copiar obras o marcas sin permiso.",
   "Vender drogas, armas, falsificaciones u otros productos ilegales, o apuestas ilegales."
  ],
  "servers": "Tampoco se permite abusar de los servidores: atacarlos o saturarlos, saltarse límites o seguridad, hacer pruebas de vulnerabilidad sin permiso, minar criptomonedas, usarlos como proxy, VPN o túnel, hacer scraping no autorizado o crear cuentas para evadir sanciones o límites.",
  "end": "Podemos ocultar o borrar contenido y suspender cuentas que incumplan.",
  "accept": "Acepto las reglas",
  "leave": "No acepto (salir)",
  "close": "Cerrar",
  "err": "No se pudo guardar"
 },
 "en": {
  "title": "Crix usage rules",
  "no": "Not allowed:",
  "items": [
   "Anything illegal, including promoting it or violating the rights of others.",
   "Sexual content involving minors or content that endangers them.",
   "Intimate images without consent, real or fake.",
   "Terrorism, extreme violence or content meant to cause harm.",
   "Hate or harassment against people or groups based on race, origin, religion, gender, sexual orientation, disability, age or another protected characteristic. Context matters: satirizing or criticizing hate in order to condemn it is allowed, even using stereotypes of the group or offensive jokes, as long as they are part of the satire and the target is the aggressor; if the target is the group or a person, it is not.",
   "Scams, harmful deception, impersonation or fake logins.",
   "Viruses or malicious code.",
   "Copying works or trademarks without permission.",
   "Selling drugs, weapons, counterfeits or other illegal products, or illegal gambling."
  ],
  "servers": "Abusing the servers is not allowed either: attacking or overloading them, bypassing limits or security, testing for vulnerabilities without permission, mining cryptocurrency, using them as a proxy, VPN or tunnel, unauthorized scraping, or creating accounts to evade bans or limits.",
  "end": "We may hide or delete content and suspend accounts that break these rules.",
  "accept": "I accept the rules",
  "leave": "I don't accept (log out)",
  "close": "Close",
  "err": "Could not save"
 },
 "pt": {
  "title": "Regras de uso do Crix",
  "no": "Não é permitido:",
  "items": [
   "Nada ilegal, incluindo promovê-lo ou violar direitos de outras pessoas.",
   "Conteúdo sexual com menores ou que os coloque em risco.",
   "Imagens íntimas sem consentimento, reais ou falsas.",
   "Terrorismo, violência extrema ou conteúdo que busque causar danos.",
   "Ódio ou assédio contra pessoas ou grupos por raça, origem, religião, gênero, orientação sexual, deficiência, idade ou outra característica protegida. O contexto importa: satirizar ou criticar o ódio para condená-lo é permitido, inclusive usando estereótipos do grupo ou piadas ofensivas, desde que façam parte da sátira e o alvo seja o agressor; se o alvo for o grupo ou uma pessoa, não.",
   "Golpes, enganos prejudiciais, falsa identidade ou logins falsos.",
   "Vírus ou código malicioso.",
   "Copiar obras ou marcas sem permissão.",
   "Vender drogas, armas, falsificações ou outros produtos ilegais, ou apostas ilegais."
  ],
  "servers": "Também não é permitido abusar dos servidores: atacá-los ou sobrecarregá-los, contornar limites ou a segurança, testar vulnerabilidades sem permissão, minerar criptomoedas, usá-los como proxy, VPN ou túnel, fazer scraping não autorizado ou criar contas para evitar punições ou limites.",
  "end": "Podemos ocultar ou apagar conteúdo e suspender contas que descumprirem as regras.",
  "accept": "Aceito as regras",
  "leave": "Não aceito (sair)",
  "close": "Fechar",
  "err": "Não foi possível salvar"
 },
 "fr": {
  "title": "Règles d’utilisation de Crix",
  "no": "Il est interdit :",
  "items": [
   "Tout ce qui est illégal, y compris en faire la promotion ou violer les droits d’autrui.",
   "Les contenus sexuels impliquant des mineurs ou les mettant en danger.",
   "Les images intimes sans consentement, réelles ou fausses.",
   "Le terrorisme, la violence extrême ou les contenus visant à nuire.",
   "La haine ou le harcèlement envers des personnes ou des groupes en raison de leur origine, religion, genre, orientation sexuelle, handicap, âge ou autre caractéristique protégée. Le contexte compte : satiriser ou critiquer la haine pour la dénoncer est permis, même en utilisant des stéréotypes sur le groupe ou des blagues offensantes, à condition qu’ils fassent partie de la satire et que la cible soit l’agresseur ; si la cible est le groupe ou une personne, non.",
   "Les arnaques, tromperies nuisibles, usurpations d’identité ou fausses pages de connexion.",
   "Les virus ou codes malveillants.",
   "La copie d’œuvres ou de marques sans autorisation.",
   "La vente de drogues, d’armes, de contrefaçons ou d’autres produits illégaux, et les jeux d’argent illégaux."
  ],
  "servers": "Il est aussi interdit d’abuser des serveurs : les attaquer ou les surcharger, contourner les limites ou la sécurité, tester des vulnérabilités sans autorisation, miner des cryptomonnaies, les utiliser comme proxy, VPN ou tunnel, faire du scraping non autorisé ou créer des comptes pour échapper aux sanctions ou aux limites.",
  "end": "Nous pouvons masquer ou supprimer des contenus et suspendre les comptes en infraction.",
  "accept": "J’accepte les règles",
  "leave": "Je refuse (se déconnecter)",
  "close": "Fermer",
  "err": "Enregistrement impossible"
 },
 "de": {
  "title": "Nutzungsregeln von Crix",
  "no": "Nicht erlaubt:",
  "items": [
   "Alles Illegale, auch dafür zu werben oder die Rechte anderer zu verletzen.",
   "Sexuelle Inhalte mit Minderjährigen oder Inhalte, die sie gefährden.",
   "Intime Bilder ohne Einwilligung, echt oder gefälscht.",
   "Terrorismus, extreme Gewalt oder Inhalte, die Schaden anrichten sollen.",
   "Hass oder Belästigung gegen Personen oder Gruppen wegen ethnischer Herkunft, Religion, Geschlecht, sexueller Orientierung, Behinderung, Alter oder eines anderen geschützten Merkmals. Der Kontext zählt: Hass zu satirisieren oder zu kritisieren, um ihn anzuprangern, ist erlaubt, auch mit Stereotypen über die Gruppe oder anstößigen Witzen, solange sie Teil der Satire sind und der Aggressor das Ziel ist; ist das Ziel die Gruppe oder eine Person, nicht.",
   "Betrug, schädliche Täuschung, Identitätsmissbrauch oder gefälschte Anmeldeseiten.",
   "Viren oder Schadcode.",
   "Werke oder Marken ohne Erlaubnis kopieren.",
   "Verkauf von Drogen, Waffen, Fälschungen oder anderen illegalen Waren sowie illegales Glücksspiel."
  ],
  "servers": "Auch der Missbrauch der Server ist verboten: sie angreifen oder überlasten, Limits oder Sicherheit umgehen, ohne Erlaubnis auf Schwachstellen testen, Kryptowährungen schürfen, sie als Proxy, VPN oder Tunnel nutzen, unerlaubtes Scraping oder Konten erstellen, um Sperren oder Limits zu umgehen.",
  "end": "Wir können Inhalte verbergen oder löschen und Konten sperren, die gegen die Regeln verstoßen.",
  "accept": "Ich akzeptiere die Regeln",
  "leave": "Ablehnen (abmelden)",
  "close": "Schließen",
  "err": "Speichern fehlgeschlagen"
 },
 "it": {
  "title": "Regole d’uso di Crix",
  "no": "Non è consentito:",
  "items": [
   "Nulla di illegale, incluso promuoverlo o violare i diritti altrui.",
   "Contenuti sessuali con minori o che li mettano a rischio.",
   "Immagini intime senza consenso, reali o false.",
   "Terrorismo, violenza estrema o contenuti volti a causare danni.",
   "Odio o molestie contro persone o gruppi per origine, religione, genere, orientamento sessuale, disabilità, età o altra caratteristica protetta. Il contesto conta: satireggiare o criticare l’odio per condannarlo è consentito, anche usando stereotipi sul gruppo o battute offensive, purché facciano parte della satira e il bersaglio sia l’aggressore; se il bersaglio è il gruppo o una persona, no.",
   "Truffe, inganni dannosi, furto d’identità o false pagine di accesso.",
   "Virus o codice dannoso.",
   "Copiare opere o marchi senza permesso.",
   "Vendere droga, armi, merce contraffatta o altri prodotti illegali, o gioco d’azzardo illegale."
  ],
  "servers": "Non è consentito neanche abusare dei server: attaccarli o sovraccaricarli, aggirare limiti o sicurezza, cercare vulnerabilità senza permesso, minare criptovalute, usarli come proxy, VPN o tunnel, fare scraping non autorizzato o creare account per eludere sanzioni o limiti.",
  "end": "Possiamo nascondere o eliminare contenuti e sospendere gli account che violano le regole.",
  "accept": "Accetto le regole",
  "leave": "Non accetto (esci)",
  "close": "Chiudi",
  "err": "Salvataggio non riuscito"
 }
};

  function show(mustAccept) {
    document.getElementById('crix-rules-box')?.remove();
    const L = TEXT[window.__crixLang] || TEXT.es;
    const bg = document.createElement('div');
    bg.className = 'no-i18n';
    bg.id = 'crix-rules-box';
    bg.dataset.lang = String(window.__crixLang);   // para re-renderizar si cambia el idioma con la ventana abierta
    bg.dataset.must = mustAccept ? '1' : '0';
    bg.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:16px';
    bg.innerHTML = '<div style="background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:16px;width:100%;max-width:520px;max-height:85vh;overflow:auto;font-size:14px;line-height:1.5">' +
      '<div style="font-weight:800;font-size:18px">' + L.title + '</div><p><b>' + L.no + '</b></p><ol style="padding-left:20px">' +
      L.items.map(t => '<li>' + t + '</li>').join('') + '</ol><p>' + L.servers + '</p><p>' + L.end + '</p></div>';
    const box = bg.firstChild;
    const button = (text, cls, fn) => {
      const b = document.createElement('button');
      b.className = 'btn ' + cls; b.textContent = text; b.style.cssText = 'margin:0 8px 8px 0'; b.onclick = fn;
      box.appendChild(b); return b;
    };
    if (mustAccept) {
      const ok = button(L.accept, 'btn-p', async () => {
        ok.disabled = true;
        try {
          await apiRequest('/api/rules/accept', { method:'POST', body:{ version:VERSION } });
          ME.rulesAccepted = VERSION; bg.remove();
        } catch (e) { ok.disabled = false; showToast(e.message || L.err); }
      });
      button(L.leave, 'btn-g', () => { bg.remove(); logout(); });
    } else button(L.close, 'btn-g', () => bg.remove());
    document.body.appendChild(bg);
  }
  window.crixShowRules = () => show(false);

  // Cubre todas las formas de entrar (contraseña, Google, sesión guardada). Sin conexión no se pide: no se puede publicar.
  setInterval(() => {
    const open = document.getElementById('crix-rules-box');
    if (open && open.dataset.lang !== String(window.__crixLang)) { show(open.dataset.must === '1'); return; }
    if (typeof ME === 'undefined' || !ME || !DB.get('token') || !navigator.onLine) return;
    if (ME.rulesAccepted !== VERSION && !open) show(true);
  }, 1500);
})();
