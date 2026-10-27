# Astrix Studio — cuentas, medición UTM, voz, clonación y privacidad

## Arranque

```bash
cd server && npm install && npm start
```

- Abre http://127.0.0.1:8765/ y te llevará al inicio de sesión.
- **Administrador inicial:** el servidor lo crea la primera vez y guarda usuario y contraseña en `server/CREDENCIALES_ADMIN.txt`. Al entrar te pedirá crear tu propia contraseña. Después borra ese archivo.
- **Base de datos:** MariaDB local, base `moho_studio`, con un usuario propio limitado a esa base. La conexión se configura en `server/.env`, junto con las claves de APIs (ver `.env.example`).

## Cuentas (multitenant)

| Rol | Puede |
|---|---|
| Superadmin | Todo, y además crear o desactivar **estudios** (clientes, marcas). Cada estudio está aislado del resto. |
| Propietario / Administrador | Crear usuarios de su estudio, cambiar roles, restablecer contraseñas. |
| Editor | Crear contenido, usar la IA (de pago) y crear enlaces UTM. |
| Solo lectura | Ver el tablero y los enlaces sin gastar en IA. |

- **Contraseñas:** se guardan con scrypt. Las temporales se muestran una sola vez y obligan a cambiarlas al entrar.
- **Sesiones:** cookie `HttpOnly`, válida 14 días. Cambiar la contraseña cierra las demás sesiones.
- **Login:** limitado a 10 intentos cada 15 minutos por IP.
- **Aislamiento:** verificado con dos estudios de prueba. Uno no puede ver ni editar los enlaces del otro.

## Medir videos orgánicos (UTM)

1. Pulsa **Medir** y crea un enlace por video con su plataforma, campaña y contenido.
2. Pon el **enlace corto** (`/r/CODIGO`) en la descripción, la bio o el comentario fijado del video.
3. Cada clic se registra y redirige al destino con `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` y `utm_term`. Así tu analítica web (Google Analytics u otra) atribuye la visita al video.
4. Anota las **vistas** del video y el tablero calcula el **CTR** (clics / vistas).

Qué mide el tablero:
- Clics totales y únicos.
- Clics por día, por plataforma, por dispositivo y por sitio de origen.
- El mejor video.
- Exportación a CSV.

Los bots y las vistas previas de enlaces (WhatsApp, Facebook, Slack…) se excluyen. **No se guardan direcciones IP**: los visitantes únicos se cuentan con un hash que usa una sal diaria aleatoria.

**Importante:** mientras la app solo corra en tu equipo, el enlace corto apunta a `127.0.0.1` y no funciona en redes sociales. Para usarlo de verdad, publica el servidor (con HTTPS) y define `PUBLIC_BASE_URL=https://tu-dominio` en `server/.env`. Hasta entonces puedes usar la "URL con UTM" directa.

## Voz (ElevenLabs)

Pestaña **Voz** del asistente de IA:
- **Narración:** eliges voz, modelo, estabilidad y velocidad.
- **Efectos de sonido:** hasta 30 s, con opción de loop.

El audio se inserta como pista en el frame actual. Requiere `ELEVENLABS_API_KEY` en `server/.env`.

## Clonar video (solo animados)

Pestaña **Clonar video** del asistente:
1. Sube un video o usa el clip seleccionado.
2. Tu navegador extrae 6, 8 o 12 fotogramas.
3. Claude decide si el video es animado. Si es una grabación real, no lo clona y te explica por qué.
4. Si es animado, lo recrea como vectores editables con keyframes que siguen el movimiento medido en los fotogramas, y opcionalmente conserva el audio original.

Pruebas reales con una pelota cartoon:
- Primera versión de las instrucciones: 73 s y $0.31. Copió bien el estilo, pero el movimiento fue mínimo.
- Instrucciones mejoradas: 43 s y $0.21. Reprodujo la subida de ~150 px con squash & stretch.

## Política de archivos: todo se queda en tu equipo

- Videos, imágenes, audio y proyectos **nunca se guardan en el servidor ni en la base de datos**. Viven en tu navegador y se guardan como `.moho` en tu equipo.
- La base de datos solo contiene usuarios, estudios, sesiones y enlaces UTM con sus clics.
- Al **clonar**, el video no sale del navegador. Solo se envían a Claude los fotogramas extraídos:
  - Con Claude Code se escriben en una carpeta temporal que se borra al terminar (verificado). Si el proceso se corta, los restos se borran al reiniciar el servidor.
  - Con la Claude API van solo en memoria.
- Lo que generan ElevenLabs y fal se reenvía en memoria a tu navegador.
- El proveedor de IA que procesa un contenido (Anthropic, fal o ElevenLabs) sí lo recibe. Es inevitable si quieres usar su modelo.

## Notas

- La carpeta del proyecto está en un disco con formato FAT (`/Volumes/NO NAME`), que **no respeta permisos de archivo**. `.env` y `CREDENCIALES_ADMIN.txt` quedan legibles para cualquier usuario del equipo. Para producción, mueve la app a un disco APFS o a un servidor.
- "Moho" sigue apareciendo solo en el formato de archivo `.moho`, por compatibilidad.
