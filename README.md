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

Los datos se guardan en un archivo JSON. `CRIX_DATA_FILE` permite elegir la ruta del archivo; si se omite, Crix usa `crix_data.json` junto al servidor.

En un alojamiento que borra el disco local al reiniciar, montá un volumen persistente y configurá `CRIX_DATA_FILE` dentro de ese volumen. El catálogo y las cuentas se comparten globalmente dentro de la plataforma que use ese almacenamiento y dominio; instalaciones independientes no se sincronizan por arte de magia. Sin almacenamiento persistente, ningún cambio de código puede garantizar que cuentas, juegos o medios sobrevivan al reemplazo del servidor.

## Plataforma global y servidores de juego

La plataforma comparte cuentas, juegos publicados y presencia de amigos. Cada vez que alguien toca **Jugar**, Crix crea una instancia de partida separada con un identificador propio. Los jugadores de una instancia no se mezclan con los de otra. El perfil de un amigo muestra el juego y la instancia pública a la que está conectado; **Unirme a su partida** abre ese juego y conecta a la misma instancia, aunque sea diferente del juego que estabas mirando. En la ficha de un juego también se pueden consultar y abrir otras instancias activas. Las partidas privadas solo revelan su presencia a personas autorizadas.

En esta versión las instancias son salas separadas coordinadas por el proceso Node.js de Crix. No significa que todos jueguen en una sola sala. Para repartir salas entre varias máquinas físicas a gran escala, la plataforma todavía necesita un coordinador compartido y almacenamiento global con soporte para varios procesos; el repositorio no configura esa infraestructura por sí solo.

## Publicación y privacidad

- Los juegos y mapas son públicos por defecto y se pueden limitar a amigos, usuarios asignados o solo al creador. Todo lo público aparece en el catálogo global de Crix para cualquier cuenta, sin importar el país ni la instancia de juego.
- Las apps creadas en Crix se guardan como proyectos HTML y usan los mismos ajustes de privacidad y publicación que los juegos.
- Los videos pueden ser públicos o privados. Cada video público se entrega desde el catálogo global de Crix a cualquier persona, sin requisito de amistad; el video privado se entrega solo tras comprobar permisos.
- El catálogo de juegos muestra las creaciones públicas en páginas sucesivas; el directorio incluye a todos los creadores públicos de Crix. Los videos y publicaciones públicos se consultan desde el mismo catálogo global.
- Las publicaciones del foro y sus imágenes son públicas.
- Los medios que se guardan en el servidor requieren que el alojamiento tenga espacio de disco suficiente y mantenga el volumen persistente.
- Los videos cargados desde la interfaz tienen un límite de 30 MB.
- La foto de perfil se cambia desde el perfil propio. Crix la recorta a 256 × 256, la comprime y la muestra en perfiles públicos y listas de usuarios; se guarda junto a la cuenta en el servidor.

## Chat privado E2EE

Los mensajes, audios y adjuntos nuevos se cifran en el navegador con ECDH P-256, HKDF-SHA-256 y AES-GCM-256 antes de enviarse. El servidor guarda y retransmite los sobres cifrados; el tipo y el contenido del mensaje no quedan guardados como texto plano. El servidor aún ve quién escribe a quién y cuándo. La clave privada de cada cuenta se cifra con una clave derivada de su contraseña (PBKDF2-SHA-256) y se almacena en una bóveda cifrada para permitir el acceso desde otros dispositivos. El navegador desbloquea la clave con la contraseña al iniciar sesión; una sesión restaurada puede pedirla al abrir el chat. La huella de la clave pública del contacto queda fijada en ese dispositivo; si cambia, Crix avisa antes de permitir leer o enviar.

Las conversaciones se pueden iniciar con cualquier cuenta de la instancia, sin solicitud de amistad. Ambas cuentas deben iniciar sesión una vez con esta versión para crear sus claves. Si se pierde la contraseña, no hay recuperación de la clave privada ni de los mensajes E2EE. Los mensajes anteriores a esta versión estaban en texto plano y se eliminan al actualizar; no pueden convertirse retroactivamente en E2EE. El servidor conserva el historial cifrado mientras el almacenamiento persistente tenga espacio disponible. Los adjuntos del chat tienen un límite de 10 MB. Las llamadas que muestra la interfaz siguen siendo una simulación y no se incluyen en este cifrado de mensajes.

Crix no agrega filtros de moderación de contenido. La privacidad de las publicaciones y el aislamiento técnico de scripts del editor siguen aplicándose.

## Crix Hub y scripting

**Crix Hub** incluye una escena 3D con Explorer filtrable, inspector de propiedades, selección, movimiento, rotación, escala, ajuste a cuadrícula, historial de deshacer/rehacer, atajos, duplicación, guardado y prueba del juego con retorno directo al editor. También permite importar geometría `.obj` (hasta 2 MB y 60.000 vértices expandidos); la geometría se guarda dentro del proyecto. Los materiales y texturas externos del OBJ no se importan.

El lenguaje con ejecución completa es **JavaScript**. En el modo **Probar** del editor, los scripts corren en un Web Worker local. En una partida publicada, los `Script` corren una sola vez por instancia en `script-runner.js`, un proceso aparte con un isolate de V8; los `LocalScript` siguen corriendo en cada navegador. `onStart(player, players)` inicia el script, `onUpdate(dt, player, players)` corre hasta 20 veces por segundo mientras hay jugadores y `onStop(player, players)` se llama al cerrar la instancia. Los cambios de mundo del servidor se validan, se replican a todos los jugadores de esa instancia y se envían como estado inicial a quienes entran más tarde. Partidas distintas mantienen estados distintos. `ModuleScript` se carga con `require("Nombre")` o `require("id")`; `task.wait(segundos)` y `task.delay(segundos, fn)` permiten programar trabajo dentro del ciclo del servidor.

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

**Límites actuales:** JavaScript es el lenguaje con soporte completo. CrixScript conserva una conversión básica de sintaxis tipo Lua; no es un intérprete completo. Los `Script` sí se ejecutan en el servidor y replican el mundo de su instancia; `LocalScript` es local. `ServerScriptService` y `LocalScriptService` distinguen el tipo de ejecución, aunque la jerarquía de servicios todavía es básica. `isolated-vm` limita memoria y tiempo, pero ejecutar código público requiere mantener Node y el módulo nativo actualizados; para alojar scripts de personas desconocidas a gran escala conviene correr `script-runner.js` en un contenedor sin privilegios separado del servidor web. Esto todavía no incluye todas las capacidades de Roblox Studio o Unity, ni intérpretes para todos los lenguajes, binario o ensamblador.

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
| `POST /api/videos` | Publicar o actualizar un video propio |
| `GET /api/convs/:userId/:convId` | Sincronizar sobres E2EE de una conversación propia |
| `POST /api/convs/:convId` | Guardar y retransmitir un mensaje cifrado |
| `GET /api/e2ee/keys/:id` | Obtener la clave pública de una cuenta |
| `POST /api/e2ee/keys` | Registrar una clave pública y bóveda privada cifrada |
| `GET /status` | Consultar el estado del servidor |

Las rutas de escritura requieren una sesión Bearer; las operaciones administrativas también comprueban el rol en el servidor.
