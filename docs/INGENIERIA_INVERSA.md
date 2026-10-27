# Moho 14 → Astrix Studio: ingeniería inversa y reconstrucción

## 1. Qué es el programa (observado)

| Elemento | Hallazgo |
|---|---|
| `Moho.exe` | PE32+ x86-64 (amd64), 14.6 MB, sha256 `4d4b4ed9…506ef5`. Es Moho 14 (Smith Micro / Lost Marble), un programa de animación 2D con huesos. |
| Render | `OPENGL32`/`GLU32` (vista de trabajo) + `skia.dll` (rasterizado vectorial, 106 funciones importadas) |
| Video/audio | FFmpeg 7 (`avcodec-61`, `avformat-61`, `avutil-59`, `swscale-8`, `swresample-5`) y `libsndfile` |
| Imágenes | `FreeImage.dll` |
| 3D | `libfbxsdk.dll` (importación FBX) |
| Actualizaciones | `WinSparkle.dll` + `WINHTTP` |
| Licencia | `ShaferFilechck.DLL`, `lm-external-libs.dll`, `WINTRUST`, `NETAPI32` |
| Scripting | Lua embebido: 138 scripts en `Resources/Support/Scripts`; todas las herramientas (`lm_*.lua`) están escritas en Lua sobre la API `MOHO.*` |
| Lip-sync | `Resources/Rhubarb` (Rhubarb Lip Sync) |
| Idiomas | `Resources/Strings/Strings.XX.txt` (15 idiomas) |

Evidencia REA: `inspect_pe_imports` → `ev_7fdb694e…0740e` (29 DLLs importadas).

**Límite:** esta Mac no tiene Ghidra, IDA ni Hopper configurados en REA, así que **el código máquina no se descompiló**. La reconstrucción se basa en el formato de archivo, las cadenas del ejecutable, los scripts Lua y la comparación visual con las miniaturas que trae cada `.moho`.

## 2. Formato `.moho` (observado)

- Es un **ZIP** con `Project.mohoproj` (JSON, UTF-8) y `preview.jpg`.
- El formato antiguo `.anme` (Moho ≤ 12) es texto plano (`version 37`, bloques `style`, `layer`…).
- Raíz del JSON: `mime_type: application/x-vnd.lm_mohodoc`, `version: 1040`, `project_data` (tamaño, fps, rango de frames, fondo), `styles`, `animated_values` (cámara), `layers`.

### Canal animado (todas las propiedades animables)
```json
{ "type": "Vec2", "when": [0, 12], "val": [{...}, {...}], "interp": [{ "im": 1, "v1": 0.1, "v2": 0.5 }, ...] }
```
`type` ∈ Val, Vec2, Vec3, Color, Bool, String. **Frame 0 es la pose de reposo**; la animación empieza en `start_frame`.

### Códigos de interpolación `im`
Los nombres se extrajeron de las cadenas de `Moho.exe` (orden de registro en Lua):
0 smooth, 1 linear, 2 ease, 3 step, 4 noisy, 5 cycle, 6 pose, 7 ease in, 8 ease out, 9 bezier, 10 elastic, 11 bounce.
- `cycle`: `v1` = cuántos frames vuelve atrás (relativo). En `Dragon.moho`, con el key en 33 y `v1 = 31`, el ciclo cierra exacto con periodo `v1 + 1`.
- `bezier`: trae `b: [{ao, ai, po, pi}]` (ángulo y proporción de los manejadores por componente).

### Capas
Tipos encontrados en los 260 ejemplos: MeshLayer 5510, GroupLayer 1054, ImageLayer 965, BoneLayer 399, SwitchLayer 177, ParticleLayer 59, TextLayer 20, PatchLayer 18, Mesh3DLayer 6, NoteLayer 2, AudioLayer 2.
- El orden de `layers` va **de abajo hacia arriba**: el primer elemento se dibuja primero.
- `transforms`: translation (Vec3), scale, rotation_x/y/z, flip_h/v; `origin` es el pivote.
- `parent_bone ≥ 0` ata toda la capa a un hueso. `flexi_bone_subset: "3|4|5"` limita qué huesos deforman la capa.
- `SwitchLayer.switch_keys`: canal String con el nombre del hijo visible.
- `ImageLayer.image_path`: archivo externo (no va dentro del `.moho`).

### Malla vectorial (`mesh`)
- `points[]`: `position` (Vec2 animado), `width`, `parent` (índice del hueso: ≥ 0 atado al hueso, −2 = flexi).
- `curves[]`: `closed` y `points[]` con `{point, smoothness, weight_in/out, offset_in/out, segments_on}`. `smoothness` vale 0 en las esquinas (peaked) y ~0.3 en las curvas suaves.
- `shapes[]`: `edges {curve[], segment[], flag[]}`, es decir, una lista de segmentos de curva que cierran el contorno. Lleva `has_fill`, `has_outline` y `style` (`fill_color`, `line_color`, `line_width`).
- Los estilos heredados se referencian por `inherited_style_name` (≤ 13) o por `inherited_style_uuid` (13.5+).
- `line_width` está en fracción de la altura del documento (0.005556 × 720 = 4 px).

### Huesos (`skeleton.bones[]`)
- `parent`, `length`, `strength`, `anim_pos`, `anim_angle` (radianes), `anim_scale`, restricciones, físicas e IK.
- Se verificó que la `anim_pos` de cada hijo ≈ (largo del padre, 0), así que **cada hueso vive en el marco local de su padre**, con el largo sobre +X.

### Cámara
`camera_track.z = 3.732051` (= cot 15°) y `camera_zoom = 2`. De ahí: FOV vertical = 60°/zoom, y la vista va de y = −1 a y = +1 en unidades del documento.

### Efectos, audio y video (observado)
- `layer_effects`: canales animables `visibility` (Bool), `alpha`, `blur`, `ambient_occlusion`, `threshold`, `noise` y `pixelation`.
- `blend_mode`: los nombres `BM_NORMAL`, `MULTIPLY`, `SCREEN`, `OVERLAY`, `ADD`, `HUE`, `DIFFERENCE`, `SATURATION`, `COLOR`, `LUMINOSITY`, `SOFT_LIGHT`, `COLOR_DODGE`, `LINEAR_DODGE` y `COLOR_BURN` salen de las cadenas del exe. El número que corresponde a cada modo es inferido.
- `AudioLayer`: `audio_path` / `audio_fileref`, `audio_level` (canal animable), `audio_jump` y `spatial_positioning`.
- El video se guarda como `ImageLayer` con `image_path` a un archivo .mov/.mp4, más `interpreted_fps`, `movie_looping`, `reverse_movie` y `persist_first/last_frame`.
- `timing_offset`: desfase de tiempo por capa.

## 3. Lo que es inferencia (no confirmado contra el binario)
- La fórmula exacta de los manejadores Bézier a partir de `smoothness`, `weight` y `offset`.
- El reparto de pesos del *flexi-binding* (se usa fuerza / distancia⁴ al hueso en reposo).
- La interpolación `bezier` se aproxima con Catmull-Rom, y `noisy` como lineal.
- Que `timing_offset` resta frames al tiempo de la capa (y por tanto a su canal `visibility`).
- La correspondencia entre el número de `blend_mode` y cada modo de fusión.

## 4. Qué reconstruye Astrix Studio
- Abre `.moho` (ZIP+JSON) y `.mohoproj`, ya sea arrastrándolos o desde la lista de ejemplos oficiales.
- Renderiza mallas, curvas, formas, estilos y estilos heredados, grupos, switch, cámara con perspectiva por z, y marcos para las imágenes.
- Deforma con huesos (atado de puntos, atado de capa y flexi).
- Reproduce la animación con todos los tipos de interpolación y con ciclos.
- Edición: mover puntos, rotar/mover huesos, crear huesos, rectángulos y elipses, grupos y capas de huesos, renombrar, ocultar y borrar. Cada cambio genera un keyframe automático en el frame actual. También permite cambiar la interpolación, borrar keys y deshacer/rehacer.
- Guarda `.moho` compatible (ZIP con `Project.mohoproj` y `preview.jpg`) y exporta PNG y video WebM.

### Edición de video
- **Pistas**: cada capa se muestra como un clip. Puedes arrastrarlo para moverlo en el tiempo (usa `timing_offset`) y recortar sus bordes de entrada y salida (usa `layer_effects.visibility`).
- **Cortar** (Cmd/Ctrl+B) parte el clip en el cabezal.
- **Fundidos** de entrada y salida mediante keys de `layer_effects.alpha`.
- **Medios**: importa video, audio e imágenes. Al importar un video, su audio se separa en su propia capa, y el audio muestra su forma de onda en la pista.
- **Exportación** MP4 (o WebM) con audio mezclado.
- **Efectos por capa**: opacidad, desenfoque y modos de fusión, más ajustes de color (brillo, contraste, saturación, tono, B/N, sepia, invertir).
- **Formatos de documento** predefinidos: HD, Full HD, 4K, vertical y cuadrado.

### Herramientas tipo Illustrator
- **Pluma** (P): clic crea una esquina, arrastrar crea una curva, clic en el primer punto cierra la forma y Enter la termina abierta.
- **Lápiz** (N): mano alzada simplificada con Douglas-Peucker y detección de esquinas.
- **Selección de puntos**: por área (arrastrando en vacío), con caja de transformación para escalar (Shift = proporcional) y rotar (Shift = pasos de 15°). Los puntos se pueden convertir entre esquina y suave, borrar (Supr) o seleccionar todos (Cmd/Ctrl+A).
- **Estilo**: relleno y trazo (color, opacidad, grosor, activar/desactivar), aplicado a las formas de los puntos seleccionados.
- **Importar SVG** (Illustrator, Inkscape, Figma): trazados, rectángulos, círculos, polígonos y líneas, con transformaciones, subtrazados y huecos. Los degradados se convierten al color del primer stop.
- **Exportar SVG** vectorial del frame actual.
- **Transformar capa** (M): arrastrar mueve, Shift rota y Alt escala, con keyframes.
- **Otros**: papel cebolla, duplicar, copiar y pegar capas (Cmd/Ctrl+D, C, V), y subir o bajar capas.

### Extensiones propias de la web (no son de Moho)
- `layer.web_adjust`: canales de ajuste de color. Moho de escritorio probablemente los ignore.
- Los medios importados se guardan dentro del `.moho`, en `media/…`. Moho de escritorio busca esos archivos junto al proyecto, así que habría que extraerlos para usarlos allí.

## 5. Lo que falta
- Acciones y smart bones, IK, físicas y dinámica de huesos.
- Pinceles y texturas, sombras y efectos de capa, máscaras, modos de mezcla.
- Partículas, texto y lip-sync.
- Leer el formato `.anme` antiguo.
- Las imágenes externas de los ejemplos (PSD, por ejemplo) no vienen dentro del `.moho`. Las PNG/JPG se cargan si están junto al archivo.
- Video en ProRes (.mov de Moho) depende de que el navegador pueda decodificarlo.
- Un `.moho` creado desde cero en la web no se ha probado en Moho de escritorio.
