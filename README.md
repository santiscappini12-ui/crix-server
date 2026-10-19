# Crix

Crix es una plataforma web social de juegos y creación con cuentas compartidas, publicación de mapas, apps HTML y videos, foros y juego multijugador con Node.js, Express y Socket.IO. La interfaz también se puede instalar como una aplicación web progresiva (PWA).

## Ejecutar localmente

```bash
npm install
npm start
```

Abrí `http://localhost:3000`.

## Cuentas y almacenamiento

Las cuentas se comparten entre dispositivos cuando se conectan al mismo servidor público de Crix. Las contraseñas se guardan con hash scrypt y la sesión dura 30 días. Las cuentas locales anteriores se pueden migrar iniciando sesión desde el navegador donde están guardadas.

Para habilitar la cuenta administrativa `Crix`, configurá `CRIX_ADMIN_PASSWORD` como secreto del entorno y registrá o iniciá sesión con el nombre `Crix` y esa contraseña. Es necesario configurar el secreto antes de crear la cuenta.

Los datos se guardan en un archivo JSON. `CRIX_DATA_FILE` permite elegir la ruta del archivo; si se omite, Crix usa `crix_data.json` junto al servidor.

En un alojamiento que borra el disco local al reiniciar, montá un volumen persistente y configurá `CRIX_DATA_FILE` dentro de ese volumen. Todos los usuarios que visiten el mismo dominio de Crix comparten el catálogo público; no se replica automáticamente entre instalaciones o dominios independientes. Sin almacenamiento persistente, ningún cambio de código puede garantizar que cuentas, juegos o medios sobrevivan al reemplazo del servidor.

## Publicación y privacidad

- Los juegos y mapas son públicos por defecto y se pueden limitar a amigos, usuarios asignados o solo al creador.
- Las apps creadas en Crix se guardan como proyectos HTML y usan los mismos ajustes de privacidad y publicación que los juegos.
- Los videos pueden ser públicos o privados. El video se entrega a través de la API con la misma comprobación de visibilidad que su ficha.
- El catálogo de juegos muestra las creaciones públicas en páginas sucesivas; el directorio incluye a todos los creadores públicos de la instancia. Los videos y publicaciones públicas se consultan desde el mismo catálogo central.
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

Los NPC incluidos ahora se construyen como humanoides 3D con articulaciones básicas y animación procedural. Esto no equivale a un sistema completo de huesos, rigging ni editor de animación.

El editor de código permite **CrixScript** o **JavaScript**, con eventos `onStart`, `onUpdate` y `onStop`. `onStart` se ejecuta cuando empieza el juego; los otros eventos se ejecutan manualmente desde el editor. Los scripts se aíslan en un Web Worker y exponen una API de lectura básica para `workspace`.

Crix Hub amplía el editor propio de Crix; todavía no reemplaza Roblox Studio o Unity. No incluye todos sus motores de física, rigging, animación, formatos 3D ni intérpretes para otros lenguajes, binario o ensamblador.

## API principal

| Ruta | Uso |
|---|---|
| `POST /api/register` | Crear una cuenta y una sesión |
| `POST /api/login` | Iniciar sesión |
| `GET /api/session` | Consultar la cuenta de la sesión actual |
| `POST /api/logout` | Cerrar y revocar la sesión actual |
| `GET /api/maps` | Listar creaciones públicas y contenido privado autorizado |
| `POST /api/maps` | Crear o guardar un juego propio |
| `GET /api/videos` | Listar videos públicos y privados autorizados |
| `POST /api/videos` | Publicar o actualizar un video propio |
| `GET /api/convs/:userId/:convId` | Sincronizar sobres E2EE de una conversación propia |
| `POST /api/convs/:convId` | Guardar y retransmitir un mensaje cifrado |
| `GET /api/e2ee/keys/:id` | Obtener la clave pública de una cuenta |
| `POST /api/e2ee/keys` | Registrar una clave pública y bóveda privada cifrada |
| `GET /status` | Consultar el estado del servidor |

Las rutas de escritura requieren una sesión Bearer; las operaciones administrativas también comprueban el rol en el servidor.
