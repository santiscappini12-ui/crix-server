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

## Llamadas de voz y video

Desde cualquier conversación se puede iniciar una **llamada de voz** o una **videollamada** con WebRTC real: se ve quién llama, se acepta o rechaza, hay timbre, silenciar micrófono, apagar cámara, cronómetro y avisos claros (rechazada, ocupado, sin respuesta, se cortó la conexión, falta el permiso del micrófono o la cámara). El audio y el video viajan directo entre las dos personas con cifrado DTLS-SRTP; el servidor solo retransmite la negociación (SDP e ICE) y lleva el estado de la llamada, y comprueba que quien envía señales sea realmente parte de una llamada aceptada.

Por defecto se usan servidores STUN públicos de Google, que alcanzan para la mayoría de las redes. Detrás de redes muy restrictivas (NAT simétrico, algunas redes móviles o corporativas) hace falta un servidor **TURN**: configuralo con las variables de entorno `CRIX_TURN_URL` (una o varias URL separadas por coma, por ejemplo `turn:turn.midominio.com:3478`), `CRIX_TURN_USER` y `CRIX_TURN_PASS`; los clientes lo reciben desde `GET /api/ice`. Las llamadas requieren HTTPS (o `localhost`) para que el navegador permita el micrófono y la cámara.

## Chat privado E2EE

Los mensajes, audios y adjuntos nuevos se cifran en el navegador con ECDH P-256, HKDF-SHA-256 y AES-GCM-256 antes de enviarse. El servidor guarda y retransmite los sobres cifrados; el tipo y el contenido del mensaje no quedan guardados como texto plano. El servidor aún ve quién escribe a quién y cuándo. La clave privada de cada cuenta se cifra con una clave derivada de su contraseña (PBKDF2-SHA-256) y se almacena en una bóveda cifrada para permitir el acceso desde otros dispositivos. El navegador desbloquea la clave con la contraseña al iniciar sesión; una sesión restaurada puede pedirla al abrir el chat. La huella de la clave pública del contacto queda fijada en ese dispositivo; si cambia, Crix avisa antes de permitir leer o enviar.

Las conversaciones se pueden iniciar con cualquier cuenta de la instancia, sin solicitud de amistad. Ambas cuentas deben iniciar sesión una vez con esta versión para crear sus claves. Si se pierde la contraseña, no hay recuperación de la clave privada ni de los mensajes E2EE. Los mensajes anteriores a esta versión estaban en texto plano y se eliminan al actualizar; no pueden convertirse retroactivamente en E2EE. El servidor conserva el historial cifrado mientras el almacenamiento persistente tenga espacio disponible. Los adjuntos del chat tienen un límite de 10 MB. Las llamadas que muestra la interfaz siguen siendo una simulación y no se incluyen en este cifrado de mensajes.

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

**Límites actuales:** JavaScript es el lenguaje con soporte completo. CrixScript conserva una conversión básica de sintaxis tipo Lua; no es un intérprete completo. Los `Script` sí se ejecutan en el servidor y replican el mundo de su instancia; `LocalScript` es local, por lo que el estado que crean (GUI, monedas, piezas creadas por un LocalScript) es de cada jugador y no se comparte con los demás. Todavía no hay `RemoteEvent` reales entre cliente y servidor, almacenamiento persistente por jugador (DataStore), sonido ni animaciones personalizadas; los elementos *Sound*, *Bloom*, *Blur* y *SunRays* del Explorador son marcadores. `ServerScriptService` y `LocalScriptService` distinguen el tipo de ejecución, aunque la jerarquía de servicios todavía es básica. `isolated-vm` limita memoria y tiempo, pero ejecutar código público requiere mantener Node y el módulo nativo actualizados; para alojar scripts de personas desconocidas a gran escala conviene correr `script-runner.js` en un contenedor sin privilegios separado del servidor web. Esto todavía no incluye todas las capacidades de Roblox Studio o Unity, ni intérpretes para todos los lenguajes, binario o ensamblador.

Los NPC incluidos se construyen como humanoides 3D con articulaciones básicas y animación procedural; todavía no hay editor de rigging, huesos ni animación.

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
