// Panel "Generar con IA" (estilo Adobe Firefly).
// Backends (vía server/server.mjs): Claude Code (CLI), Claude API (SDK) y fal.ai (Seedance, Flux, Recraft…).
import { svgImport } from './svg.js';
import { makeChannel, setKey, INTERP } from './anim.js';
import { ensureEffects } from './clips.js';
import { icon } from './icons.js';

const API_HEADERS = { 'content-type': 'application/json', 'x-moho-web': '1' };
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: API_HEADERS, body: JSON.stringify(body) } : { headers: { 'x-moho-web': '1' } });
  let j; try { j = await r.json(); } catch { j = { error: `Respuesta no válida (${r.status})` }; }
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

// ---------------- Prompts ----------------
const SVG_RULES = (W, H) => `Reglas del SVG (el resultado se convierte en capas vectoriales editables de Moho):
- viewBox="0 0 ${W} ${H}" y width="${W}" height="${H}" exactamente.
- Usa solo <g>, <path>, <rect>, <circle>, <ellipse>, <polygon>, <polyline> y <line>, con atributos de presentación en línea (fill, stroke, stroke-width, opacity, transform).
- Nada de <text> (convierte letras a trazados si hacen falta), <image>, <filter>, <clipPath>, <mask>, <style> ni clases CSS.
- Los degradados se aplanan al primer color: prefiere colores planos y resuelve luces y sombras con formas separadas.
- Agrupa cada parte lógica en <g id="nombre_en_snake_case"> (por ejemplo cuerpo, cabeza, brazo_izq, antebrazo_izq, rueda_delantera) y anida los grupos según la jerarquía física, para que cada parte pueda animarse por separado.
- El orden importa: lo primero que escribes queda al fondo.`;

const STYLES = {
  plano: 'ilustración plana moderna, formas geométricas limpias, paleta armoniosa de 5-7 colores',
  linea: 'line art con trazo uniforme negro y rellenos planos suaves',
  cartoon: 'personaje cartoon expresivo estilo animación 2D, contornos marcados',
  isometrico: 'ilustración isométrica con tres tonos por cara',
  logo: 'logotipo/icono minimalista, pocos elementos, alto contraste',
  infantil: 'estilo libro infantil, formas redondeadas, colores cálidos',
};

function svgSystem(W, H, style) {
  return `Eres un ilustrador vectorial experto que dibuja para un estudio de animación 2D.
Responde ÚNICAMENTE con el código SVG completo (empieza con <svg y termina con </svg>), sin markdown ni explicaciones.
Estilo: ${style}.
${SVG_RULES(W, H)}`;
}

function animSystem(W, H, fps, maxFrames, style) {
  return `Eres un director de animación 2D y diseñador vectorial. Creas animaciones para Astrix Studio: un SVG con partes agrupadas más keyframes por parte.
Responde ÚNICAMENTE con un objeto JSON válido (sin markdown, sin comentarios) con esta forma:
{"title": "texto corto", "duration": <frames>, "loop": true|false,
 "svg": "<svg ...>…</svg>",
 "animations": [
   {"target": "<id de un <g> del svg>", "pivot": [x, y],
    "keys": [{"frame": 1, "x": 0, "y": 0, "rotate": 0, "sx": 1, "sy": 1, "opacity": 1, "ease": "smooth"}]}
 ]}
Detalles:
- fps = ${fps}. Los frames van de 1 a "duration" (máximo ${maxFrames}).
- x, y: desplazamiento en píxeles del viewBox respecto a como está dibujada la parte (y positiva hacia abajo). rotate: grados, positivo en sentido horario (como en SVG). sx, sy: escala. opacity: 0 a 1. Omite las propiedades que no cambian.
- pivot: punto del viewBox sobre el que rota y escala la parte (el hombro para un brazo, el eje para una rueda, la base para una planta).
- ease ∈ smooth, linear, ease, ease_in, ease_out, step, bounce, elastic. Se aplica al tramo que empieza en ese key.
- Si loop es true, el último key de cada parte debe ser igual al primero.
- Aplica principios de animación: anticipación, arcos, acción superpuesta, squash & stretch (sx/sy), y timing con ritmo.
- Los grupos anidados heredan el movimiento del grupo padre (un antebrazo dentro del brazo).
Estilo visual: ${style}.
${SVG_RULES(W, H)}`;
}

function animateExistingSystem(W, H, fps, maxFrames) {
  return `Eres un director de animación 2D. Animas capas que ya existen en un documento de Astrix Studio (${W}x${H} px, ${fps} fps).
Responde ÚNICAMENTE con un objeto JSON válido (sin markdown):
{"duration": <frames ≤ ${maxFrames}>, "loop": true|false,
 "animations": [{"target": "<nombre exacto de la capa>", "pivot": [x, y],
   "keys": [{"frame": 1, "x": 0, "y": 0, "rotate": 0, "sx": 1, "sy": 1, "opacity": 1, "ease": "smooth"}]}]}
- Coordenadas en píxeles del documento: (0,0) arriba a la izquierda, y hacia abajo.
- x, y: desplazamiento respecto a la posición actual. rotate: grados en sentido horario. pivot: punto de giro en píxeles del documento.
- ease ∈ smooth, linear, ease, ease_in, ease_out, step, bounce, elastic.
- Si loop es true, el último key debe igualar al primero. Usa anticipación, arcos y acción superpuesta.`;
}

function cloneSystem(W, H, fps, maxFrames, frameTimes) {
  return `Eres un animador 2D experto en recrear animaciones a partir de referencias.
Recibes ${frameTimes.length} fotogramas de un video, en orden, tomados en los segundos: ${frameTimes.map((t) => t.toFixed(2)).join(', ')}.
PASO 1 — Clasifica el video:
- ANIMADO: dibujos animados 2D, motion graphics, ilustración animada, animación 3D estilizada, stop motion, pixel art, explicativos animados.
- NO ANIMADO: grabación real con cámara (personas, lugares, productos reales), screencast, presentación estática.
Si NO es animado, responde ÚNICAMENTE: {"animated": false, "kind": "tipo detectado", "reason": "una frase"}
PASO 2 — Si ES animado, recréalo como animación vectorial original: mismo estilo, paleta, composición y tipo de personajes/objetos.
PASO 3 — Reproduce el MOVIMIENTO medido, no uno inventado:
- Dibuja el SVG con cada parte en su posición del PRIMER fotograma.
- Para cada parte que se mueve, mide en cada fotograma su posición (centro), rotación y escala/deformación, convertidas a píxeles del viewBox.
- Crea un keyframe por fotograma en frame = round(segundo × fps) + 1, con x/y = desplazamiento respecto al primer fotograma (y positiva hacia abajo), rotate, sx/sy (squash & stretch si la forma se aplasta o estira).
- Si el movimiento es cíclico (rebote, caminata, parpadeo), detecta el periodo, completa los tramos entre fotogramas con keys intermedios coherentes (p. ej. contacto con el suelo, punto más alto) y marca loop: true.
- Usa ease_in al caer, ease_out al subir y step para cambios instantáneos.
No copies logotipos ni marcas registradas; si aparecen, sustitúyelos por formas genéricas.
Añade al JSON los campos "animated": true y "kind".
` + animSystem(W, H, fps, maxFrames, 'el mismo estilo visual de los fotogramas de referencia');
}

const EASE = { smooth: INTERP.SMOOTH, linear: INTERP.LINEAR, ease: INTERP.EASE, ease_in: INTERP.EASE_IN, ease_out: INTERP.EASE_OUT, step: INTERP.STEP, bounce: INTERP.BOUNCE, elastic: INTERP.ELASTIC };

function extractSvg(text) {
  const m = /<svg[\s\S]*<\/svg>/i.exec(text || '');
  if (!m) throw new Error('La respuesta no contiene un SVG');
  return m[0];
}
function extractJson(text) {
  const t = (text || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('La respuesta no contiene JSON');
  return JSON.parse(t.slice(a, b + 1));
}

// ---------------- Conversión: animación JSON -> canales de Moho ----------------
// Las claves se aplican sobre la transformación actual de la capa (posición/rotación/escala de reposo).
export function applyAnimation(layer, anim, { pxToUnits, pivotToLocal, frameOffset = 0, loop = false }) {
  const t = layer.transforms;
  if (!t) return;
  const base = {
    tr: t.translation.val[0] || { x: 0, y: 0, z: 0 },
    rz: t.rotation_z.val[0] || 0,
    sc: t.scale.val[0] || { x: 1, y: 1, z: 1 },
  };
  if (anim.pivot && pivotToLocal) {
    const [ox, oy] = pivotToLocal(anim.pivot[0], anim.pivot[1]);
    layer.origin = { x: ox, y: oy };
  }
  const keys = [...(anim.keys || [])].filter((k) => Number.isFinite(k.frame)).sort((a, b) => a.frame - b.frame);
  if (!keys.length) return;
  const has = (p) => keys.some((k) => k[p] !== undefined);
  const chans = [];
  if (has('x') || has('y')) chans.push([t.translation, (k) => ({ x: base.tr.x + (k.x || 0) * pxToUnits, y: base.tr.y - (k.y || 0) * pxToUnits, z: base.tr.z || 0 })]);
  if (has('rotate')) chans.push([t.rotation_z, (k) => base.rz - (k.rotate || 0) * Math.PI / 180]);
  if (has('scale') || has('sx') || has('sy')) chans.push([t.scale, (k) => ({ x: base.sc.x * (k.sx ?? k.scale ?? 1), y: base.sc.y * (k.sy ?? k.scale ?? 1), z: base.sc.z ?? 1 })]);
  if (has('opacity')) chans.push([ensureEffects(layer).alpha, (k) => Math.max(0, Math.min(1, k.opacity ?? 1))]);
  // Rellena huecos: cada key hereda las propiedades no indicadas del key anterior.
  let last = {};
  const filled = keys.map((k) => (last = { ...last, ...k }));
  for (const [ch, val] of chans) {
    ch.when = [0]; ch.val = [val(filled[0])]; ch.interp = [{ im: INTERP.LINEAR, v1: 0.1, v2: 0.5, in: 1, h: 0, s: false, t: 0 }];
    for (const k of filled) {
      const f = Math.max(1, Math.round(k.frame) + frameOffset);
      setKey(ch, f, val(k));
      ch.interp[ch.when.indexOf(f)] = { im: EASE[k.ease] ?? INTERP.SMOOTH, v1: 0.1, v2: 0.5, in: 1, h: 0, s: false, t: 0 };
    }
    // Loop: el último key cicla de vuelta al primero (interpolación "cycle" nativa de Moho).
    const n = ch.when.length;
    if (loop && n > 2) {
      const span = ch.when[n - 1] - ch.when[1];
      if (span > 1) ch.interp[n - 1] = { im: INTERP.CYCLE, v1: span - 1, v2: -1, in: 1, h: 0, s: false, t: 0 };
    }
  }
}

// ---------------- Panel ----------------
const FAL_VIDEO_MODELS = [
  ['bytedance/seedance-2.0/text-to-video', 'Seedance 2.0 · texto→video'],
  ['bytedance/seedance-2.0/image-to-video', 'Seedance 2.0 · imagen→video'],
  ['bytedance/seedance-2.0/fast/text-to-video', 'Seedance 2.0 Fast · texto→video'],
  ['bytedance/seedance-2.0/fast/image-to-video', 'Seedance 2.0 Fast · imagen→video'],
  ['fal-ai/bytedance/seedance/v1/pro/image-to-video', 'Seedance 1.0 Pro · imagen→video'],
];
const FAL_IMAGE_MODELS = [
  ['fal-ai/recraft/v3/text-to-image', 'Recraft V3 (vector / SVG)'],
  ['fal-ai/flux/schnell', 'FLUX.1 schnell (rápido)'],
];

export function initAI(app) {
  const panel = document.createElement('div');
  panel.id = 'aiPanel';
  panel.innerHTML = `
  <div class="aiHead">${icon('sparkles', 18)}<b>Generar con IA</b><span id="aiStatus" class="muted"></span><button id="aiClose" title="Cerrar">${icon('x', 16)}</button></div>
  <div class="aiTabs">
    <button data-tab="svg" class="active">Vector SVG</button>
    <button data-tab="anim">Animación</button>
    <button data-tab="animate">Animar capas</button>
    <button data-tab="image">Imagen</button>
    <button data-tab="video">Video</button>
    <button data-tab="voice">Voz</button>
    <button data-tab="clone">Clonar video</button>
  </div>
  <div class="aiBody">
    <textarea id="aiPrompt" rows="4" placeholder="Describe lo que quieres crear…"></textarea>
    <div class="aiRow" data-show="svg anim"><label>Estilo</label><div id="aiStyles" class="chips"></div></div>
    <div class="aiRow" data-show="svg anim animate clone"><label>Motor</label>
      <select id="aiProvider">
        <option value="claude-code">Claude Code (tu sesión del CLI)</option>
        <option value="claude-api">Claude API (claude-opus-5-5)</option>
        <option value="fal-recraft" data-only="svg">fal · Recraft V3 vector</option>
      </select></div>
    <div class="aiRow" data-show="svg anim animate clone"><label>Calidad</label>
      <select id="aiEffort"><option value="low">Rápida (menos tokens)</option><option value="medium" selected>Normal</option><option value="high">Alta (más lenta)</option></select></div>
    <div class="aiRow" data-show="anim animate"><label>Duración</label><input id="aiDuration" type="number" min="12" max="480" value="72"> <span class="muted">frames máx.</span></div>
    <div class="aiRow" data-show="svg anim"><label>Variaciones</label><select id="aiCount"><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
    <div class="aiRow" data-show="image"><label>Modelo</label><select id="aiImageModel"></select></div>
    <div class="aiRow" data-show="video"><label>Modelo</label><select id="aiVideoModel"></select></div>
    <div class="aiRow" data-show="image video"><label>Otro modelo</label><input id="aiCustomModel" type="text" placeholder="owner/modelo/endpoint (opcional)"></div>
    <div class="aiRow" data-show="video"><label>Duración</label><select id="aiVidDur"><option>auto</option>${[4, 5, 6, 8, 10, 12, 15].map((d) => `<option ${d === 5 ? 'selected' : ''}>${d}</option>`).join('')}</select>
      <select id="aiVidRes"><option>480p</option><option selected>720p</option><option>1080p</option></select>
      <label class="inline"><input type="checkbox" id="aiVidAudio" checked> audio</label></div>
    <div class="aiRow" data-show="image video"><label>Formato</label><select id="aiAspect"><option value="doc">Como el documento</option><option>16:9</option><option>9:16</option><option>1:1</option><option>4:3</option><option>21:9</option><option value="auto">auto</option></select></div>
    <div class="aiRow" data-show="svg anim animate image video"><label>Referencia</label>
      <div class="refs"><button id="aiUseFrame" title="Adjuntar el frame actual como imagen de referencia">${icon('image', 14)} Frame actual</button>
      <label class="btn">${icon('upload', 14)} Archivo<input id="aiRefFile" type="file" accept="image/*" hidden></label>
      <button id="aiClearRefs" title="Quitar referencias">${icon('x', 14)}</button></div></div>
    <div id="aiRefThumbs" class="thumbs"></div>
    <div class="aiRow" data-show="voice"><label>Tipo</label><div class="chips" id="vcMode"><button data-vm="tts" class="active">Narración</button><button data-vm="sfx">Efecto de sonido</button></div></div>
    <div class="aiRow" data-show="voice" data-vm="tts"><label>Voz</label><div class="refs"><select id="vcVoice" style="flex:1"><option value="">Cargando voces…</option></select><button id="vcPreview" title="Escuchar muestra">${icon('play', 13)}</button></div></div>
    <div class="aiRow" data-show="voice" data-vm="tts"><label>Modelo</label><select id="vcModel"><option value="eleven_multilingual_v2">Eleven Multilingual v2</option></select></div>
    <div class="aiRow" data-show="voice" data-vm="tts"><label>Estabilidad</label><input type="range" id="vcStab" min="0" max="1" step="0.05" value="0.5"></div>
    <div class="aiRow" data-show="voice" data-vm="tts"><label>Velocidad</label><input type="range" id="vcSpeed" min="0.7" max="1.2" step="0.05" value="1"></div>
    <div class="aiRow" data-show="voice" data-vm="sfx"><label>Duración</label><div class="refs"><input type="number" id="vcDur" min="0" max="30" step="0.5" value="0" style="width:70px" title="0 = automática"><span class="muted small">s (0 = auto)</span><label class="inline"><input type="checkbox" id="vcLoop"> loop</label></div></div>
    <p class="muted small" data-show="voice">El audio se inserta en el frame actual como pista de audio. Se genera en ElevenLabs y llega directo a tu navegador.</p>

    <div class="aiRow" data-show="clone"><label>Video</label><div class="refs"><label class="btn">${icon('upload', 14)} Subir video<input id="clFile" type="file" accept="video/*" hidden></label><button id="clUseClip" title="Usar el clip de video seleccionado en Capas">${icon('film', 14)} Clip seleccionado</button></div></div>
    <div class="aiRow" data-show="clone"><label>Fotogramas</label><div class="refs"><select id="clFrames"><option>6</option><option selected>8</option><option>12</option></select>
      <label class="inline"><input type="checkbox" id="clAudio" checked> conservar audio</label><label class="inline"><input type="checkbox" id="clFit" checked> ajustar formato</label></div></div>
    <div id="clInfo" class="muted small" data-show="clone"></div>
    <div id="clThumbs" class="thumbs" data-show="clone"></div>
    <p class="muted small" data-show="clone">Tu video no se sube al servidor: los fotogramas se extraen en tu navegador y solo esas imágenes se envían a Claude para analizarlas. Solo se clonan videos animados.</p>

    <details data-show="image video"><summary>Parámetros avanzados (JSON)</summary>
      <textarea id="aiExtra" rows="3" placeholder='{"seed": 42}'></textarea></details>
    <button id="aiGo" class="primary">${icon('sparkles', 16)} Generar</button>
    <div id="aiProgress" class="muted"></div>
    <div id="aiResults" class="results"></div>
  </div>`;
  document.body.appendChild(panel);
  const $ = (id) => panel.querySelector('#' + id);
  let tab = 'svg';
  const refs = [];
  const fill = (sel, list) => (sel.innerHTML = list.map(([v, n]) => `<option value="${v}">${n}</option>`).join(''));
  fill($('aiImageModel'), FAL_IMAGE_MODELS);
  fill($('aiVideoModel'), FAL_VIDEO_MODELS);
  let style = 'plano';
  $('aiStyles').innerHTML = Object.keys(STYLES).map((k) => `<button data-style="${k}" class="${k === style ? 'active' : ''}">${k}</button>`).join('');
  $('aiStyles').onclick = (e) => {
    const b = e.target.closest('[data-style]'); if (!b) return;
    style = b.dataset.style;
    $('aiStyles').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  };

  const PLACEHOLDER = {
    svg: 'Ej: un zorro naranja sentado mirando la luna, con cola esponjosa',
    anim: 'Ej: un pájaro que bate las alas y salta dos veces, en loop',
    animate: 'Ej: haz que el personaje salude con el brazo derecho y parpadee',
    image: 'Ej: fondo de bosque al atardecer, estilo acuarela',
    video: 'Ej: la cámara se acerca lentamente mientras el personaje camina por la ciudad',
    voice: 'Escribe el texto que dirá la voz…',
    sfx: 'Describe el sonido: ej. "salto cartoon con resorte", "lluvia suave en una ventana"',
    clone: 'Opcional: indicaciones extra (ej. "simplifica los fondos", "colores pastel")',
  };
  function setTab(t) {
    tab = t;
    panel.querySelectorAll('.aiTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    panel.querySelectorAll('[data-show]').forEach((el) => {
      const onTab = el.dataset.show.split(' ').includes(t);
      const onMode = !el.dataset.vm || el.closest('#vcMode') || el.dataset.vm === voiceMode;
      el.style.display = onTab && onMode ? '' : 'none';
    });
    if (t === 'voice') loadVoices();
    panel.querySelectorAll('#aiProvider option[data-only]').forEach((o) => (o.hidden = o.dataset.only !== t));
    if ($('aiProvider').selectedOptions[0]?.hidden) $('aiProvider').value = 'claude-code';
    $('aiPrompt').placeholder = t === 'voice' && voiceMode === 'sfx' ? PLACEHOLDER.sfx : PLACEHOLDER[t];
    $('aiGo').lastChild.textContent = t === 'voice' ? ' Generar audio' : t === 'clone' ? ' Clonar animación' : ' Generar';
  }
  panel.querySelector('.aiTabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); };
  // ---------- Voz (ElevenLabs) ----------
  let voiceMode = 'tts', voicesLoaded = false;
  $('vcMode').onclick = (e) => {
    const b = e.target.closest('[data-vm]'); if (!b) return;
    voiceMode = b.dataset.vm;
    $('vcMode').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    setTab('voice');
  };
  async function loadVoices() {
    if (voicesLoaded) return;
    try {
      const [{ voices }, { models }] = await Promise.all([api('/api/eleven/voices'), api('/api/eleven/models')]);
      $('vcVoice').innerHTML = voices.map((v) => `<option value="${v.id}" data-preview="${v.preview || ''}">${v.name}${[v.labels.gender, v.labels.accent, v.labels.age].filter(Boolean).length ? ' · ' + [v.labels.gender, v.labels.accent, v.labels.age].filter(Boolean).join(', ') : ''}</option>`).join('');
      if (models?.length) $('vcModel').innerHTML = models.map((m) => `<option value="${m.id}" ${m.id === 'eleven_multilingual_v2' ? 'selected' : ''}>${m.name}</option>`).join('');
      voicesLoaded = true;
    } catch (e) { $('vcVoice').innerHTML = `<option value="">${e.message}</option>`; }
  }
  let previewAudio = null;
  $('vcPreview').onclick = () => {
    const url = $('vcVoice').selectedOptions[0]?.dataset.preview;
    if (!url) return;
    previewAudio?.pause(); previewAudio = new Audio(url); previewAudio.play();
  };
  async function elevenAudio(path, payload, name) {
    const r = await fetch(path, { method: 'POST', headers: API_HEADERS, body: JSON.stringify(payload) });
    if (!r.ok) { let j = {}; try { j = await r.json(); } catch { /* binario */ } throw new Error(j.error || `ElevenLabs ${r.status}`); }
    const blob = await r.blob();
    return new File([blob], `${name}.mp3`, { type: 'audio/mpeg' });
  }

  // ---------- Clonar video (todo local salvo los fotogramas enviados a Claude) ----------
  let clone = null; // { file, frames:[{t,data}], duration, width, height }
  async function extractFrames(file, n, maxSide = 640) {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
    const once = (ev) => new Promise((res, rej) => { v.addEventListener(ev, res, { once: true }); v.addEventListener('error', () => rej(new Error('El navegador no puede leer este video (prueba MP4/H.264 o WebM)')), { once: true }); });
    try {
      await once('loadedmetadata');
      let dur = v.duration;
      if (!Number.isFinite(dur) || dur <= 0) { v.currentTime = 1e7; await once('seeked'); dur = v.currentTime || 1; }
      const k = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
      const g = c.getContext('2d');
      const frames = [];
      for (let i = 0; i < n; i++) {
        const t = Math.min(dur - 0.01, Math.max(0.12, dur * (i + 0.5) / n)); // evita el primer fotograma (a veces negro)
        v.currentTime = t; await once('seeked');
        g.drawImage(v, 0, 0, c.width, c.height);
        frames.push({ t, data: c.toDataURL('image/jpeg', 0.82) });
      }
      return { file, frames, duration: dur, width: v.videoWidth, height: v.videoHeight };
    } finally { URL.revokeObjectURL(url); }
  }
  async function loadClone(file) {
    $('clInfo').textContent = 'Extrayendo fotogramas en tu navegador…'; $('clThumbs').innerHTML = '';
    try {
      clone = await extractFrames(file, +$('clFrames').value);
      $('clInfo').textContent = `${file.name} · ${clone.duration.toFixed(1)} s · ${clone.width}×${clone.height} · ${clone.frames.length} fotogramas listos`;
      clone.frames.forEach((f) => { const i = new Image(); i.src = f.data; i.title = `${f.t.toFixed(2)} s`; $('clThumbs').append(i); });
    } catch (e) { clone = null; $('clInfo').textContent = '⚠ ' + e.message; }
  }
  $('clFile').onchange = (e) => { const f = e.target.files[0]; if (f) loadClone(f); e.target.value = ''; };
  $('clFrames').onchange = () => { if (clone) loadClone(clone.file); };
  $('clUseClip').onclick = async () => {
    const f = await app.selectedVideoFile();
    if (f) loadClone(f); else $('clInfo').textContent = 'Selecciona primero un clip de video en el panel de Capas.';
  };

  setTab('svg');

  // Referencias (multimodal)
  function renderRefs() {
    $('aiRefThumbs').innerHTML = '';
    refs.forEach((src) => { const i = new Image(); i.src = src; $('aiRefThumbs').append(i); });
  }
  $('aiUseFrame').onclick = () => { const d = app.snapshot(1024); if (d) { refs.push(d); renderRefs(); } };
  $('aiRefFile').onchange = async (e) => {
    for (const f of e.target.files) refs.push(await fileToDataUrl(f));
    e.target.value = ''; renderRefs();
  };
  $('aiClearRefs').onclick = () => { refs.length = 0; renderRefs(); };

  // Estado de backends
  let status = null;
  async function refreshStatus() {
    try {
      status = await api('/api/status');
      const s = [
        `Claude Code ${status.claudeCode.available ? '✓' : '✗'}`,
        `Claude API ${status.claudeApi.available ? '✓' : '✗'}`,
        `fal ${status.fal.available ? '✓' : '✗'}`,
        `Voz ${status.eleven?.available ? '✓' : '✗'}`,
      ].join(' · ');
      $('aiStatus').textContent = s;
      $('aiStatus').title = [status.claudeCode.reason, !status.claudeApi.available && status.claudeApi.reason, !status.fal.available && status.fal.reason, !status.eleven?.available && status.eleven?.reason].filter(Boolean).join('\n');
    } catch {
      status = null;
      $('aiStatus').textContent = 'backend apagado';
      $('aiStatus').title = 'Inicia el servidor: node server/server.mjs';
    }
  }

  // ---------------- Generación ----------------
  let busy = false;
  const progress = (t) => ($('aiProgress').textContent = t);

  async function claudeGenerate(system, prompt) {
    const provider = $('aiProvider').value;
    if (status && provider === 'claude-code' && !status.claudeCode.available) throw new Error(status.claudeCode.reason);
    if (status && provider === 'claude-api' && !status.claudeApi.available) throw new Error(status.claudeApi.reason);
    return api('/api/claude', { provider, system, prompt, images: refs, effort: $('aiEffort').value });
  }

  function aspectValue() {
    const v = $('aiAspect').value;
    if (v !== 'doc') return v;
    const { width: w, height: h } = app.getDoc()?.project_data || { width: 16, height: 9 };
    const r = w / h;
    const opts = [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['21:9', 21 / 9]];
    return opts.reduce((a, b) => (Math.abs(b[1] - r) < Math.abs(a[1] - r) ? b : a))[0];
  }
  const imageSize = (a) => ({ '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '1:1': 'square_hd', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3' }[a] || 'landscape_16_9');

  async function falRun(model, input) {
    if (status && !status.fal.available) throw new Error(status.fal.reason);
    let extra = {};
    if ($('aiExtra').value.trim()) { try { extra = JSON.parse($('aiExtra').value); } catch { throw new Error('Parámetros avanzados: JSON no válido'); } }
    const sub = await api('/api/fal/submit', { model, input: { ...input, ...extra } });
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 2500));
      const st = await api(`/api/fal/status?id=${encodeURIComponent(sub.request_id)}`);
      const secs = Math.round((Date.now() - t0) / 1000);
      if (st.status === 'COMPLETED') return st.result;
      progress(`${model} · ${st.status === 'IN_QUEUE' ? `en cola (posición ${st.queue_position ?? '?'})` : 'generando'} · ${secs} s ${st.logs?.length ? '· ' + st.logs.at(-1) : ''}`);
      if (secs > 900) throw new Error('fal.ai tardó demasiado');
    }
  }

  async function fetchResultFile(url, fallbackName) {
    const r = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, { headers: { 'x-moho-web': '1' } });
    if (!r.ok) throw new Error('No se pudo descargar el resultado');
    const blob = await r.blob();
    const ext = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg' }[blob.type.split(';')[0]] || (url.match(/\.\w{3,4}(?=$|\?)/)?.[0] ?? '');
    return new File([blob], fallbackName + ext, { type: blob.type });
  }

  async function generate() {
    if (busy) return;
    const prompt = $('aiPrompt').value.trim();
    if (tab === 'clone' && !clone) { progress('Sube un video o elige un clip primero.'); return; }
    if (tab !== 'clone' && !prompt && !refs.length) { progress(tab === 'voice' ? 'Escribe el texto o la descripción del sonido.' : 'Escribe una descripción.'); return; }
    busy = true; $('aiGo').disabled = true;
    const t0 = Date.now();
    const timer = setInterval(() => { if (!$('aiProgress').textContent.includes('·')) progress(`Generando… ${Math.round((Date.now() - t0) / 1000)} s`); }, 1000);
    try {
      app.ensureDoc();
      const pd = app.getDoc().project_data;
      const W = pd.width, H = pd.height;
      const count = +$('aiCount').value || 1;
      if (tab === 'svg') {
        if ($('aiProvider').value === 'fal-recraft') {
          const res = await falRun('fal-ai/recraft/v3/text-to-image', { prompt: `${prompt}. ${STYLES[style]}`, style: 'vector_illustration', image_size: imageSize(aspectValue()) });
          for (const img of res.images || []) addResult({ kind: 'file', file: await fetchResultFile(img.url, slug(prompt)), prompt });
        } else {
          const outs = await Promise.allSettled(Array.from({ length: count }, (_, i) =>
            claudeGenerate(svgSystem(W, H, STYLES[style]), count > 1 ? `${prompt}\n\n(Variación ${i + 1} de ${count}: explora una composición distinta.)` : prompt)));
          for (const o of outs) {
            if (o.status === 'rejected') { addError(o.reason.message); continue; }
            try { addResult({ kind: 'svg', svg: extractSvg(o.value.text), prompt, meta: meta(o.value) }); } catch (e) { addError(e.message); }
          }
        }
      } else if (tab === 'anim') {
        const maxF = Math.max(12, +$('aiDuration').value || 72);
        const outs = await Promise.allSettled(Array.from({ length: count }, (_, i) =>
          claudeGenerate(animSystem(W, H, pd.fps, maxF, STYLES[style]), count > 1 ? `${prompt}\n\n(Variación ${i + 1} de ${count}.)` : prompt)));
        for (const o of outs) {
          if (o.status === 'rejected') { addError(o.reason.message); continue; }
          try {
            const spec = extractJson(o.value.text);
            spec.svg = extractSvg(spec.svg);
            addResult({ kind: 'anim', spec, prompt, meta: meta(o.value) });
          } catch (e) { addError('Animación no válida: ' + e.message); }
        }
      } else if (tab === 'animate') {
        const layers = app.describeLayers();
        if (!layers.length) throw new Error('El documento no tiene capas para animar');
        const maxF = Math.max(12, +$('aiDuration').value || 72);
        const desc = layers.map((l) => `- "${l.name}" (${l.type}${l.bbox ? `, caja ${l.bbox.map(Math.round).join(',')}` : ''}${l.parent ? `, dentro de "${l.parent}"` : ''})`).join('\n');
        const out = await claudeGenerate(animateExistingSystem(W, H, pd.fps, maxF), `Capas del documento (caja = x0,y0,x1,y1 en píxeles):\n${desc}\n\nInstrucción: ${prompt}`);
        const spec = extractJson(out.text);
        addResult({ kind: 'animate', spec, prompt, meta: meta(out) });
      } else if (tab === 'image') {
        const model = $('aiCustomModel').value.trim() || $('aiImageModel').value;
        const input = { prompt, image_size: imageSize(aspectValue()) };
        if (model.includes('recraft')) input.style = 'vector_illustration';
        if (refs[0]) input.image_url = refs[0];
        const res = await falRun(model, input);
        const imgs = res.images || (res.image ? [res.image] : []);
        if (!imgs.length) throw new Error('El modelo no devolvió imágenes');
        for (const img of imgs) addResult({ kind: 'file', file: await fetchResultFile(img.url, slug(prompt)), prompt });
      } else if (tab === 'voice') {
        if (status && !status.eleven?.available) throw new Error(status.eleven?.reason || 'ElevenLabs no configurado');
        if (voiceMode === 'tts') {
          if (!$('vcVoice').value) throw new Error('Elige una voz');
          const file = await elevenAudio('/api/eleven/tts', { text: prompt, voiceId: $('vcVoice').value, modelId: $('vcModel').value, stability: +$('vcStab').value, speed: +$('vcSpeed').value }, 'voz_' + slug(prompt));
          addResult({ kind: 'file', file, prompt: `🎙 ${$('vcVoice').selectedOptions[0].textContent.split(' · ')[0]}: ${prompt}`, meta: 'ElevenLabs' });
        } else {
          const file = await elevenAudio('/api/eleven/sfx', { text: prompt, duration: +$('vcDur').value || undefined, loop: $('vcLoop').checked }, 'sfx_' + slug(prompt));
          addResult({ kind: 'file', file, prompt: `🔊 ${prompt}`, meta: 'ElevenLabs SFX' });
        }
      } else if (tab === 'clone') {
        if ($('clFit').checked) app.fitFormatTo(clone.width, clone.height);
        const pd2 = app.getDoc().project_data;
        const maxF = Math.min(480, Math.max(12, Math.round(clone.duration * pd2.fps)));
        progress(`Claude analiza ${clone.frames.length} fotogramas…`);
        const provider = $('aiProvider').value === 'fal-recraft' ? 'claude-code' : $('aiProvider').value;
        if (status && provider === 'claude-code' && !status.claudeCode.available) throw new Error(status.claudeCode.reason);
        const out = await api('/api/claude', {
          provider, effort: $('aiEffort').value,
          system: cloneSystem(pd2.width, pd2.height, pd2.fps, maxF, clone.frames.map((f) => f.t)),
          prompt: `Video: ${clone.file.name} (${clone.duration.toFixed(1)} s, ${clone.width}×${clone.height}). Recréalo en ${pd2.width}×${pd2.height} a ${pd2.fps} fps.${prompt ? `\nIndicaciones extra: ${prompt}` : ''}`,
          images: clone.frames.map((f) => f.data),
        });
        const spec = extractJson(out.text);
        if (spec.animated === false) {
          addError(`No se clonó: el video parece ${spec.kind || 'una grabación real'}. ${spec.reason || ''} Solo se clonan videos animados.`);
        } else {
          spec.svg = extractSvg(spec.svg);
          addResult({ kind: 'anim', spec, prompt: `Clon de ${clone.file.name}${spec.kind ? ` (${spec.kind})` : ''}`, meta: meta(out), audioFile: $('clAudio').checked ? clone.file : null });
        }
      } else if (tab === 'video') {
        const model = $('aiCustomModel').value.trim() || $('aiVideoModel').value;
        const input = { prompt, resolution: $('aiVidRes').value, duration: $('aiVidDur').value, aspect_ratio: aspectValue(), generate_audio: $('aiVidAudio').checked };
        if (/image-to-video|reference/.test(model)) {
          if (!refs.length) throw new Error('Este modelo necesita una imagen inicial: usa "📷 Frame actual" o "🖼 Archivo"');
          input.image_url = refs[0];
          if (refs[1]) input.end_image_url = refs[1];
        }
        const res = await falRun(model, input);
        const url = res.video?.url || res.videos?.[0]?.url;
        if (!url) throw new Error('El modelo no devolvió video');
        addResult({ kind: 'file', file: await fetchResultFile(url, slug(prompt)), prompt });
      }
      progress(`Listo en ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e) {
      progress('');
      addError(e.message);
    } finally { clearInterval(timer); busy = false; $('aiGo').disabled = false; }
  }
  $('aiGo').onclick = generate;
  $('aiPrompt').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(); e.stopPropagation(); };
  $('aiPrompt').onkeyup = (e) => e.stopPropagation();

  const meta = (o) => [o.provider, o.model, o.ms && `${Math.round(o.ms / 1000)} s`, o.costUsd && `$${o.costUsd.toFixed(3)}`].filter(Boolean).join(' · ');
  const slug = (s) => (s || 'generado').toLowerCase().normalize('NFD').replace(/[^\w]+/g, '_').slice(0, 32).replace(/^_|_$/g, '') || 'generado';

  // ---------------- Resultados ----------------
  function addError(msg) {
    const d = document.createElement('div'); d.className = 'aiError'; d.textContent = '⚠ ' + msg;
    $('aiResults').prepend(d);
  }

  const HIST_KEY = 'mohoWeb.aiHistory';
  function saveHistory(r) {
    if (!['svg', 'anim', 'animate'].includes(r.kind)) return; // los archivos (video/imagen) no se guardan
    try {
      const h = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
      h.push({ kind: r.kind, svg: r.svg, spec: r.spec, prompt: r.prompt, meta: r.meta });
      localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(-20)));
    } catch { /* almacenamiento lleno */ }
  }

  function addResult(r, persist = true) {
    if (persist) saveHistory(r);
    const card = document.createElement('div'); card.className = 'card';
    const prev = document.createElement('div'); prev.className = 'prev';
    let url;
    if (r.kind === 'svg' || r.kind === 'anim') {
      url = URL.createObjectURL(new Blob([r.kind === 'svg' ? r.svg : r.spec.svg], { type: 'image/svg+xml' }));
      prev.innerHTML = `<img src="${url}">`;
      if (r.kind === 'anim') prev.insertAdjacentHTML('beforeend', `<span class="badge">🎞 ${r.spec.animations?.length || 0} partes · ${r.spec.duration || '?'} f</span>`);
    } else if (r.kind === 'animate') {
      prev.innerHTML = `<div class="animList">${(r.spec.animations || []).map((a) => `<div>🎞 ${a.target} · ${a.keys?.length || 0} keys</div>`).join('')}</div>`;
    } else {
      url = URL.createObjectURL(r.file);
      prev.innerHTML = r.file.type.startsWith('video/') ? `<video src="${url}" muted loop autoplay playsinline></video>`
        : r.file.type.startsWith('audio/') ? `<div class="audioPrev">${icon('music', 28)}<audio src="${url}" controls></audio></div>` : `<img src="${url}">`;
    }
    const cap = document.createElement('div'); cap.className = 'cap';
    cap.textContent = r.prompt.slice(0, 80) + (r.meta ? `  ·  ${r.meta}` : '');
    const acts = document.createElement('div'); acts.className = 'acts';
    const ins = document.createElement('button'); ins.textContent = r.kind === 'animate' ? 'Aplicar' : 'Insertar';
    ins.onclick = () => { try { insert(r); ins.textContent = '✓'; } catch (e) { addError(e.message); } };
    const dl = document.createElement('button'); dl.textContent = '⤓';
    dl.title = 'Descargar';
    dl.onclick = () => {
      const blob = r.kind === 'svg' ? new Blob([r.svg], { type: 'image/svg+xml' })
        : r.kind === 'file' ? r.file : new Blob([JSON.stringify(r.spec, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = r.kind === 'file' ? r.file.name : `${slug(r.prompt)}.${r.kind === 'svg' ? 'svg' : 'json'}`; a.click();
    };
    acts.append(ins, dl);
    card.append(prev, cap, acts);
    $('aiResults').prepend(card);
  }

  function insert(r) {
    const doc = app.getDoc();
    const pd = doc.project_data;
    if (r.kind === 'file') { app.importFiles([r.file]); return; }
    if (r.kind === 'svg') {
      app.pushUndo();
      const { group } = svgImport(r.svg, pd.width, pd.height, slug(r.prompt), 'frame');
      app.addLayer(group); app.refresh();
      app.status(`Insertado: ${group.layers.length} partes`);
      return;
    }
    if (r.kind === 'anim') {
      app.pushUndo();
      const imp = svgImport(r.spec.svg, pd.width, pd.height, r.spec.title || slug(r.prompt), 'frame');
      let applied = 0;
      for (const a of r.spec.animations || []) {
        const layer = imp.byId.get(a.target);
        if (!layer) continue;
        applyAnimation(layer, a, { pxToUnits: imp.s, pivotToLocal: (x, y) => imp.map(x, y), frameOffset: 0, loop: !!r.spec.loop });
        applied++;
      }
      const dur = Math.round(r.spec.duration || 0);
      if (dur > pd.end_frame) pd.end_frame = dur;
      app.addLayer(imp.group);
      if (r.audioFile) app.importAudio(r.audioFile, 1);
      app.refresh();
      app.status(`Animación insertada: ${applied} partes animadas${r.audioFile ? ' + audio original' : ''}`);
      return;
    }
    if (r.kind === 'animate') {
      app.pushUndo();
      const s = 2 / pd.height;
      let applied = 0;
      for (const a of r.spec.animations || []) {
        const layer = app.findLayerByName(a.target);
        if (!layer) continue;
        applyAnimation(layer, a, { pxToUnits: s, pivotToLocal: (x, y) => app.docPxToLayerLocal(layer, x, y), loop: !!r.spec.loop });
        applied++;
      }
      const dur = Math.round(r.spec.duration || 0);
      if (dur > pd.end_frame) pd.end_frame = dur;
      app.refresh();
      app.status(`Animación aplicada a ${applied} capas`);
    }
  }

  try { for (const r of JSON.parse(localStorage.getItem(HIST_KEY) || '[]')) addResult(r, false); } catch { /* historial corrupto */ }

  // ---------------- Abrir/cerrar ----------------
  $('aiClose').onclick = () => panel.classList.remove('open');
  return {
    open() { panel.classList.add('open'); refreshStatus(); setTimeout(() => $('aiPrompt').focus(), 250); },
    openWith({ tab, prompt } = {}) {
      this.open();
      if (tab) setTab(tab);
      if (prompt) $('aiPrompt').value = prompt;
    },
    close() { panel.classList.remove('open'); },
    toggle() { panel.classList.contains('open') ? this.close() : this.open(); },
  };
}

function fileToDataUrl(f) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
}

export { makeChannel };
