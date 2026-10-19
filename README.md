# Crix

Crix es una plataforma web de juegos con cuentas compartidas, publicación de mapas, apps HTML y videos, foros y juego multijugador con Node.js, Express y Socket.IO. La interfaz también se puede instalar como una aplicación web progresiva (PWA).

## Ejecutar localmente

```bash
npm install
npm start
```

Abrí `http://localhost:3000`.

## Cuentas y almacenamiento

Las cuentas se comparten entre dispositivos cuando se conectan al mismo servidor. Las contraseñas se guardan con hash scrypt y la sesión dura 30 días. Las cuentas locales anteriores se pueden migrar iniciando sesión desde el navegador donde están guardadas.

Para habilitar la cuenta administrativa `Crix`, configurá `CRIX_ADMIN_PASSWORD` como secreto del entorno y registrá o iniciá sesión con el nombre `Crix` y esa contraseña. Es necesario configurar el secreto antes de crear la cuenta.

Los datos se guardan en un archivo JSON. `CRIX_DATA_FILE` permite elegir la ruta del archivo; si se omite, Crix usa `crix_data.json` junto al servidor.

En un alojamiento que borra el disco local al reiniciar, montá un volumen persistente y configurá `CRIX_DATA_FILE` dentro de ese volumen. Sin ese volumen, ningún cambio de código puede garantizar que cuentas, juegos o medios sobrevivan al reemplazo del servidor.

## Publicación y privacidad

- Los juegos y mapas son públicos por defecto y se pueden limitar a amigos, usuarios asignados o solo al creador.
- Las apps creadas en Crix se guardan como proyectos HTML y usan los mismos ajustes de privacidad y publicación que los juegos.
- Los videos pueden ser públicos o privados. El video se entrega a través de la API con la misma comprobación de visibilidad que su ficha.
- Las publicaciones del foro y sus imágenes son públicas.
- Los medios que se guardan en el servidor requieren que el alojamiento tenga espacio de disco suficiente y mantenga el volumen persistente.
- Los videos cargados desde la interfaz tienen un límite de 30 MB.
- La foto de perfil se cambia desde el perfil propio. Crix la recorta a 256 × 256, la comprime y la muestra en perfiles públicos y listas de usuarios; se guarda junto a la cuenta en el servidor.

## Editor y scripting

El editor permite elegir **CrixScript** o **JavaScript** y asociar un script a `onStart`, `onUpdate` o `onStop`. Los scripts `onStart` se ejecutan al iniciar un juego; los otros eventos se pueden ejecutar desde el editor. El entorno de ejecución trabaja en un Web Worker y expone una API de lectura básica para `workspace`.

No incluye intérpretes para todos los lenguajes, binario o ensamblador, ni pretende sustituir el motor y las herramientas de Unity o Roblox Studio. Para agregar esos lenguajes hacen falta intérpretes o compiladores específicos y ampliar el motor.

## API principal

| Ruta | Uso |
|---|---|
| `POST /api/register` | Crear una cuenta y una sesión |
| `POST /api/login` | Iniciar sesión |
| `GET /api/session` | Consultar la cuenta de la sesión actual |
| `POST /api/logout` | Cerrar y revocar la sesión actual |
| `GET /api/maps` | Listar juegos visibles para el usuario |
| `POST /api/maps` | Crear o guardar un juego propio |
| `GET /api/videos` | Listar videos visibles para el usuario |
| `POST /api/videos` | Publicar o actualizar un video propio |
| `GET /status` | Consultar el estado del servidor |

Las rutas de escritura requieren una sesión Bearer; las operaciones administrativas también comprueban el rol en el servidor.
