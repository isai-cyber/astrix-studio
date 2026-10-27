# ✨ Generar con IA (estilo Firefly)

Botón **✨ Generar IA** (o tecla `G`). El navegador nunca ve tus claves: todo pasa por el servidor local `server/server.mjs`.

## Arrancar

```bash
cd server && npm install
cd server && npm install && npm start
```

Luego abre http://127.0.0.1:8765/

## Motores

| Motor | Para qué | Configuración |
|---|---|---|
| **Claude Code** (por defecto) | SVG, animaciones y "Animar capas" | El CLI `claude` con sesión iniciada (`claude auth login`). Se ejecuta en modo headless (`claude -p`), sin herramientas, salvo `Read` cuando adjuntas imágenes de referencia, y siempre dentro de una carpeta temporal. |
| **Claude API** | Lo mismo, vía SDK oficial (`claude-opus-5-5`, con fallback automático) | `ANTHROPIC_API_KEY` en `server/.env` |
| **fal.ai** | Video (Seedance 2.0 / 2.0 Fast / 1.0 Pro), imagen (FLUX schnell), vector (Recraft V3), o **cualquier otro modelo** escribiendo su ID | `FAL_KEY` en `server/.env` |

Copia `server/.env.example` como `server/.env` y rellena lo que uses.

## Modos

- **Vector SVG**: Claude dibuja un SVG con las partes agrupadas en `<g id>`. Al insertarlo, cada grupo se convierte en una capa de grupo de Moho con su pivote, así puedes animarla o atarla a huesos. Tiene estilos (plano, línea, cartoon, isométrico, logo, infantil) y de 1 a 4 variaciones en paralelo.
- **Animación**: Claude devuelve un SVG más keyframes por parte (posición, rotación, escala, squash/stretch, opacidad, curvas de easing y pivote). Se convierten en canales nativos de Moho. Las animaciones en loop usan la interpolación *cycle* de Moho.
- **Animar capas**: describe un movimiento y Claude anima capas que ya existen en el documento, usando sus nombres y cajas.
- **Imagen / Video** (fal.ai): de texto a video, o de imagen a video tomando el frame actual u otro archivo como primer fotograma (y un segundo archivo como fotograma final). El resultado entra como clip en la línea de tiempo, con su audio en una pista aparte.
- **Referencias multimodales**: con "📷 Frame actual" o "🖼 Archivo" puedes adjuntar imágenes. Claude las recibe como entrada visual y fal como `image_url` / `end_image_url`.
- **Parámetros avanzados**: un JSON que se mezcla con la entrada del modelo de fal (`seed`, etc.).

## Costos y tiempos (medidos con Claude Code)

- SVG de un cohete: 85 s, $0.40.
- Animación de 8 partes y 72 frames: 305 s, $1.47. Esa prueba se hizo antes de añadir el selector de **Calidad**; ahora "Normal" usa esfuerzo medio y "Rápida" esfuerzo bajo, que gastan menos tokens.
- fal.ai cobra por segundo de video según el modelo.

## Seguridad

- El servidor solo escucha en `127.0.0.1`.
- Las rutas `/api` exigen la cabecera `x-moho-web` y que el origen sea local, así que otras webs no pueden usar tu backend.
- `/api/fetch` solo descarga desde dominios de fal.
- `.env` y `node_modules` no se sirven nunca.
