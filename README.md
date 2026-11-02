# Crix

Crix es una plataforma web social de juegos y creación con cuentas compartidas, publicación de mapas, apps HTML y videos, foros y juego multijugador con Node.js, Express y Socket.IO. La interfaz también se puede instalar como una aplicación web progresiva (PWA).

## Ejecutar localmente

Se necesita Node.js 22 o 24. La instalación incluye `isolated-vm`, que compila un módulo nativo; en Windows puede requerir las herramientas de compilación de C++ de Visual Studio.

```bash
npm install
npm start
```

Abrí `http://localhost:3000`.

## Cuentas y almacenamiento

Las cuentas son globales para quienes usan la misma plataforma y dominio público de Crix; no dependen del dispositivo. Las contraseñas se guardan con hash scrypt y la sesión dura 30 días. Las cuentas locales anteriores se pueden migrar iniciando sesión desde el navegador donde están guardadas.

Para habilitar la cuenta administrativa `Crix`, configurá `CRIX_ADMIN_PASSWORD` como secreto del entorno y registrá o iniciá sesión con el nombre `Crix` y esa contraseña. Es necesario configurar el secreto antes de crear la cuenta.

Los datos se guardan en un archivo JSON (`CRIX_DATA_FILE` elige la ruta; por defecto `crix_data.json` junto al servidor) y los medios en carpetas junto a él.

### Persistencia en Render sin disco de pago

Render (plan gratis) borra el disco local en cada deploy o reinicio. Crix puede respaldar **usuarios, juegos, posts, videos y texturas** en un bucket compatible con S3 y restaurarlos solo al arrancar:

- Al iniciar, `start.js` baja la base del bucket; las texturas y los videos se bajan bajo demanda la primera vez que alguien los pide.
- Cada cambio de la base se sube comprimida (como máximo una vez cada 3 s) y cada video/textura se sube al guardarse.
- Al recibir `SIGTERM` (cada deploy de Render) se guarda y se sube todo lo pendiente antes de salir.
- Se conserva un respaldo diario de la base (los últimos 7 días) en `db/backup-AAAA-MM-DD.json.gz`.
- Si el bucket no responde al arrancar, el servidor **no arranca**, para no reemplazar tus datos con una base vacía.
- Si se configura el bucket y ya había datos en el disco local, lo que falte en el bucket se sube solo.

Configuración (ejemplo con Backblaze B2; sirve cualquier servicio compatible con S3):

1. Creá un bucket **privado** y una *Application Key* con acceso a ese bucket.
2. En Render → *Environment* cargá las variables:

| Variable | Valor |
| --- | --- |
| `CRIX_S3_BUCKET` | nombre del bucket |
| `CRIX_S3_ACCESS_KEY_ID` | keyID de la clave |
| `CRIX_S3_SECRET_ACCESS_KEY` | applicationKey |
| `CRIX_S3_ENDPOINT` | por ejemplo `https://s3.us-west-004.backblazeb2.com` |
| `CRIX_S3_REGION` | por ejemplo `us-west-004` |
| `CRIX_S3_PREFIX` | (opcional) carpeta dentro del bucket |

3. El *Start Command* de Render tiene que ser `npm start` (no `node server.js`; en ese caso el servidor se niega a iniciar para proteger los datos).

El bucket no tiene tope fijo: el costo crece solo con lo que se almacena. Sin estas variables Crix funciona como antes, solo con disco local.

## Notificaciones (PWA)

Al instalar Crix como aplicación (o desde el navegador) aparece un aviso para **activar las notificaciones**. Con ellas activas, el teléfono o la PC **suena y vibra** cuando alguien te llama (con botones *Contestar* / *Rechazar*), te escribe o te manda una solicitud de amistad, aunque Crix esté cerrado o en segundo plano. Funciona con Web Push (VAPID) a través del service worker.

- El servidor solo manda push si la persona **no** tiene Crix a la vista, así que no hay avisos dobles.
- Los avisos de mensajes no incluyen el texto (el chat es E2EE): dicen quién escribió.
- Una llamada sigue sonando hasta 45 s con la app cerrada; si se corta queda un aviso de **llamada perdida**. Al abrir la app desde el aviso, el timbre aparece de inmediato.
- Dentro de la app hay sonido de mensaje y de solicitud de amistad, timbre de llamada más fuerte, título parpadeante e insignia numérica en el ícono instalado. `toggleSound()` silencia los sonidos (la llamada entrante siempre suena).
- **iPhone/iPad**: el push solo funciona con la app instalada (*Compartir → Agregar a inicio*, iOS 16.4 o superior).
- Claves: se generan solas y se guardan en la base. Opcionalmente fijalas con `CRIX_VAPID_PUBLIC_KEY`, `CRIX_VAPID_PRIVATE_KEY` y `CRIX_VAPID_SUBJECT` (por ejemplo `mailto:vos@dominio.com`). Si cambian, los dispositivos se vuelven a suscribir al abrir la app.
- Requiere HTTPS (o `localhost`). Rutas: `GET /api/push/key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`.

- **Íconos de la PWA**: la carpeta `icons/` (192, 512, maskable, apple-touch y badge) tiene que estar desplegada. Si falta un solo archivo, antes el service worker no se instalaba y por eso no llegaba ninguna notificación; ahora el service worker tolera archivos faltantes, pero sin íconos la app no se puede instalar bien en el teléfono.

## Llamadas en segundo plano

Una PWA no puede mantener el micrófono abierto "a la fuerza" cuando el sistema la pasa a segundo plano (no existe esa API web). Lo que sí hace Crix, en orden de efectividad:

- **Ventana flotante (🗗, Picture-in-Picture)**: es lo que mejor funciona en iPhone y Android, porque el sistema trata la llamada como un video en reproducción y no suspende la página. Ahora está disponible también en **llamadas de voz** (se muestra una tarjeta con avatar, nombre y cronómetro) y en videollamadas cuando el otro no tiene cámara. Chrome en Android la abre solo al salir de la app; en iPhone hay que tocar 🗗 **antes** de salir.
- **Sesión de audio de llamada** (`navigator.audioSession = "play-and-record"`, Safari 16.4+), audio de relleno silencioso, Media Session (colgar / silenciar desde el sistema) y pantalla encendida mientras Crix está a la vista.
- **Aviso fijo "En llamada con X"** con botón *Colgar* (con notificaciones activas) para volver con un toque.
- **Recuperación automática al volver**: si el sistema cortó o pausó el micrófono/cámara, se vuelven a pedir y se reemplazan en la llamada sin cortarla; se reconecta el socket y se reinicia la ruta (ICE) desde cualquiera de los dos lados. Las señales que llegan mientras alguien estaba en segundo plano las guarda el servidor y se las entrega al volver.
- **Avisos a la otra persona**: por un canal de datos WebRTC la otra persona ve "en segundo plano", "micrófono pausado por el sistema", "sin cámara", etc., en vez de quedarse sin saber por qué no se escucha.
- El servidor no corta una llamada aceptada si se cae el socket de uno de los dos; espera hasta 2 minutos.
- Limitación real: si el usuario sale de Crix **sin** ventana flotante, iPhone/iPad puede suspender la PWA y el micrófono se pausa hasta que vuelva (Android suele mantener el audio, pero apaga la cámara). Para llamadas largas con el teléfono bloqueado hace falta una app nativa.

## Iluminación y sombras

El sol proyecta sombras que **siguen al jugador** (o a la cámara del editor) con una cámara de sombras amplia y ajustada a la rejilla del mapa de sombras para que no titilen; las piezas translúcidas y de alambre no proyectan sombra y los avatares sí. El juego ahora usa la configuración de **Lighting** del editor (antes se ignoraba): ambiente, brillo, niebla, color de cielo, brillo/contraste/saturación y los nuevos controles *Intensidad*, *Altura* y *Dirección* del sol y el interruptor *Sombras*. Las cuñas (Wedge) tenían tres caras invertidas y ahora se ven completas con sombreado plano. Bloom, Blur y SunRays siguen siendo marcadores.

## Plataforma global y servidores de juego

La plataforma es **global**: cuentas, perfiles, juegos, videos y publicaciones los ve todo el mundo, estén en el servidor o instancia que estén. Cada vez que alguien sube un video, publica en los Foros, publica un juego o se registra, el servidor lo avisa por Socket.IO a todos los conectados y sus pantallas se actualizan sin recargar. Cada vez que alguien toca **Jugar**, Crix crea una instancia de partida separada con su propio identificador; los jugadores de una instancia no se mezclan con los de otra. La presencia (qué juego e instancia está jugando cada persona) es pública para los juegos públicos: la home tiene una sección **En línea ahora**, y tanto ahí como en el perfil y en la búsqueda aparece **Unirme** para entrar al servidor exacto de **cualquier persona**, sea amiga o no (`POST /api/join-user/:id`; el servidor comprueba que exista, que tengas acceso al juego y que haya lugar). En la ficha de un juego también se listan sus servidores activos. Las partidas de juegos no públicos solo revelan su presencia a personas autorizadas. Cada juego puede fijar su máximo de jugadores por servidor (por defecto 50).

En esta versión las instancias son salas separadas coordinadas por el proceso Node.js de Crix. No significa que todos jueguen en una sola sala. Para repartir salas entre varias máquinas físicas a gran escala, la plataforma todavía necesita un coordinador compartido y almacenamiento global con soporte para varios procesos; el repositorio no configura esa infraestructura por sí solo.

## Publicación y privacidad

- Los juegos y mapas son públicos por defecto y se pueden limitar a amigos, usuarios asignados o solo al creador. Todo lo público aparece en el catálogo global de Crix para cualquier cuenta, sin importar el país ni la instancia de juego.
- Las apps creadas en Crix se guardan como proyectos HTML y usan los mismos ajustes de privacidad y publicación que los juegos.
- Los videos pueden ser públicos o privados. Cada video público se entrega desde el catálogo global de Crix a cualquier persona, sin requisito de amistad; el video privado se entrega solo tras comprobar permisos.
- El catálogo de juegos muestra las creaciones públicas en páginas sucesivas; el directorio incluye a todos los creadores públicos de Crix. Los videos y publicaciones públicos se consultan desde el mismo catálogo global.
- Las publicaciones del foro y sus imágenes son públicas.
- Los medios que se guardan en el servidor requieren que el alojamiento tenga espacio de disco suficiente y mantenga el volumen persistente.
- Los videos (MP4, WebM u OGG; hasta 60 MB) se suben como archivo binario con barra de progreso, se validan por su formato real (no por el nombre) y se guardan como archivos en disco junto a la base de datos, no dentro del JSON. Se reproducen por streaming con soporte de rangos (se puede adelantar y retroceder) y la app genera una miniatura automática. Los videos antiguos guardados como base64 se migran solos al iniciar el servidor.
- La foto de perfil se cambia desde el perfil propio. Crix la recorta a 256 × 256, la comprime y la muestra en perfiles públicos y listas de usuarios; se guarda junto a la cuenta en el servidor.

## Modo equipo (creación en conjunto)

Cualquier proyecto (mapa 3D o app HTML) puede tener **colaboradores**. El creador los agrega desde **👥 Equipo** (barra del editor, o el editor de apps) escribiendo su nombre de usuario; hasta 20 personas por proyecto.

- **Co-edición en vivo** de mapas: quienes están en el editor ven al instante las piezas que agrega, mueve, escala o borra el resto, y también los scripts, la iluminación, los ajustes y las pantallas GUI. Cada persona ve de qué color es la pieza que está seleccionando cada integrante, y hay un **chat del equipo**. Si dos personas tocan la misma pieza a la vez gana el último cambio.
- **El servidor es la fuente de verdad** mientras hay una sesión activa (`team_join` / `team_ops`): aplica cada cambio sobre el mapa, lo reenvía al resto y lo guarda (con un pequeño retraso). Un guardado completo (`POST /api/maps`) no pisa las partes, scripts ni luces durante una sesión, así que el botón *Guardar* de alguien con datos viejos no deshace el trabajo del resto. Si se corta la conexión, al volver se fusionan los cambios sin perder lo que esa persona editó mientras tanto.
- **Permisos**: quienes colaboran pueden ver (aunque sea privado), editar, guardar y subir texturas. Solo el creador (o un admin) puede borrar el proyecto, cambiar su visibilidad o administrar el equipo; si se quita a alguien, se lo saca de la sesión en el momento.
- En el perfil de cada juego aparece **✏️ Editar (equipo)** para quien colabora, y en 👥 Equipo hay una lista de *Proyectos en los que colaborás*. Las apps HTML comparten permisos y chat, pero su código se guarda completo (gana el último guardado).
- API: `GET/POST /api/maps/:id/team` (`{ "add": "usuario" }` o `{ "remove": "idUsuario" }`), `GET /api/maps/:id/edit-state`; eventos Socket.IO `team_join`, `team_leave`, `team_ops`, `team_sel`, `team_chat`.

## Apps y juegos HTML con servidor y multijugador (SDK `Crix`)

Los archivos `.html` que se suben desde la PC (o las apps creadas en Crix) corren en un iframe aislado, sin acceso a la cuenta ni a la red. Crix les inyecta automáticamente un objeto global **`window.Crix`** que usa por detrás la misma sala de multijugador de los juegos: cada vez que alguien toca **Jugar** se crea una instancia, y **Unirme** / *Instancias activas* entran a la misma sala. No hay que importar nada ni cambiar el archivo.

```js
Crix.ready.then(async () => {
  Crix.me            // { id, username, color, socketId }
  Crix.online        // false si se abrió sin iniciar sesión (modo solo)
  Crix.players       // todas las personas de la sala (incluida esta)
  Crix.isHost        // la persona que entró primero; pasa sola a otra si se va

  Crix.send('mover', { x: 1 });            // a todos los demás (máx. 8 KB)
  Crix.send('golpe', { dmg: 5 }, otroId);  // a una sola persona (socketId o id de cuenta)
  Crix.on('message:mover', (data, from) => {});

  Crix.state.set('turno', 'ana');          // estado compartido de la sala (null borra la clave)
  Crix.on('state:turno', valor => {});
  Crix.state.get('turno'); Crix.state.all();

  const partida = await Crix.save.get();   // guardado propio en el servidor (64 KB, requiere cuenta)
  await Crix.save.set({ nivel: 3 });

  await Crix.leaderboard.submit('puntos', 120);         // se conserva el mejor puntaje
  await Crix.leaderboard.submit('tiempo', 41.2, 'min'); // 'min': gana el más bajo
  const { top, me } = await Crix.leaderboard.top('puntos', 10);

  Crix.on('join', p => {}).on('leave', p => {}).on('players', lista => {}).on('host', soyHost => {});
});
```

Todas las funciones que hablan con el servidor devuelven una promesa con `{ ok, ... }` (o `{ ok:false, err }`). Si la app se abre sin sesión, `Crix.online` es `false`, la sala es solo para esa persona y `Crix.state` funciona localmente. Un ejemplo completo está en `examples/crix-multiplayer-demo.html`.

Límites (para que una app no pueda saturar el servidor): 90 mensajes/s por persona, estado compartido de hasta 64 claves y 128 KB por sala, 20 rankings por app y 5000 entradas por ranking, guardados de hasta 64 KB por persona. El estado de la sala se borra cuando se va la última persona. El servidor solo reenvía entre personas de la misma instancia y nunca expone el token de sesión al iframe. Eventos Socket.IO: `app_hello`, `app_send`, `app_state_set`, `app_data_get/set`, `app_score_submit`, `app_score_top`.

## Llamadas de voz y video

Desde cualquier conversación se puede iniciar una **llamada de voz** o una **videollamada** con WebRTC real: se ve quién llama, se acepta o rechaza, hay timbre, silenciar micrófono, apagar cámara, cronómetro y avisos claros (rechazada, ocupado, sin respuesta, se cortó la conexión, falta el permiso del micrófono o la cámara). El audio y el video viajan directo entre las dos personas con cifrado DTLS-SRTP; el servidor solo retransmite la negociación (SDP e ICE) y lleva el estado de la llamada, y comprueba que quien envía señales sea realmente parte de una llamada aceptada.

Por defecto se usan servidores STUN públicos, que alcanzan solo cuando las dos personas pueden conectarse directo (mismo wifi, o redes sin NAT estricto). **Entre dos teléfonos con datos móviles (CGNAT) suele fallar**: la llamada queda en "Conectando…" y cada uno solo se ve a sí mismo. La solución es un servidor **TURN**; el servidor entrega las credenciales a los clientes desde `GET /api/ice`. Configurá **una** de estas opciones en las variables de entorno (Render → *Environment*):

| Opción | Variables | Notas |
| --- | --- | --- |
| **Metered Open Relay** (recomendada, sin tarjeta) | `CRIX_METERED_DOMAIN` (ej. `crix.metered.live`), `CRIX_METERED_API_KEY` | 20 GB/mes gratis, solo registro con email. Las credenciales se piden solas a la API. |
| **TURN con usuario/clave fijos** (ExpressTURN, coturn, etc.) | `CRIX_TURN_URL` (varias separadas por coma, ej. `turn:turn.midominio.com:3478,turns:turn.midominio.com:443?transport=tcp`), `CRIX_TURN_USER`, `CRIX_TURN_PASS` | |

**ExpressTURN (gratis, 1 TB/mes).** En Render → *Environment* alcanza con:

```
CRIX_TURN_URL  = relay1.expressturn.com
CRIX_TURN_USER = (usuario del panel de ExpressTURN)
CRIX_TURN_PASS = (contraseña del panel de ExpressTURN)
```

Si ponés solo el host, Crix lo expande solo a `turn:…:3478?transport=udp`, `turn:…:3478?transport=tcp` y `turns:…:443?transport=tcp` (esta última atraviesa redes que bloquean 3478). También se aceptan URLs completas separadas por coma. Para comprobar que responde: iniciá sesión y abrí `/api/ice/test` (dice por cada URL si responde, si rechaza usuario/clave o si el puerto está bloqueado); el mismo resultado sale en el log al arrancar (`ICE: TURN … → OK`). Si una llamada no conecta, la pantalla ahora indica el motivo real (usuario/clave rechazados o TURN inalcanzable).

El log del servidor indica al arrancar si hay TURN (`ICE servidores listos · TURN: metered`). Si no hay TURN, la llamada avisa en pantalla a los 7 s qué está pasando. Las llamadas requieren HTTPS (o `localhost`) para que el navegador permita el micrófono y la cámara.

## Chat privado E2EE

Los mensajes, audios y adjuntos nuevos se cifran en el navegador con ECDH P-256, HKDF-SHA-256 y AES-GCM-256 antes de enviarse. El servidor guarda y retransmite los sobres cifrados; el tipo y el contenido del mensaje no quedan guardados como texto plano. El servidor aún ve quién escribe a quién y cuándo. La clave privada de cada cuenta se cifra con una clave derivada de su contraseña (PBKDF2-SHA-256) y se almacena en una bóveda cifrada para permitir el acceso desde otros dispositivos. El navegador desbloquea la clave con la contraseña al iniciar sesión; una sesión restaurada puede pedirla al abrir el chat. La huella de la clave pública del contacto queda fijada en ese dispositivo; si cambia, Crix avisa antes de permitir leer o enviar.

El chat y las llamadas son **solo entre amigos**: la lista de contactos muestra únicamente a tus amigos y el servidor rechaza mensajes y llamadas entre cuentas que no se hayan aceptado como amigas. Ambas cuentas deben iniciar sesión una vez con esta versión para crear sus claves. Si se pierde la contraseña, no hay recuperación de la clave privada ni de los mensajes E2EE. Los mensajes anteriores a esta versión estaban en texto plano y se eliminan al actualizar; no pueden convertirse retroactivamente en E2EE. El servidor conserva el historial cifrado mientras el almacenamiento persistente tenga espacio disponible. Los adjuntos del chat tienen un límite de 10 MB. Las llamadas que muestra la interfaz siguen siendo una simulación y no se incluyen en este cifrado de mensajes.

Crix no agrega filtros de moderación de contenido. La privacidad de las publicaciones y el aislamiento técnico de scripts del editor siguen aplicándose.

## Crix Hub y scripting

**Crix Hub** (antes Crix Studio) incluye una escena 3D con Explorador filtrable, inspector de propiedades, selección, movimiento, rotación, escala, ajuste a cuadrícula, historial de deshacer/rehacer, atajos, duplicación, guardado y prueba del juego con retorno directo al editor. También permite importar geometría `.obj` (hasta 2 MB y 60.000 vértices expandidos); la geometría se guarda dentro del proyecto. Los materiales y texturas externos del OBJ no se importan.

### Anclar y soltar piezas

Todas las piezas están **ancladas** salvo que se suelten (`anchored: false`). En el editor: botones **🔒 Anclar** / **🔓 Soltar** (sin selección actúan sobre todo el mapa), el interruptor *Anchored* del inspector y el icono 🔒/🔓 en el Explorador. **⚛ Física** simula la gravedad dentro del editor y al apagarla restaura las posiciones. Al jugar, las piezas sueltas caen y se apoyan sobre otras piezas, tanto en ▶ Probar como en partidas online.

### Color, materiales y texturas

El inspector tiene un selector de **color** (muestra, hexadecimal, paleta de 28 colores, recientes y gotero en los navegadores que lo ofrecen) con vista previa en vivo y un único paso de deshacer por arrastre, una grilla visual de **17 materiales** (plástico liso, plástico, ladrillo, madera, tablones, metal, chapa, neón, vidrio, hielo, pasto, arena, hormigón, roca, mármol, adoquín y tela) que se ven distintos de verdad —patrones procedurales que se repiten según el tamaño de la pieza— y un control de transparencia. Podés **importar tus propias texturas** (PNG, JPG, WEBP o GIF): se ajustan a 512 px como máximo, se guardan como archivos en el servidor (hasta 16 y 450 KB cada una por juego), se pueden reutilizar en otras piezas, elegir su tamaño de repetición y mezclarlas o no con el color. Cualquier persona que juegue ese juego las ve igual; en juegos privados solo las ven quienes tienen acceso.

### Juegos completos sin programar

Cada pieza tiene un **Comportamiento**: ☠ lava/daño, ⬆ trampolín, 🚩 checkpoint, ⚡ acelerador, 🪙 moneda, 💚 cura, 🌀 teletransporte (por nombre de pieza) y 🏆 meta. El jugador tiene vida, monedas y reaparición (en el último checkpoint) con HUD propio. **⚙ Juego** ajusta velocidad, salto, gravedad, vida máxima, mensaje de bienvenida y jugadores máximos por servidor.

### Editor de GUI

**🖼 GUI** abre un editor visual (arrastrar, redimensionar, flechas para ajustar, Ctrl+D duplica, Supr borra) con Marcos, Textos, Botones, Imágenes, Barras de progreso y Cajas de texto, varias pantallas por juego y plantillas (HUD, menú, contador con script). Los textos admiten `{coins}`, `{health}`, `{maxHealth}`, `{deaths}` y `{time}`; una Barra puede enlazarse a la vida; un Botón puede mostrar/ocultar pantallas, teletransportar, reaparecer, mostrar un mensaje o salir, sin escribir código. Los elementos se controlan desde un `LocalScript` con `gui.get("Nombre")`. Las imágenes se guardan dentro del proyecto (máx. ~380 KB) y el texto nunca se interpreta como HTML.

### Editor de código

Resaltado de sintaxis, autocompletado de la API (Ctrl+Espacio), plantillas (`onStart`, `onTouched`…), autoindentado, cierre automático de paréntesis/comillas, Tab/Shift+Tab, Ctrl+/ para comentar, Ctrl+S guardar, Ctrl+Enter ejecutar, chequeo de sintaxis en vivo, ejemplos listos y un panel **📖 API** con la documentación.

El lenguaje con ejecución completa es **JavaScript**. En el modo **Probar** del editor, los scripts corren en un Web Worker local. En una partida publicada, los `Script` corren una sola vez por instancia en `script-runner.js`, un proceso aparte con un isolate de V8; los `LocalScript` siguen corriendo en cada navegador. `onStart(player, players)` inicia el script, `onUpdate(dt, player, players)` corre hasta 20 veces por segundo mientras hay jugadores y `onStop(player, players)` se llama al cerrar la instancia. Los cambios de mundo del servidor se validan, se replican a todos los jugadores de esa instancia y se envían como estado inicial a quienes entran más tarde. Partidas distintas mantienen estados distintos. `ModuleScript` se carga con `require("Nombre")` o `require("id")`; `task.wait(segundos)` y `task.delay(segundos, fn)` permiten programar trabajo dentro del ciclo del servidor. Los `LocalScript` (y los `Script` en ▶ Probar) disponen además de: `gui` (`gui.get(nombre).text/.visible/.value/.onClick(fn)/.onSubmit(fn)`, `gui.show/hide/toast`), `localPlayer` (`setSpeed`, `setJump`, `teleport`, `damage`, `heal`, `setHealth`, `kill`, `addCoins`, `setCheckpoint`, `say`, y las propiedades `health`, `maxHealth`, `coins`, `deaths`, `position`), eventos (`game.onTouched(pieza, fn)`, `game.onKey(tecla, fn)`, `game.on("died"|"won"|"coin", fn)`), `task.every(segundos, fn)` / `task.cancel(id)`, `time()` y `math.lerp/clamp/dist/tan/atan2/log/exp/sign`. Los `Script` de servidor no tienen `gui`, `localPlayer` ni teclas: para eso son los `LocalScript`.

La API disponible incluye:

```js
const id = game.createPart({
  name: "Plataforma",
  type: "Block", // Block, Sphere, Cylinder, Wedge o TrussPart
  position: { x: 0, y: 8, z: 0 },
  size: { x: 4, y: 1, z: 4 },
  color: "#5b8def",
  anchored: false,
  canCollide: true
});

game.updatePart(id, { anchored: true, canCollide: false });
game.destroyPart(id);
const player = game.getPlayer();
const players = game.getPlayers();
const parts = workspace.getChildren();
const ground = workspace.findFirstChild("Suelo");
```

Las piezas con `anchored: false` reciben gravedad del servidor; las piezas con `canCollide: false` atraviesan el escenario y el jugador. Las posiciones de piezas se sincronizan con los demás jugadores. La física actual resuelve gravedad y colisiones verticales sencillas; todavía no es un sistema físico completo. El proceso limita cada instancia a 8 `Script`, 500 piezas, 16 MB de memoria de isolate como referencia, 25 ms por evento y 20 instancias con scripts activas por proceso. Cada callback tiene presupuesto de CPU para que un bucle infinito no congele el servidor web.

**Física y contactos en el servidor.** La gravedad de las piezas con `anchored: false` corre en `world-physics.js` a 60 pasos por segundo (los mismos valores que el cliente) y usa la caja de cada pieza tal como se dibuja: con su rotación y con el origen real de cada forma (la cuña tiene el origen en la base). Una pieza apoyada acompaña a su soporte, así que ascensores y plataformas movidas con `updatePart` la llevan consigo; si un script cambia a mano la posición de una pieza dinámica, se descarta su velocidad. Los `Script` pueden enterarse de los choques:

```js
game.onTouched("Lava", (jugador, info) => { });   // jugador es null si la toca otra pieza
game.onTouchEnded("Lava", (jugador, info) => { });
game.onImpact("Caja", info => { }, 5);            // solo golpes de al menos 5 studs/s (por defecto 2)
const caja = game.getPart("Caja");                // estado actual, también por id
```

`info` trae `speed` (velocidad relativa en studs/s; en un aterrizaje es la velocidad exacta de caída), `normal` (de la otra pieza hacia esta), `velocity` (relativa), `part` y `other` (`{ kind: "player" | "part", name, x, y, z… }`). Los toques se calculan solo para las piezas que algún script registró por nombre o id, usan la caja barrida entre ticks (una bala rápida no atraviesa una pared fina; un salto de más de 16 studs en un tick se considera teletransporte) y no se disparan por solapamientos que ya existían al crear la pieza. Los jugadores que llegan a `onUpdate` incluyen `velocity`, `height`, `size` y `bounds` (el origen `x, y, z` está en los pies).

**Límites actuales:** JavaScript es el lenguaje con soporte completo. CrixScript conserva una conversión básica de sintaxis tipo Lua; no es un intérprete completo. Los `Script` sí se ejecutan en el servidor y replican el mundo de su instancia; `LocalScript` es local, por lo que el estado que crean (GUI, monedas, piezas creadas por un LocalScript) es de cada jugador y no se comparte con los demás. Todavía no hay `RemoteEvent` reales entre cliente y servidor, almacenamiento persistente por jugador (DataStore), sonido ni animaciones personalizadas; los elementos *Sound*, *Bloom*, *Blur* y *SunRays* del Explorador son marcadores. `ServerScriptService` y `LocalScriptService` distinguen el tipo de ejecución, aunque la jerarquía de servicios todavía es básica. `isolated-vm` limita memoria y tiempo, pero ejecutar código público requiere mantener Node y el módulo nativo actualizados; para alojar scripts de personas desconocidas a gran escala conviene correr `script-runner.js` en un contenedor sin privilegios separado del servidor web. Esto todavía no incluye todas las capacidades de Roblox Studio o Unity, ni intérpretes para todos los lenguajes, binario o ensamblador.

Los NPC incluidos se construyen como humanoides 3D con articulaciones básicas y animación procedural; todavía no hay editor de rigging, huesos ni animación.

## Sincronización del mundo entre jugadores

Todo lo que cambia en una partida online se ve igual para todos los jugadores de la instancia:

- **Piezas con física** (`anchored:false`): el servidor simula y emite un único paquete `world_delta` por tick (20 Hz) con todas las piezas que se movieron. El cliente **interpola** hacia esas posiciones a 60 Hz (`_stepNetInterp`), así que si alguien empuja una caja, una esfera rueda o un script mueve una plataforma, los demás lo ven fluido y no a saltos. Los saltos grandes (más de 12 studs) y el snapshot inicial se colocan directamente.
- **Jugadores nuevos** reciben el estado actual (`room_state`): piezas movidas, creadas/destruidas por scripts y coleccionables ya recogidos.
- **Coleccionables compartidos** (`behavior: coin`): el cliente avisa con `part_collect`; el servidor valida que la pieza exista, que no esté recogida y que el jugador esté cerca, y avisa al resto con `part_collected`. La moneda desaparece para todos y no reaparece para quien entra después.
- Posiciones, animación y rotación de avatares: `player_move` / `player_moved` (20 Hz, con suavizado).

## Motor de físicas y scripts (v2)

### Físicas
- **Jugador a paso fijo (60 Hz):** el movimiento ya no depende de los FPS (antes iba más rápido en monitores de 120/144 Hz). Incluye aceleración, inercia en el aire, *coyote time* y salto guardado, subida automática de escalones (hasta 0.7 studs), deslizamiento por las paredes (ya no se queda pegado), plataformas móviles que llevan al jugador, y las cajas de colisión solo se recalculan cuando una pieza se mueve.
- **Piezas sueltas (`anchored:false`, servidor):** velocidad en los 3 ejes, fricción según material (hielo desliza, arena frena), rebote, arrastre, gravedad por pieza, choques con paredes y otras piezas, apilado, plataformas móviles que arrastran lo que llevan encima, y el jugador puede empujar piezas ligeras.
- Propiedades por pieza (opcionales): `friction`, `bounce`, `drag` (0–1) y `gravityScale` (-5…5). Si no se indican, se usan los del material.
- Los eventos de contacto (`onTouched`, etc.) ahora también se detectan en choques rápidos que ocurren entre dos ticks.

### Scripts de servidor (nuevas funciones de `game`)
- Física: `setVelocity(id, v)`, `applyImpulse(id, v)`, `getVelocity(id)`, `setPhysics(id, {friction, bounce, drag, gravityScale})` (velocidades en studs/s).
- `raycast(origen, dirección, {maxDistance, ignore:[…], players:true})` → `{id, name, distance, point, normal}` o `null`.
- `tween(id, {position, size, x, y, z, sx, sy, sz, rx, ry, rz, transparent}, segundos, easing, alTerminar)`; easings: `linear, quadIn, quadOut, quadInOut, sine, cubicOut, back, bounce`.
- Búsqueda: `findParts(nombre|función)`, `getPartsByTag`, `addTag/removeTag/hasTag`, `getPartsInRadius`, `getPlayersInRadius`, `clonePart`, `destroyAfter`.
- Jugadores: `onPlayerAdded(fn)`, `onPlayerRemoved(fn)` (o funciones globales `onPlayerAdded/onPlayerRemoved`), `teleportPlayer`, `launchPlayer`, `setPlayerSpeed`, `setPlayerJump`, `damagePlayer`, `healPlayer`, `setPlayerHealth`, `killPlayer`, `giveCoins`, `setPlayerCheckpoint`, `message`, `broadcast`.
- Eventos entre cliente y servidor: en un LocalScript `game.fireServer("nombre", datos)` y `game.onServerEvent("nombre", fn)`; en el Script de servidor `game.onClientEvent("nombre", (jugador, datos) => …)`, `game.fireClient(jugador, "nombre", datos)` y `game.fireAllClients("nombre", datos)`. Límites: 4 KB por evento, 30/s por jugador. **Valida siempre los datos que llegan del cliente.**
- Eventos entre scripts: `game.on(nombre, fn)` / `game.emit(nombre, …)`.
- Temporizadores: `task.every(segundos, fn)`, `task.cancel(id)`, `task.spawn(fn)`; `task.delay` devuelve un id.
- Utilidades: `Vector3.new(x,y,z)` (add, sub, mul, dot, cross, lerp, distance, magnitude, unit), `math.lerp/clamp/dist/round/random(a,b)`.
- Un error ya no apaga el script a la primera: se registra y solo se desactiva tras 10 errores seguidos. Límite de cambios al mundo: 300/s.

### CrixScript (nuevo traductor)
Reescrito con tokens (`crixscript.js`): ya no rompe cadenas ni comentarios, y soporta `if/elseif/else`, `while`, `for i = a, b, paso`, `for k, v in pairs/ipairs`, `repeat … until`, `function` anónimas / con nombre / `a.b.c` / `a:b`, tablas `{a = 1}` y `{1, 2, 3}`, `~=`, `..`, `and/or/not`, `nil`, `#`, `^`, `a, b = x, y` y `return a, b`. Incluye `table.insert/remove/concat/sort`, `string.format/sub/upper/lower/split/rep` y `os.time`. **Las listas empiezan en 0** (son arreglos de JavaScript).

## API principal

| Ruta | Uso |
|---|---|
| `POST /api/register` | Crear una cuenta y una sesión |
| `POST /api/login` | Iniciar sesión |
| `GET /api/session` | Consultar la cuenta de la sesión actual |
| `POST /api/logout` | Cerrar y revocar la sesión actual |
| `GET /api/maps` | Listar creaciones públicas de la plataforma y contenido privado autorizado |
| `POST /api/maps` | Crear o guardar un juego propio |
| `GET /api/maps/:id/instances` | Ver las instancias activas de un juego autorizado |
| `POST /api/maps/:id/instances` | Crear una instancia de partida nueva |
| `GET /api/videos` | Listar videos públicos y privados autorizados |
| `POST /api/videos` | Crear o actualizar los datos de un video propio |
| `PUT /api/videos/:id/file` | Subir el archivo del video (binario); recién ahí se publica y se avisa a todos |
| `GET /api/videos/:id/stream` | Reproducir un video por streaming con rangos (los privados aceptan `?t=` con la sesión) |
| `GET /api/ice` | Servidores ICE (STUN/TURN) para las llamadas |
| `POST /api/maps/:id/textures` | Subir texturas de un juego propio |
| `GET /api/maps/:id/textures/:tid` | Descargar una textura (con caché) |
| `GET /api/convs/:userId/:convId` | Sincronizar sobres E2EE de una conversación propia |
| `POST /api/convs/:convId` | Guardar y retransmitir un mensaje cifrado |
| `GET /api/e2ee/keys/:id` | Obtener la clave pública de una cuenta |
| `POST /api/e2ee/keys` | Registrar una clave pública y bóveda privada cifrada |
| `GET /api/online` | Personas en línea con el juego e instancia que están jugando (si tenés acceso) |
| `POST /api/join-user/:id` | Obtener el juego e instancia de una persona en línea para unirte a su servidor |
| `GET /status` | Consultar el estado del servidor |

Solo se publican los archivos del cliente (`index.html`, `service-worker.js`, `manifest.webmanifest`, `crix-icon.svg`); el código del servidor ya no se sirve por HTTP. El registro y el login tienen límite de intentos por IP. Las rutas de escritura requieren una sesión Bearer; las operaciones administrativas también comprueban el rol en el servidor.
