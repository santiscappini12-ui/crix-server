'use strict';
// Traducciones del cuestionario de clasificación a los idiomas de la app: [pt, fr, de, it].
// La clave es el texto en inglés tal como aparece en classification.js (es y en viven allí).
// Para agregar un idioma: sumá su código a LANGS y una posición más en cada arreglo.
const LANGS = ['pt', 'fr', 'de', 'it'];

const TR = {
  // ── Legalidad ──
  'Does it contain sexual content involving minors, or sexualized depictions of minors? (This includes drawings, fiction, humor, or AI-generated content.)': [
    'Contém conteúdo sexual envolvendo menores de idade ou representações sexualizadas de menores? (Vale também para desenhos, ficção, humor ou conteúdo feito com IA.)',
    'Contient-il du contenu sexuel impliquant des mineurs ou des représentations sexualisées de mineurs ? (Cela inclut les dessins, la fiction, l’humour et les contenus générés par IA.)',
    'Enthält es sexuelle Inhalte mit Minderjährigen oder sexualisierte Darstellungen von Minderjährigen? (Dazu zählen auch Zeichnungen, Fiktion, Humor oder KI-generierte Inhalte.)',
    'Contiene contenuti sessuali che coinvolgono minorenni o rappresentazioni sessualizzate di minorenni? (Vale anche per disegni, finzione, umorismo o contenuti generati con l’IA.)'],
  'Does it show intimate or sexual images of real people without their consent? (This includes parody, humor, or AI-generated fakes.)': [
    'Mostra imagens íntimas ou sexuais de pessoas reais sem o consentimento delas? (Vale também para paródia, humor ou montagens feitas com IA.)',
    'Montre-t-il des images intimes ou sexuelles de personnes réelles sans leur consentement ? (Cela inclut la parodie, l’humour et les faux générés par IA.)',
    'Zeigt es intime oder sexuelle Bilder echter Personen ohne deren Einwilligung? (Dazu zählen auch Parodie, Humor oder KI-generierte Fälschungen.)',
    'Mostra immagini intime o sessuali di persone reali senza il loro consenso? (Vale anche per parodia, umorismo o falsi generati con l’IA.)'],
  'Does it incite violence or terrorism, or provide propaganda or instructions for attacks? (Fictional violence, games, and dark humor that clearly do not incite anything real do not count.)': [
    'Incita violência ou terrorismo, ou faz propaganda ou dá instruções para cometer atentados? (Violência de ficção, jogos e humor negro que claramente não incitam nada real não contam.)',
    'Incite-t-il à la violence ou au terrorisme, ou fait-il de la propagande ou donne-t-il des instructions pour commettre des attentats ? (La violence fictive, les jeux et l’humour noir qui n’incitent clairement à rien de réel ne comptent pas.)',
    'Ruft es zu Gewalt oder Terrorismus auf, macht es Propaganda oder gibt es Anleitungen für Anschläge? (Fiktive Gewalt, Spiele und schwarzer Humor, die offensichtlich zu nichts Realem aufrufen, zählen nicht.)',
    'Incita alla violenza o al terrorismo, oppure fa propaganda o dà istruzioni per compiere attentati? (La violenza di finzione, i giochi e l’umorismo nero che chiaramente non incitano a nulla di reale non contano.)'],
  'Does it contain real threats, targeted harassment, or other people’s private data shared without permission? (Parody or satire of public figures without threats or harassment does not count; a "joke" that harasses or exposes a person does.)': [
    'Contém ameaças reais, assédio direcionado ou dados privados de outras pessoas publicados sem permissão? (Paródia ou sátira de figuras públicas sem ameaças nem assédio não conta; uma "piada" que assedia ou expõe uma pessoa conta.)',
    'Contient-il des menaces réelles, du harcèlement ciblé ou des données privées d’autres personnes publiées sans autorisation ? (La parodie ou la satire de personnalités publiques sans menaces ni harcèlement ne compte pas ; une « blague » qui harcèle ou expose une personne compte.)',
    'Enthält es echte Drohungen, gezielte Belästigung oder private Daten anderer Personen, die ohne Erlaubnis veröffentlicht wurden? (Parodie oder Satire über Personen des öffentlichen Lebens ohne Drohungen oder Belästigung zählt nicht; ein „Witz“, der eine Person belästigt oder bloßstellt, zählt.)',
    'Contiene minacce reali, molestie mirate o dati privati di altre persone pubblicati senza permesso? (Parodia o satira di personaggi pubblici senza minacce né molestie non conta; uno "scherzo" che molesta o espone una persona conta.)'],
  'Is it malware, phishing, a scam, or used to steal accounts or data? (A harmless prank that steals, damages, or locks nothing does not count.)': [
    'É malware, phishing, golpe ou serve para roubar contas ou dados? (Uma brincadeira inofensiva que não rouba, danifica nem bloqueia nada não conta.)',
    'Est-ce un logiciel malveillant, du phishing, une arnaque, ou sert-il à voler des comptes ou des données ? (Un canular inoffensif qui ne vole, n’abîme et ne bloque rien ne compte pas.)',
    'Ist es Schadsoftware, Phishing, Betrug oder dient es dazu, Konten oder Daten zu stehlen? (Ein harmloser Streich, der nichts stiehlt, beschädigt oder sperrt, zählt nicht.)',
    'È malware, phishing, una truffa o serve a rubare account o dati? (Uno scherzo innocuo che non ruba, non danneggia e non blocca nulla non conta.)'],
  'Do you own the rights or have permission to publish everything it includes (images, music, videos, code, models)?': [
    'Você tem os direitos ou a permissão para publicar tudo o que ele inclui (imagens, música, vídeos, código, modelos)?',
    'Détenez-vous les droits ou l’autorisation de publier tout ce qu’il contient (images, musique, vidéos, code, modèles) ?',
    'Besitzen Sie die Rechte oder haben Sie die Erlaubnis, alles zu veröffentlichen, was es enthält (Bilder, Musik, Videos, Code, Modelle)?',
    'Hai i diritti o il permesso di pubblicare tutto ciò che include (immagini, musica, video, codice, modelli)?'],
  'Does it show symbols or propaganda of Nazi or unconstitutional organizations? Answer "no" if it is educational, historical, informational, or art or satire that clearly rejects those ideas. If it is humor (including absurd humor) that shows them without rejecting them, answer "yes": in this country the law may prohibit it even as a joke.': [
    'Mostra símbolos ou propaganda de organizações nazistas ou inconstitucionais? Responda "não" se for educativo, histórico, informativo, ou arte ou sátira que rejeita claramente essas ideias. Se for humor (inclusive absurdo) que os mostra sem rejeitá-los, responda "sim": neste país a lei pode proibir isso mesmo como piada.',
    'Montre-t-il des symboles ou de la propagande d’organisations nazies ou inconstitutionnelles ? Répondez « non » si c’est éducatif, historique, informatif, ou de l’art ou de la satire qui rejette clairement ces idées. Si c’est de l’humour (même absurde) qui les montre sans les rejeter, répondez « oui » : dans ce pays, la loi peut l’interdire même sous forme de blague.',
    'Zeigt es Symbole oder Propaganda nationalsozialistischer oder verfassungswidriger Organisationen? Antworten Sie „Nein“, wenn es der Bildung, der Geschichte oder der Information dient oder Kunst bzw. Satire ist, die diese Ideen klar ablehnt. Wenn es Humor (auch absurder) ist, der sie zeigt, ohne sie abzulehnen, antworten Sie „Ja“: In diesem Land kann das Gesetz dies auch als Scherz verbieten.',
    'Mostra simboli o propaganda di organizzazioni naziste o incostituzionali? Rispondi "no" se è educativo, storico, informativo, oppure arte o satira che rifiuta chiaramente quelle idee. Se è umorismo (anche assurdo) che li mostra senza rifiutarli, rispondi "sì": in questo paese la legge può vietarlo anche come scherzo.'],
  'Does it deny, trivialize, or justify the Holocaust or recognized genocides, including as a joke? (Satire that criticizes those who deny it does not count.)': [
    'Nega, minimiza ou justifica o Holocausto ou genocídios reconhecidos, inclusive em tom de piada? (Uma sátira que critica quem o nega não conta.)',
    'Nie-t-il, banalise-t-il ou justifie-t-il l’Holocauste ou des génocides reconnus, y compris sur le ton de la blague ? (Une satire qui critique ceux qui le nient ne compte pas.)',
    'Leugnet, verharmlost oder rechtfertigt es den Holocaust oder anerkannte Völkermorde, auch als Scherz? (Satire, die diejenigen kritisiert, die ihn leugnen, zählt nicht.)',
    'Nega, minimizza o giustifica l’Olocausto o genocidi riconosciuti, anche per scherzo? (Una satira che critica chi lo nega non conta.)'],

  // ── Contenido ──
  'Violence': ['Violência', 'Violence', 'Gewalt', 'Violenza'],
  'No violence': ['Sem violência', 'Aucune violence', 'Keine Gewalt', 'Nessuna violenza'],
  'Cartoon or fantasy violence, no blood': ['Violência de desenho animado ou fantasia, sem sangue', 'Violence de dessin animé ou fantastique, sans sang', 'Cartoon- oder Fantasy-Gewalt, ohne Blut', 'Violenza da cartone animato o fantasy, senza sangue'],
  'Fantasy violence with some blood': ['Violência de fantasia com algum sangue', 'Violence fantastique avec un peu de sang', 'Fantasy-Gewalt mit etwas Blut', 'Violenza fantasy con un po’ di sangue'],
  'Realistic violence with blood': ['Violência realista com sangue', 'Violence réaliste avec du sang', 'Realistische Gewalt mit Blut', 'Violenza realistica con sangue'],
  'Extreme violence: gore, mutilation, or torture': ['Violência extrema: gore, mutilações ou tortura', 'Violence extrême : gore, mutilations ou torture', 'Extreme Gewalt: Gore, Verstümmelung oder Folter', 'Violenza estrema: gore, mutilazioni o tortura'],
  'Fear and horror': ['Medo e terror', 'Peur et horreur', 'Angst und Horror', 'Paura e horror'],
  'Nothing scary': ['Nada assustador', 'Rien d’effrayant', 'Nichts Gruseliges', 'Niente di spaventoso'],
  'Mildly unsettling scenes': ['Cenas levemente perturbadoras', 'Scènes légèrement troublantes', 'Leicht beunruhigende Szenen', 'Scene leggermente inquietanti'],
  'Jump scares, creatures, or moderate horror': ['Sustos, criaturas ou terror moderado', 'Sursauts, créatures ou horreur modérée', 'Schreckmomente, Kreaturen oder mäßiger Horror', 'Spaventi improvvisi, creature o horror moderato'],
  'Intense horror or disturbing scenes': ['Terror intenso ou cenas perturbadoras', 'Horreur intense ou scènes dérangeantes', 'Intensiver Horror oder verstörende Szenen', 'Horror intenso o scene disturbanti'],
  'Sexual content and nudity': ['Conteúdo sexual e nudez', 'Contenu sexuel et nudité', 'Sexuelle Inhalte und Nacktheit', 'Contenuti sessuali e nudità'],
  'None': ['Nenhum', 'Aucun', 'Keine', 'Nessuno'],
  'Mild romance (kissing, hugging)': ['Romance leve (beijos, abraços)', 'Romance léger (baisers, câlins)', 'Leichte Romantik (Küsse, Umarmungen)', 'Romanticismo leggero (baci, abbracci)'],
  'Innuendo, suggestive clothing, or sexual humor': ['Insinuações, roupas provocantes ou humor sexual', 'Sous-entendus, tenues suggestives ou humour sexuel', 'Anzüglichkeiten, aufreizende Kleidung oder sexueller Humor', 'Allusioni, abiti provocanti o umorismo sessuale'],
  'Partial nudity (underwear, swimwear) or implied sexual scenes, without showing uncovered intimate parts': ['Nudez parcial (roupa íntima, traje de banho) ou cenas sexuais sugeridas, sem mostrar partes íntimas descobertas', 'Nudité partielle (sous-vêtements, maillot de bain) ou scènes sexuelles suggérées, sans montrer de parties intimes découvertes', 'Teilweise Nacktheit (Unterwäsche, Badebekleidung) oder angedeutete sexuelle Szenen, ohne unbedeckte Intimbereiche zu zeigen', 'Nudità parziale (biancheria intima, costume da bagno) o scene sessuali suggerite, senza mostrare parti intime scoperte'],
  'Shows uncovered intimate parts with no educational purpose, or erotic content or explicit sexual acts (adults only; body parts cut off by violence do not count here, they go under Violence)': ['Mostra partes íntimas descobertas sem fim educativo, ou conteúdo erótico ou atos sexuais explícitos (somente adultos; partes do corpo cortadas ou arrancadas por violência não contam aqui, vão em Violência)', 'Montre des parties intimes découvertes sans but éducatif, ou du contenu érotique ou des actes sexuels explicites (adultes uniquement ; les parties du corps coupées ou arrachées par la violence ne comptent pas ici, elles relèvent de la Violence)', 'Zeigt unbedeckte Intimbereiche ohne Bildungszweck, oder erotische Inhalte oder explizite sexuelle Handlungen (nur Erwachsene; durch Gewalt abgetrennte Körperteile zählen hier nicht, sie gehören zu Gewalt)', 'Mostra parti intime scoperte senza scopo educativo, oppure contenuti erotici o atti sessuali espliciti (solo adulti; le parti del corpo tagliate o staccate dalla violenza non contano qui, rientrano in Violenza)'],
  // ── Humor tabú y cuerpo con fin educativo ──
  'Humor about sex or other taboo topics (death, religion, drugs, illness, the body...), not erotic': ['Humor sobre sexo ou outros temas tabu (morte, religião, drogas, doenças, corpo...), sem erotismo', 'Humour sur le sexe ou d’autres sujets tabous (mort, religion, drogues, maladies, corps...), sans érotisme', 'Humor über Sex oder andere Tabuthemen (Tod, Religion, Drogen, Krankheit, Körper...), nicht erotisch', 'Umorismo su sesso o altri temi tabù (morte, religione, droghe, malattie, corpo...), non erotico'],
  'Mild taboo jokes or references, without showing intimate parts': ['Piadas ou referências tabu leves, sem mostrar partes íntimas', 'Blagues ou références tabous légères, sans montrer de parties intimes', 'Leichte Tabuwitze oder -anspielungen, ohne Intimbereiche zu zeigen', 'Battute o riferimenti tabù leggeri, senza mostrare parti intime'],
  'Strong or crude taboo humor (told or implied), not erotic and without showing intimate parts': ['Humor tabu forte ou cru (contado ou insinuado), sem erotismo e sem mostrar partes íntimas', 'Humour tabou fort ou cru (raconté ou suggéré), sans érotisme et sans montrer de parties intimes', 'Starker oder derber Tabuhumor (erzählt oder angedeutet), nicht erotisch und ohne Intimbereiche zu zeigen', 'Umorismo tabù forte o crudo (raccontato o suggerito), non erotico e senza mostrare parti intime'],
  'Shows intimate parts for an educational purpose (sex education, anatomy, health), not erotic': ['Mostra partes íntimas com fim educativo (educação sexual, anatomia, saúde), sem erotismo', 'Montre des parties intimes dans un but éducatif (éducation sexuelle, anatomie, santé), sans érotisme', 'Zeigt Intimbereiche zu Bildungszwecken (Sexualkunde, Anatomie, Gesundheit), nicht erotisch', 'Mostra parti intime a scopo educativo (educazione sessuale, anatomia, salute), non erotico'],
  'Shows uncovered intimate parts with no educational purpose, or is erotic (adults only; body parts cut off by violence do not count here)': ['Mostra partes íntimas descobertas sem fim educativo, ou é erótico (somente adultos; partes do corpo cortadas ou arrancadas por violência não contam aqui)', 'Montre des parties intimes découvertes sans but éducatif, ou est érotique (adultes uniquement ; les parties du corps coupées ou arrachées par la violence ne comptent pas ici)', 'Zeigt unbedeckte Intimbereiche ohne Bildungszweck, oder ist erotisch (nur Erwachsene; durch Gewalt abgetrennte Körperteile zählen hier nicht)', 'Mostra parti intime scoperte senza scopo educativo, oppure è erotico (solo adulti; le parti del corpo tagliate o staccate dalla violenza non contano qui)'],
  'Taboo humor': ['Humor tabu', 'Humour tabou', 'Tabuhumor', 'Umorismo tabù'],
  'Body shown for education': ['Corpo com fim educativo', 'Corps montré à but éducatif', 'Körper zu Bildungszwecken', 'Corpo mostrato a scopo educativo'],
  'Language': ['Linguagem', 'Langage', 'Sprache', 'Linguaggio'],
  'No profanity': ['Sem palavrões', 'Aucun gros mot', 'Keine Kraftausdrücke', 'Nessuna parolaccia'],
  'Very mild insults': ['Insultos muito leves', 'Insultes très légères', 'Sehr leichte Beleidigungen', 'Insulti molto lievi'],
  'Moderate profanity': ['Palavrões moderados', 'Grossièretés modérées', 'Mäßige Kraftausdrücke', 'Parolacce moderate'],
  'Strong or frequent profanity': ['Palavrões fortes ou frequentes', 'Grossièretés fortes ou fréquentes', 'Starke oder häufige Kraftausdrücke', 'Parolacce forti o frequenti'],
  'Discrimination, including jokes, dark humor, or satire (short of inciting violence, which is illegal)': [
    'Discriminação, inclusive em piadas, humor negro ou sátira (sem chegar a incitar violência: isso é ilegal)',
    'Discrimination, y compris dans les blagues, l’humour noir ou la satire (sans aller jusqu’à inciter à la violence : c’est illégal)',
    'Diskriminierung, auch in Witzen, schwarzem Humor oder Satire (ohne zu Gewalt aufzurufen: das ist illegal)',
    'Discriminazione, anche in battute, umorismo nero o satira (senza arrivare a incitare alla violenza: è illegale)'],
  'Mild stereotypes or jokes': ['Estereótipos ou piadas leves', 'Stéréotypes ou blagues légères', 'Leichte Stereotype oder Witze', 'Stereotipi o battute leggere'],
  'Discriminatory language present': ['Linguagem discriminatória presente', 'Langage discriminatoire présent', 'Diskriminierende Sprache vorhanden', 'Linguaggio discriminatorio presente'],
  'Discrimination as a central or offensive theme': ['Discriminação como tema central ou ofensivo', 'Discrimination comme thème central ou offensant', 'Diskriminierung als zentrales oder beleidigendes Thema', 'Discriminazione come tema centrale o offensivo'],
  'Alcohol, tobacco, and drugs': ['Álcool, tabaco e drogas', 'Alcool, tabac et drogues', 'Alkohol, Tabak und Drogen', 'Alcol, tabacco e droghe'],
  'Mentioned in passing': ['Mencionados de passagem', 'Mentionnés en passant', 'Nur am Rande erwähnt', 'Menzionati di sfuggita'],
  'Alcohol or tobacco use is shown': ['Mostra consumo de álcool ou tabaco', 'Consommation d’alcool ou de tabac montrée', 'Konsum von Alkohol oder Tabak wird gezeigt', 'Viene mostrato il consumo di alcol o tabacco'],
  'Illegal drug use is shown or glorified': ['Mostra ou glorifica o consumo de drogas ilegais', 'Consommation de drogues illégales montrée ou glorifiée', 'Konsum illegaler Drogen wird gezeigt oder verherrlicht', 'Viene mostrato o glorificato il consumo di droghe illegali'],
  'Gambling': ['Apostas e jogos de azar', 'Jeux d’argent', 'Glücksspiel', 'Gioco d’azzardo'],
  'Simulated chance games, no real money, no teaching': ['Jogos de azar simulados, sem dinheiro real e sem ensinar a apostar', 'Jeux de hasard simulés, sans argent réel et sans apprendre à parier', 'Simulierte Glücksspiele, ohne echtes Geld und ohne Anleitung zum Wetten', 'Giochi d’azzardo simulati, senza denaro reale e senza insegnare a scommettere'],
  'Simulated gambling that imitates the real thing': ['Apostas simuladas que imitam as reais', 'Jeux d’argent simulés qui imitent les vrais', 'Simuliertes Glücksspiel, das das echte nachahmt', 'Scommesse simulate che imitano quelle vere'],
  'Real-money gambling': ['Apostas com dinheiro real', 'Jeux d’argent avec de l’argent réel', 'Glücksspiel um echtes Geld', 'Scommesse con denaro reale'],
  'Real-money purchases': ['Compras com dinheiro real', 'Achats avec de l’argent réel', 'Käufe mit echtem Geld', 'Acquisti con denaro reale'],
  'No purchases': ['Sem compras', 'Aucun achat', 'Keine Käufe', 'Nessun acquisto'],
  'In-game or in-app purchases': ['Tem compras dentro do jogo ou app', 'Achats intégrés au jeu ou à l’app', 'Käufe im Spiel oder in der App', 'Acquisti all’interno del gioco o dell’app'],
  'Paid random rewards (loot boxes)': ['Tem caixas-surpresa pagas (loot boxes)', 'Récompenses aléatoires payantes (loot boxes)', 'Bezahlte Zufallsbelohnungen (Lootboxen)', 'Ricompense casuali a pagamento (loot box)'],
  'User interaction': ['Interação entre usuários', 'Interaction entre utilisateurs', 'Interaktion zwischen Nutzern', 'Interazione tra utenti'],
  'Each person uses it on their own': ['Cada pessoa usa sozinha', 'Chaque personne l’utilise seule', 'Jede Person nutzt es für sich allein', 'Ogni persona lo usa da sola'],
  'Chat, multiplayer, or user-generated content': ['Tem chat, multijogador ou conteúdo criado por usuários', 'Chat, multijoueur ou contenu créé par les utilisateurs', 'Chat, Mehrspieler oder von Nutzern erstellte Inhalte', 'Chat, multigiocatore o contenuti creati dagli utenti'],
  'Other users’ content': ['Conteúdo de outros usuários', 'Contenu d’autres utilisateurs', 'Inhalte anderer Nutzer', 'Contenuti di altri utenti'],
  'Users cannot upload or create content inside it': ['Os usuários não podem enviar nem criar conteúdo dentro', 'Les utilisateurs ne peuvent ni envoyer ni créer de contenu à l’intérieur', 'Nutzer können darin keine Inhalte hochladen oder erstellen', 'Gli utenti non possono caricare né creare contenuti al suo interno'],
  'Users can upload or create their own content (any intensity; not counted in this rating)': ['Os usuários podem enviar ou criar conteúdo próprio (de qualquer intensidade; não conta nesta classificação)', 'Les utilisateurs peuvent envoyer ou créer leur propre contenu (de toute intensité ; non compté dans cette classification)', 'Nutzer können eigene Inhalte hochladen oder erstellen (beliebige Intensität; zählt nicht für diese Einstufung)', 'Gli utenti possono caricare o creare contenuti propri (di qualsiasi intensità; non conta in questa classificazione)'],
  'Is it mainly intended for children under 13?': ['É pensado principalmente para menores de 13 anos?', 'Est-il principalement destiné aux enfants de moins de 13 ans ?', 'Ist es hauptsächlich für Kinder unter 13 Jahren gedacht?', 'È pensato principalmente per bambini sotto i 13 anni?'],
  'No': ['Não', 'Non', 'Nein', 'No'],
  'Yes, it is for children': ['Sim, é para crianças', 'Oui, il est destiné aux enfants', 'Ja, es ist für Kinder', 'Sì, è per bambini'],

  // ── Descriptores (etiquetas en la insignia) ──
  'Extreme violence': ['Violência extrema', 'Violence extrême', 'Extreme Gewalt', 'Violenza estrema'],
  'Fear': ['Medo', 'Peur', 'Angst', 'Paura'],
  'Sexual content': ['Conteúdo sexual', 'Contenu sexuel', 'Sexuelle Inhalte', 'Contenuti sessuali'],
  'Explicit sexual content': ['Conteúdo sexual explícito', 'Contenu sexuel explicite', 'Explizite sexuelle Inhalte', 'Contenuti sessuali espliciti'],
  'Strong language': ['Linguagem forte', 'Langage grossier', 'Derbe Sprache', 'Linguaggio volgare'],
  'Discrimination': ['Discriminação', 'Discrimination', 'Diskriminierung', 'Discriminazione'],
  'Drugs, alcohol, or tobacco': ['Drogas, álcool ou tabaco', 'Drogues, alcool ou tabac', 'Drogen, Alkohol oder Tabak', 'Droghe, alcol o tabacco'],
  'In-app purchases': ['Compras no app', 'Achats intégrés', 'In-App-Käufe', 'Acquisti in-app'],
  'Paid random rewards': ['Recompensas aleatórias pagas', 'Récompenses aléatoires payantes', 'Bezahlte Zufallsbelohnungen', 'Ricompense casuali a pagamento'],
  'Users interact': ['Usuários interagem', 'Les utilisateurs interagissent', 'Nutzer interagieren', 'Gli utenti interagiscono'],
  'Includes user-generated content (not rated)': ['Inclui conteúdo de usuários (não classificado)', 'Inclut du contenu d’utilisateurs (non classé)', 'Enthält Nutzerinhalte (nicht eingestuft)', 'Include contenuti degli utenti (non classificato)'],
  'For children': ['Para crianças', 'Pour enfants', 'Für Kinder', 'Per bambini'],
};

// Mensajes de error del servidor (clave = texto en inglés).
const MSG = {
  'The classification questionnaire is required.': ['É preciso preencher o questionário de classificação.', 'Le questionnaire de classification est obligatoire.', 'Der Einstufungsfragebogen muss ausgefüllt werden.', 'Il questionario di classificazione è obbligatorio.'],
  'Invalid media type.': ['Tipo de mídia inválido.', 'Type de média invalide.', 'Ungültiger Medientyp.', 'Tipo di contenuto non valido.'],
  'Choose your country.': ['Escolha o seu país.', 'Choisissez votre pays.', 'Wählen Sie Ihr Land.', 'Scegli il tuo paese.'],
  'Answer all the legality questions.': ['Responda a todas as perguntas de legalidade.', 'Répondez à toutes les questions de légalité.', 'Beantworten Sie alle Fragen zur Rechtmäßigkeit.', 'Rispondi a tutte le domande sulla legalità.'],
  'This content cannot be uploaded to Crix because it is illegal or you do not have the rights to publish it.': [
    'Este conteúdo não pode ser enviado ao Crix porque é ilegal ou você não tem os direitos para publicá-lo.',
    'Ce contenu ne peut pas être envoyé sur Crix car il est illégal ou vous n’avez pas les droits pour le publier.',
    'Dieser Inhalt kann nicht auf Crix hochgeladen werden, da er illegal ist oder Sie nicht die Rechte zur Veröffentlichung haben.',
    'Questo contenuto non può essere caricato su Crix perché è illegale o non hai i diritti per pubblicarlo.'],
  'You must accept the final declaration.': ['Você precisa aceitar a declaração final.', 'Vous devez accepter la déclaration finale.', 'Sie müssen die abschließende Erklärung akzeptieren.', 'Devi accettare la dichiarazione finale.'],
  'Answer all the content questions.': ['Responda a todas as perguntas de conteúdo.', 'Répondez à toutes les questions de contenu.', 'Beantworten Sie alle Fragen zum Inhalt.', 'Rispondi a tutte le domande sul contenuto.'],
  'You said it is for children under 13, but the content you declared is for older audiences.': [
    'Você disse que é para menores de 13 anos, mas o conteúdo declarado é para públicos mais velhos.',
    'Vous avez indiqué qu’il est destiné aux moins de 13 ans, mais le contenu déclaré s’adresse à un public plus âgé.',
    'Sie haben angegeben, dass es für Kinder unter 13 Jahren ist, aber der angegebene Inhalt ist für ältere Zielgruppen.',
    'Hai detto che è per bambini sotto i 13 anni, ma il contenuto dichiarato è per un pubblico più grande.'],
};

// Nombre de "Otro país" (los demás países salen de Intl.DisplayNames).
const OTHER_COUNTRY = { es: 'Otro país', en: 'Other country', pt: 'Outro país', fr: 'Autre pays', de: 'Anderes Land', it: 'Altro paese' };

module.exports = { LANGS, TR, MSG, OTHER_COUNTRY };
