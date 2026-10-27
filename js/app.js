import { readZip, writeZip } from './zip.js';
import { evalChannel, setKey, deleteKey, collectKeys, INTERP } from './anim.js';
import { renderDoc, boneMatrices, inv, apply, mul, BLEND_NAMES } from './render.js';
import { newDocument, makeShapeLayer, makeGroupLayer, makeBoneLayer, makeBone, makeImageLayer, makeAudioLayer } from './doc.js';
import { MediaStore, isVideoPath, isAudioPath, clipTime } from './media.js';
import { addPathsToMesh, emptyMesh, simplify, autoSmooth, deletePoints, setSmoothness, hexToColor, colorToHex } from './vector.js';
import { svgToLayers, frameToSvg } from './svg.js';
import { clipRange, setClipRange, moveClip, splitClip, duplicateLayer, fade, setAdjust, ensureEffects, allLayers } from './clips.js';
import { initAI } from './ai.js';
import { initResearch } from './research.js';
import { requireUser, initAccount } from './account.js';
import { initUtm } from './utm.js';
import { icon, hydrateIcons, LAYER_ICON } from './icons.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas'), g = canvas.getContext('2d');
const keysCanvas = $('keysCanvas'), kg = keysCanvas.getContext('2d');
const tracksCanvas = $('tracksCanvas'), tg = tracksCanvas.getContext('2d');
const DPR = () => devicePixelRatio;

const S = {
  doc: null, extraFiles: new Map(), fileName: 'Sin título.moho',
  frame: 0, playing: false, exporting: false, tool: 'points',
  selLayer: null, selBone: null, selPoints: new Set(),
  viewZoom: 1, panX: 0, panY: 0, info: null, undo: [], redo: [],
  pen: null, pencil: null, clipboard: null,
};
const media = new MediaStore((kind) => {
  requestDraw();
  if (kind === 'status' && !S.playing && /Image|Audio/.test(S.selLayer?.type || '')) setTimeout(updateProps, 0);
});

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  setTimeout(() => { drawQueued = false; draw(); drawTracks(); }, 0);
}
const fps = () => S.doc?.project_data.fps || 24;
const range = () => [S.doc.project_data.start_frame, S.doc.project_data.end_frame];

// ======================= Carga / guardado =======================
async function loadFromBuffer(buf, name, baseUrl = null) {
  const u8 = new Uint8Array(buf);
  let json, extra = new Map();
  if (u8[0] === 0x50 && u8[1] === 0x4b) {
    const files = await readZip(buf);
    const projName = [...files.keys()].find((n) => n.endsWith('.mohoproj'));
    if (!projName) throw new Error('El ZIP no contiene Project.mohoproj');
    json = new TextDecoder().decode(files.get(projName));
    files.delete(projName);
    extra = files;
  } else {
    json = new TextDecoder().decode(u8);
    if (!json.trimStart().startsWith('{')) throw new Error('Formato .anme (texto, Moho ≤ 12) no soportado; guarda el archivo como .moho');
  }
  const doc = JSON.parse(json);
  if (!doc.layers || !doc.project_data) throw new Error('No parece un documento de Moho');
  setDoc(doc, name, extra, baseUrl);
}

function setDoc(doc, name, extra = new Map(), baseUrl = null) {
  stopPlayback();
  media.reset(baseUrl);
  for (const [k, v] of extra) if (k !== 'preview.jpg') media.addFile(k, new Blob([v]));
  S.doc = doc; S.fileName = name.replace(/\.(mohoproj|json)$/i, '.moho'); S.extraFiles = extra;
  S.frame = 0; S.selLayer = null; S.selBone = null; S.selPoints.clear(); S.undo = []; S.redo = [];
  S.viewZoom = 1; S.panX = S.panY = 0; S.pen = null;
  $('dropHint').style.display = 'none';
  updateDocTitle();
  refreshAll();
}

function updateDocTitle() {
  if (!S.doc) return;
  const pd = S.doc.project_data;
  $('docTitle').innerHTML = `<b style="color:var(--text)">${S.fileName.replace(/[<>&]/g, '')}</b>  ·  ${pd.width}×${pd.height}  ·  ${pd.fps} fps  ·  ${pd.end_frame} frames`;
  document.title = `${S.fileName} — Astrix Studio`;
  updateFormatSwitch();
}

function refreshAll() { updateDocTitle(); buildLayerTree(); updateProps(); updateDocProps(); updateTimeline(); draw(); drawTracks(); }

async function saveMoho() {
  if (!S.doc) return;
  S.doc.modified_date = new Date().toString().slice(0, 24);
  const files = new Map([['Project.mohoproj', new TextEncoder().encode(JSON.stringify(S.doc))]]);
  const thumb = await renderToBlob(320, 'image/jpeg');
  files.set('preview.jpg', new Uint8Array(await thumb.arrayBuffer()));
  for (const [k, v] of S.extraFiles) if (k !== 'preview.jpg') files.set(k, v);
  download(await writeZip(files), S.fileName);
  status('Guardado ' + S.fileName);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ======================= Importar medios =======================
function ensureDoc() {
  if (!S.doc) { const [w, h] = FORMATS[lastFormat()]; setDoc(newDocument(w, h), 'Sin título.moho'); }
}

const mediaSize = (blob, kind) => new Promise((res) => {
  const url = URL.createObjectURL(blob);
  const el = document.createElement(kind === 'video' ? 'video' : 'img');
  const done = (w, h, d) => { URL.revokeObjectURL(url); res({ w, h, d }); };
  if (kind === 'video') { el.preload = 'metadata'; el.onloadedmetadata = () => done(el.videoWidth || 16, el.videoHeight || 9, Number.isFinite(el.duration) ? el.duration : 0); }
  else el.onload = () => done(el.naturalWidth, el.naturalHeight, 0);
  el.onerror = () => done(16, 9, 0);
  el.src = url;
});

function fitSize(w, h) {
  const pd = S.doc.project_data, aspect = pd.width / pd.height;
  let hh = 2, ww = 2 * (w / h);
  if (ww > 2 * aspect) { ww = 2 * aspect; hh = ww * h / w; }
  return [ww, hh];
}

async function storeMedia(file) {
  let name = file.name.replace(/[\\/]/g, '_');
  let path = 'media/' + name, k = 1;
  while (S.extraFiles.has(path)) path = `media/${k++}_${name}`;
  S.extraFiles.set(path, new Uint8Array(await file.arrayBuffer()));
  media.addFile(path, file);
  return path;
}

function extendDocTo(frames) {
  const pd = S.doc.project_data;
  if (frames > pd.end_frame) { pd.end_frame = Math.ceil(frames); updateDocProps(); }
}

async function importAudioOnly(file, startFrame) {
  ensureDoc();
  const path = await storeMedia(file);
  try {
    const buf = await media.ctx().decodeAudioData(await file.arrayBuffer());
    const start = startFrame || S.doc.project_data.start_frame;
    const al = makeAudioLayer(path, '🔊 ' + file.name);
    al.timing_offset = start - 1;
    const frames = Math.round(buf.duration * fps());
    extendDocTo(start + frames - 1);
    setClipRange(al, start, start + frames - 1, ...range());
    addLayerNoUndo(al, true);
    refreshAll();
  } catch { status('El video no tiene audio que se pueda extraer'); }
}

async function importFiles(files) {
  files = [...files];
  const proj = files.find((f) => /\.(moho|mohoproj)$/i.test(f.name));
  if (proj && files.length === 1) {
    try { await loadFromBuffer(await proj.arrayBuffer(), proj.name); status(`Abierto ${proj.name}`); }
    catch (err) { alert(err.message); }
    return;
  }
  ensureDoc();
  pushUndo();
  for (const f of files) {
    try {
      if (/\.svg$/i.test(f.name) || f.type === 'image/svg+xml') {
        const pd = S.doc.project_data;
        const group = svgToLayers(await f.text(), pd.width, pd.height, f.name);
        addLayerNoUndo(group);
        status(`SVG importado: ${group.layers.length} trazados`);
      } else if (f.type.startsWith('video/') || isVideoPath(f.name)) {
        const path = await storeMedia(f);
        const { w, h, d } = await mediaSize(f, 'video');
        const [ww, hh] = fitSize(w, h);
        const start = S.frame > 0 ? S.frame : S.doc.project_data.start_frame;
        const vl = makeImageLayer(path, ww, hh);
        vl.timing_offset = start - 1;
        const frames = Math.round((d || 5) * fps());
        extendDocTo(start + frames - 1);
        setClipRange(vl, start, start + frames - 1, ...range());
        addLayerNoUndo(vl);
        // Audio del video como capa aparte (si el navegador puede decodificarlo).
        try {
          const buf = await media.ctx().decodeAudioData(await f.arrayBuffer());
          if (buf.duration > 0) {
            const al = makeAudioLayer(path, '🔊 ' + f.name);
            al.timing_offset = vl.timing_offset;
            setClipRange(al, start, start + frames - 1, ...range());
            addLayerNoUndo(al, true);
          }
        } catch { /* video sin audio */ }
        status(`Video importado (${d ? d.toFixed(1) + ' s' : ''})`);
      } else if (f.type.startsWith('audio/') || isAudioPath(f.name)) {
        const path = await storeMedia(f);
        const buf = await media.ctx().decodeAudioData(await f.arrayBuffer());
        const start = S.frame > 0 ? S.frame : S.doc.project_data.start_frame;
        const al = makeAudioLayer(path);
        al.timing_offset = start - 1;
        const frames = Math.round(buf.duration * fps());
        extendDocTo(start + frames - 1);
        setClipRange(al, start, start + frames - 1, ...range());
        addLayerNoUndo(al, true);
        status(`Audio importado (${buf.duration.toFixed(1)} s)`);
      } else if (f.type.startsWith('image/')) {
        const path = await storeMedia(f);
        const { w, h } = await mediaSize(f, 'image');
        const [ww, hh] = fitSize(w, h);
        addLayerNoUndo(makeImageLayer(path, ww, hh));
        status('Imagen importada');
      } else status(`Tipo no soportado: ${f.name}`);
    } catch (err) { console.error(err); alert(`${f.name}: ${err.message}`); }
  }
  $('dropHint').style.display = 'none';
  refreshAll();
}

// ======================= Render =======================
function renderOffscreen(width, frame = S.frame) {
  const pd = S.doc.project_data;
  const h = Math.round(width * pd.height / pd.width);
  const c = document.createElement('canvas'); c.width = width; c.height = h;
  renderDoc(c.getContext('2d'), S.doc, frame, { ox: 0, oy: 0, w: width, h }, { flexi: $('optFlexi').checked, media });
  return c;
}
const renderToBlob = (w, type = 'image/png') => new Promise((r) => renderOffscreen(w).toBlob(r, type, 0.85));

function viewRect() {
  const pd = S.doc.project_data;
  const cw = canvas.width, ch = canvas.height;
  const pad = 30 * DPR();
  const fit = Math.min((cw - pad * 2) / pd.width, (ch - pad * 2) / pd.height);
  const w = pd.width * fit * S.viewZoom, h = pd.height * fit * S.viewZoom;
  return { ox: (cw - w) / 2 + S.panX, oy: (ch - h) / 2 + S.panY, w, h };
}

function draw() {
  const dpr = DPR();
  const r = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!S.doc) return;
  syncMedia(S.playing || S.exporting);
  const view = viewRect();
  const base = { flexi: $('optFlexi').checked, media };
  g.save();
  g.shadowColor = 'rgba(139,92,246,0.35)'; g.shadowBlur = 40 * dpr;
  g.fillStyle = '#000'; g.fillRect(view.ox, view.oy, view.w, view.h);
  g.restore();
  g.save();
  g.beginPath(); g.rect(view.ox, view.oy, view.w, view.h); g.clip();
  const bc = S.doc.project_data.back_color || { r: 234, g: 234, b: 234 };
  g.fillStyle = `rgb(${bc.r},${bc.g},${bc.b})`; g.fillRect(view.ox, view.oy, view.w, view.h);
  if ($('optOnion').checked && !S.playing) {
    for (const [d, a] of [[-2, 0.12], [-1, 0.25], [1, 0.18]]) {
      const f = S.frame + d;
      if (f >= 0 && f <= S.doc.project_data.end_frame) renderDoc(g, S.doc, f, view, { ...base, noBackground: true, alpha: a });
    }
  }
  S.info = renderDoc(g, S.doc, S.frame, view, {
    ...base, noBackground: true, alpha: $('optOnion').checked && !S.playing ? 0.85 : 1,
    showBones: $('optBones').checked && !S.playing, showPoints: $('optPoints').checked && !S.playing,
    showImages: $('optImages').checked, selected: S.selLayer?.uuid, selPoints: S.selPoints, selBone: S.selBone,
  });
  g.restore();
  drawOverlays();
  const pd = S.doc.project_data;
  $('frameInfo').textContent = fmtTime(S.frame / pd.fps);
  $('zoomLabel').textContent = Math.round(S.viewZoom * 100) + '%';
}
const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;

function selBBox() {
  const li = S.selLayer && S.info?.layers.get(S.selLayer.uuid);
  if (!li?.P || S.selPoints.size < 2) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of S.selPoints) { const [x, y] = li.P[i] || [0, 0]; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (x1 - x0 < 2 && y1 - y0 < 2) return null;
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
function bboxHandles(b) {
  const r = 18 * DPR();
  return {
    corners: [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]],
    rot: [b.cx, b.y0 - r],
  };
}

function drawOverlays() {
  const dpr = DPR();
  g.save();
  if (S.tool === 'points' && !S.playing) {
    const b = selBBox();
    if (b) {
      const h = bboxHandles(b);
      g.strokeStyle = '#a78bfa'; g.lineWidth = dpr; g.setLineDash([4 * dpr, 3 * dpr]);
      g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.setLineDash([]);
      g.fillStyle = '#fff';
      for (const [x, y] of h.corners) { g.fillRect(x - 4 * dpr, y - 4 * dpr, 8 * dpr, 8 * dpr); g.strokeRect(x - 4 * dpr, y - 4 * dpr, 8 * dpr, 8 * dpr); }
      g.beginPath(); g.moveTo(b.cx, b.y0); g.lineTo(...h.rot); g.stroke();
      g.beginPath(); g.arc(...h.rot, 5 * dpr, 0, 7); g.fill(); g.stroke();
    }
  }
  const d = S.drag;
  if (d?.box) {
    const b = d.box;
    g.strokeStyle = '#a78bfa'; g.setLineDash([5 * dpr, 4 * dpr]); g.lineWidth = dpr;
    if (d.tool === 'ellipse') { g.beginPath(); g.ellipse((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, Math.abs(b[2] - b[0]) / 2, Math.abs(b[3] - b[1]) / 2, 0, 0, 7); g.stroke(); }
    else { if (d.tool === 'marquee') { g.fillStyle = 'rgba(139,92,246,0.12)'; g.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]); } g.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]); }
    g.setLineDash([]);
  }
  if (d?.newBone) {
    const [a, b] = d.newBone;
    g.strokeStyle = '#ec4899'; g.lineWidth = 3 * dpr; g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
  }
  if (S.pencil) {
    g.strokeStyle = $('lineColor').value; g.lineWidth = 2 * dpr; g.beginPath();
    S.pencil.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  }
  if (S.pen) {
    const P = S.pen.pts;
    g.strokeStyle = '#a78bfa'; g.lineWidth = 1.5 * dpr; g.beginPath();
    P.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    if (S.pen.hover) g.lineTo(...S.pen.hover);
    g.stroke();
    P.forEach(([x, y], i) => {
      g.fillStyle = i === 0 ? '#facc15' : (S.pen.smooth[i] ? '#fff' : '#a78bfa');
      g.beginPath(); g.arc(x, y, (i === 0 ? 5 : 4) * dpr, 0, 7); g.fill(); g.stroke();
    });
  }
  g.restore();
}

// ======================= Medios: video y audio =======================
function videoLayers() {
  return S.doc ? allLayers(S.doc.layers).filter((l) => l.type === 'ImageLayer' && isVideoPath(l.image_path)) : [];
}

function syncMedia(playing) {
  if (!S.doc) return;
  const [st, en] = range();
  for (const l of videoLayers()) {
    const e = media.get(l.image_path);
    if (e?.status !== 'ready') continue;
    const v = e.el;
    let t = clipTime(l, S.frame, fps());
    if (v.duration) t = l.movie_looping ? t % v.duration : Math.min(t, v.duration - 0.01);
    const r = clipRange(l, st, en);
    const inRange = r && S.frame >= r[0] && S.frame <= r[1] && l.visible !== false;
    if (playing && inRange) {
      if (v.paused) { v.currentTime = t; v.play().catch(() => {}); }
      else if (Math.abs(v.currentTime - t) > 0.3) v.currentTime = t;
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - t) > 0.5 / fps()) v.currentTime = t;
    }
  }
}

let audioNodes = [];
function startAudio(fromFrame, dest) {
  stopAudio();
  const ctx = media.ctx();
  if (ctx.state === 'suspended') ctx.resume();
  const [st, en] = range();
  for (const l of allLayers(S.doc.layers)) {
    if (l.type !== 'AudioLayer' || l.visible === false) continue;
    const e = media.get(l.audio_path);
    if (e?.status !== 'ready' || !e.buffer) continue;
    const r = clipRange(l, st, en);
    if (!r || fromFrame > r[1]) continue;
    const sf = Math.max(fromFrame, r[0]);
    const offset = clipTime(l, sf, fps()) + (evalChannel(l.audio_jump, 0) || 0);
    if (offset >= e.buffer.duration) continue;
    const src = ctx.createBufferSource(); src.buffer = e.buffer;
    const gain = ctx.createGain(); gain.gain.value = evalChannel(l.audio_level, sf) ?? 1;
    src.connect(gain).connect(dest || ctx.destination);
    src.start(ctx.currentTime + (sf - fromFrame) / fps(), offset, (r[1] - sf + 1) / fps());
    audioNodes.push(src);
  }
}
function stopAudio() { for (const n of audioNodes) { try { n.stop(); } catch { /* ya parado */ } } audioNodes = []; }

// ======================= Exportar =======================
async function exportVideo() {
  if (!S.doc || S.exporting) return;
  stopPlayback();
  const pd = S.doc.project_data;
  const w = Math.min(pd.width, 1920), h = Math.round(w * pd.height / pd.width);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const cg = c.getContext('2d');
  const actx = media.ctx(); await actx.resume();
  const dest = actx.createMediaStreamDestination();
  const stream = new MediaStream([...c.captureStream(pd.fps).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const finished = new Promise((r) => (rec.onstop = r));
  S.exporting = true;
  rec.start(250);
  startAudio(pd.start_frame, dest);
  const t0 = performance.now();
  let last = -1;
  while (S.exporting) {
    const f = pd.start_frame + Math.floor((performance.now() - t0) / 1000 * pd.fps);
    if (f > pd.end_frame) break;
    if (f !== last) {
      S.frame = f; syncMedia(true);
      renderDoc(cg, S.doc, f, { ox: 0, oy: 0, w, h }, { flexi: $('optFlexi').checked, media });
      status(`Exportando ${ext.toUpperCase()}… ${f}/${pd.end_frame} (Esc cancela)`);
      last = f;
    }
    await new Promise((r) => setTimeout(r, 1000 / pd.fps / 3));
  }
  const cancelled = !S.exporting;
  S.exporting = false;
  stopAudio(); syncMedia(false);
  rec.stop(); await finished;
  if (cancelled) { status('Exportación cancelada'); return; }
  download(new Blob(chunks, { type: mimeType }), S.fileName.replace(/\.moho$/, '.' + ext));
  status(`Video exportado (${ext})`);
}

// ======================= Capas =======================
const KIND = { MeshLayer: '✎', GroupLayer: '▤', BoneLayer: '🦴', ImageLayer: '🖼', SwitchLayer: '⇄', ParticleLayer: '✺', TextLayer: 'T', AudioLayer: '♪', NoteLayer: '🗒', PatchLayer: '◩', Mesh3DLayer: '◆' };
const isVideoLayer = (l) => l.type === 'ImageLayer' && isVideoPath(l.image_path);
const kindIcon = (l) => icon(isVideoLayer(l) ? 'film' : LAYER_ICON[l.type] || 'layers', 15);
const TYPE_NAME = { MeshLayer: 'Vector', GroupLayer: 'Grupo', BoneLayer: 'Huesos', ImageLayer: 'Imagen', SwitchLayer: 'Switch', ParticleLayer: 'Partículas', TextLayer: 'Texto', AudioLayer: 'Audio', NoteLayer: 'Nota', PatchLayer: 'Parche', Mesh3DLayer: '3D' };
const typeName = (l) => (isVideoLayer(l) ? 'Video' : TYPE_NAME[l.type] || l.type);
const collapsed = new Set();

function buildLayerTree() {
  const root = $('layerTree'); root.innerHTML = '';
  const mk = (layers, ul, depth) => {
    for (const l of [...layers].reverse()) { // Moho muestra arriba la capa superior
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'row' + (S.selLayer === l ? ' sel' : '');
      row.style.paddingLeft = 6 + depth * 14 + 'px';
      const hasKids = Array.isArray(l.layers) && l.layers.length;
      row.innerHTML = `<span class="twisty">${hasKids ? (collapsed.has(l.uuid) ? '▸' : '▾') : ''}</span>
        <span class="eye ${l.visible === false ? 'off' : ''}" title="Mostrar/ocultar">${icon(l.visible === false ? 'eyeOff' : 'eye', 15)}</span>
        <span class="kind ${isVideoLayer(l) ? 'video' : l.type}">${kindIcon(l)}</span><span class="name"></span>`;
      row.querySelector('.name').textContent = l.name;
      row.title = l.type;
      row.querySelector('.eye').onclick = (e) => { e.stopPropagation(); pushUndo(); l.visible = l.visible === false; buildLayerTree(); requestDraw(); };
      row.querySelector('.twisty').onclick = (e) => { e.stopPropagation(); collapsed.has(l.uuid) ? collapsed.delete(l.uuid) : collapsed.add(l.uuid); buildLayerTree(); };
      row.onclick = () => selectLayer(l);
      row.ondblclick = () => { const n = prompt('Nombre de la capa', l.name); if (n) { pushUndo(); l.name = n; buildLayerTree(); drawTracks(); } };
      li.appendChild(row);
      if (hasKids && !collapsed.has(l.uuid)) {
        const sub = document.createElement('ul'); mk(l.layers, sub, depth + 1); li.appendChild(sub);
      }
      ul.appendChild(li);
    }
  };
  if (S.doc) mk(S.doc.layers, root, 0);
}

function selectLayer(l) {
  S.selLayer = l; S.selPoints.clear();
  if (S.selBone && S.selBone.layer !== l?.uuid) S.selBone = null;
  buildLayerTree(); updateProps(); updateTimeline(); requestDraw();
}

function findParent(target, layers = S.doc.layers, parent = null) {
  for (const l of layers) {
    if (l === target) return { list: layers, parent };
    if (l.layers) { const r = findParent(target, l.layers, l); if (r) return r; }
  }
  return null;
}
function findLayerByUuid(uuid, layers = S.doc.layers) {
  for (const l of layers) {
    if (l.uuid === uuid) return l;
    if (l.layers) { const r = findLayerByUuid(uuid, l.layers); if (r) return r; }
  }
  return null;
}

// Inserta encima de la selección (o dentro si es contenedor). bottom=true: al fondo de la raíz (audio).
function addLayerNoUndo(layer, bottom = false) {
  const sel = S.selLayer;
  if (bottom) S.doc.layers.unshift(layer);
  else if (sel && Array.isArray(sel.layers) && sel.type !== 'SwitchLayer') sel.layers.push(layer);
  else if (sel && findParent(sel)) { const p = findParent(sel); p.list.splice(p.list.indexOf(sel) + 1, 0, layer); }
  else S.doc.layers.push(layer);
  if (!bottom) S.selLayer = layer;
}
function insertLayer(layer) { pushUndo(); addLayerNoUndo(layer); selectLayer(layer); drawTracks(); }

// Espacio de coordenadas donde vivirá una capa nueva (matriz espacio->mundo y profundidad).
function newLayerSpace() {
  const sel = S.selLayer;
  const li = sel && S.info?.layers.get(sel.uuid);
  if (!li) return { M: [1, 0, 0, 1, 0, 0], z: 0 };
  if (Array.isArray(sel.layers)) return { M: li.M, z: li.z };
  return { M: li.parentM, z: li.z - ((evalChannel(sel.transforms?.translation, S.frame) || {}).z || 0) };
}

function moveLayer(dir) {
  const l = S.selLayer; if (!l) return;
  const p = findParent(l); const i = p.list.indexOf(l);
  const j = i + dir; // +1 = subir (más arriba en el apilado)
  if (j < 0 || j >= p.list.length) return;
  pushUndo();
  p.list.splice(i, 1); p.list.splice(j, 0, l);
  buildLayerTree(); requestDraw();
}

// ======================= Panel de propiedades =======================
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e[k] = v; else if (k in e && k !== 'list') e[k] = v; else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}
const section = (t) => el('div', { className: 'section', textContent: t });
function row(label, input) { return el('div', { className: 'prop' }, el('label', { textContent: label }), input); }
function num(label, value, onChange, step = 'any') {
  const i = el('input', { type: 'number', step, value: +(+value).toFixed(4) });
  i.onchange = () => { pushUndo(); onChange(parseFloat(i.value)); afterEdit(); };
  return row(label, i);
}
function text(label, value, onChange) {
  const i = el('input', { type: 'text', value });
  if (!onChange) i.disabled = true; else i.onchange = () => { pushUndo(); onChange(i.value); afterEdit(); };
  return row(label, i);
}
function slider(label, value, min, max, step, onInput) {
  const i = el('input', { type: 'range', min, max, step, value });
  const out = el('span', { className: 'muted', textContent: (+value).toFixed(2) });
  i.onpointerdown = () => pushUndo();
  i.oninput = () => { out.textContent = (+i.value).toFixed(2); onInput(+i.value); requestDraw(); };
  i.onchange = () => updateTimeline();
  const wrap = el('div', { style: 'display:grid;grid-template-columns:1fr 38px;gap:4px;align-items:center' }, i, out);
  return row(label, wrap);
}
function afterEdit() { buildLayerTree(); updateTimeline(); requestDraw(); }

function shapesForEdit(l) {
  const m = l.mesh;
  if (!S.selPoints.size) return m.shapes;
  return m.shapes.filter((sh) => sh.edges.curve.some((ci) => m.curves[ci]?.points.some((cp) => S.selPoints.has(cp.point))));
}

function updateProps() {
  const p = $('props'); p.innerHTML = '';
  const l = S.selLayer;
  if (!l && !S.selBone) { p.append(section('Propiedades'), el('div', { className: 'muted', style: 'padding:8px 10px', textContent: 'Selecciona una capa, un clip o un hueso.' })); return; }
  const f = S.frame, lf = f - (l?.timing_offset || 0);
  if (l) {
    p.append(section(`Capa · ${typeName(l)}`));
    p.append(text('Nombre', l.name, (v) => { l.name = v; }));
    if (l.transforms && l.type !== 'AudioLayer') {
      const t = l.transforms;
      const tr = evalChannel(t.translation, lf) || { x: 0, y: 0, z: 0 };
      const rz = evalChannel(t.rotation_z, lf) || 0;
      const sc = evalChannel(t.scale, lf) || { x: 1, y: 1, z: 1 };
      p.append(section('Transformación'));
      p.append(num('Pos X', tr.x, (v) => setKey(t.translation, lf, { ...tr, x: v })));
      p.append(num('Pos Y', tr.y, (v) => setKey(t.translation, lf, { ...tr, y: v })));
      p.append(num('Profundidad Z', tr.z || 0, (v) => setKey(t.translation, lf, { ...tr, z: v })));
      p.append(num('Rotación °', rz * 180 / Math.PI, (v) => setKey(t.rotation_z, lf, v * Math.PI / 180)));
      p.append(num('Escala X', sc.x, (v) => setKey(t.scale, lf, { ...sc, x: v })));
      p.append(num('Escala Y', sc.y, (v) => setKey(t.scale, lf, { ...sc, y: v })));
      const flip = el('div', { className: 'btnrow' },
        el('button', { textContent: '⇋ Voltear H', onclick: () => { pushUndo(); setKey(t.flip_h, lf, !evalChannel(t.flip_h, lf)); afterEdit(); } }),
        el('button', { textContent: '⇵ Voltear V', onclick: () => { pushUndo(); setKey(t.flip_v, lf, !evalChannel(t.flip_v, lf)); afterEdit(); } }));
      p.append(row('', flip));
    }

    if (l.mesh) {
      const m = l.mesh;
      p.append(section('Estilo (relleno y trazo)'));
      p.append(el('div', { className: 'muted', style: 'padding:0 10px', textContent: `${m.points.length} puntos · ${m.curves.length} curvas · ${m.shapes.length} formas` + (S.selPoints.size ? ` · ${S.selPoints.size} puntos selec.` : '') }));
      const shapes = shapesForEdit(l);
      const sh = shapes[0];
      if (sh) {
        const st = sh.style;
        const fc = evalChannel(st.fill_color, f) || { r: 1, g: 1, b: 1, a: 1 };
        const lc = evalChannel(st.line_color, f) || { r: 0, g: 0, b: 0, a: 1 };
        const apply2 = (fn) => { for (const s of shapes) fn(s); };
        const fillIn = el('input', { type: 'color', value: colorToHex(fc) });
        fillIn.onfocus = pushUndo;
        fillIn.oninput = () => { apply2((s) => { s.style.define_fill_color = true; setKey(s.style.fill_color, f, hexToColor(fillIn.value, (evalChannel(s.style.fill_color, f) || {}).a ?? 1)); }); requestDraw(); };
        const lineIn = el('input', { type: 'color', value: colorToHex(lc) });
        lineIn.onfocus = pushUndo;
        lineIn.oninput = () => { apply2((s) => { s.style.define_line_col = true; setKey(s.style.line_color, f, hexToColor(lineIn.value, (evalChannel(s.style.line_color, f) || {}).a ?? 1)); }); requestDraw(); };
        const fillOn = el('input', { type: 'checkbox', checked: !!sh.has_fill, onchange: (e) => { pushUndo(); apply2((s) => (s.has_fill = e.target.checked)); requestDraw(); } });
        const lineOn = el('input', { type: 'checkbox', checked: !!sh.has_outline, onchange: (e) => { pushUndo(); apply2((s) => (s.has_outline = e.target.checked)); requestDraw(); } });
        p.append(row('Relleno', el('div', { className: 'check' }, fillIn, el('label', {}, fillOn, ' activo'))));
        p.append(slider('Opac. relleno', fc.a ?? 1, 0, 1, 0.01, (v) => apply2((s) => setKey(s.style.fill_color, f, { ...(evalChannel(s.style.fill_color, f)), a: v }))));
        p.append(row('Trazo', el('div', { className: 'check' }, lineIn, el('label', {}, lineOn, ' activo'))));
        const H = S.doc.project_data.height;
        p.append(num('Grosor px', (st.line_width ?? 0.005556) * H, (v) => apply2((s) => { s.style.define_line_width = true; s.style.line_width = v / H; })));
      }
      if (S.selPoints.size) {
        p.append(section('Puntos'));
        p.append(el('div', { className: 'btnrow', style: 'padding:4px 10px' },
          el('button', { textContent: '◇ Esquina', title: 'Punto anguloso', onclick: () => { pushUndo(); setSmoothness(m, S.selPoints, f, 0); afterEdit(); } }),
          el('button', { textContent: '◯ Suave', title: 'Punto curvo', onclick: () => { pushUndo(); setSmoothness(m, S.selPoints, f, 0.3); afterEdit(); } }),
          el('button', { textContent: '🗑 Borrar', title: 'Borrar puntos (Supr)', onclick: deleteSelectedPoints })));
        if (S.selPoints.size === 1) {
          const i = [...S.selPoints][0];
          const pos = evalChannel(m.points[i].position, lf);
          p.append(num('X', pos.x, (v) => setKey(m.points[i].position, lf, { ...pos, x: v })));
          p.append(num('Y', pos.y, (v) => setKey(m.points[i].position, lf, { ...pos, y: v })));
        }
      }
    }

    if (l.type === 'ImageLayer') {
      p.append(section(isVideoPath(l.image_path) ? 'Video' : 'Imagen'));
      p.append(text('Archivo', l.image_path || ''));
      const e = media.get(l.image_path);
      p.append(el('div', { className: 'muted', style: 'padding:0 10px', textContent: `Estado: ${e?.status === 'ready' ? 'cargado' : e?.status === 'loading' ? 'cargando…' : 'falta el archivo (usa Importar para vincularlo)'}` }));
      p.append(num('Ancho', l.width, (v) => { l.width = v; }));
      p.append(num('Alto', l.height, (v) => { l.height = v; }));
      if (isVideoPath(l.image_path)) p.append(row('Bucle', el('input', { type: 'checkbox', checked: !!l.movie_looping, onchange: (ev) => { pushUndo(); l.movie_looping = ev.target.checked; drawTracks(); } })));
    }
    if (l.type === 'AudioLayer') {
      p.append(section('Audio'));
      p.append(text('Archivo', l.audio_path || ''));
      p.append(slider('Volumen', evalChannel(l.audio_level, lf) ?? 1, 0, 2, 0.01, (v) => setKey(l.audio_level, Math.max(0, lf), v)));
    }

    // Clip (edición de video)
    const r = clipRange(l, ...range());
    p.append(section('Clip'));
    p.append(num('Entrada', r ? r[0] : 0, (v) => { const rr = clipRange(l, ...range()) || range(); setClipRange(l, Math.round(v), rr[1], ...range()); }, 1));
    p.append(num('Salida', r ? r[1] : 0, (v) => { const rr = clipRange(l, ...range()) || range(); setClipRange(l, rr[0], Math.round(v), ...range()); }, 1));
    p.append(num('Desfase tiempo', l.timing_offset || 0, (v) => { l.timing_offset = Math.round(v); }, 1));
    const fadeN = Math.round(fps() / 2);
    p.append(el('div', { className: 'btnrow', style: 'padding:4px 10px' },
      el('button', { textContent: '◢ Fundido entrada', onclick: () => { pushUndo(); fade(l, 'in', fadeN, ...range()); afterEdit(); } }),
      el('button', { textContent: '◣ Fundido salida', onclick: () => { pushUndo(); fade(l, 'out', fadeN, ...range()); afterEdit(); } }),
      el('button', { textContent: '✂ Cortar aquí', onclick: splitSelected })));

    if (l.type !== 'AudioLayer') {
      const fx = l.layer_effects || {};
      p.append(section('Efectos'));
      p.append(slider('Opacidad', evalChannel(fx.alpha, lf) ?? 1, 0, 1, 0.01, (v) => setKey(ensureEffects(l).alpha, lf, v)));
      p.append(slider('Desenfoque', evalChannel(fx.blur, lf) ?? 0, 0, 40, 0.5, (v) => setKey(ensureEffects(l).blur, lf, v)));
      const bsel = el('select', {}, ...BLEND_NAMES.map((n, i) => el('option', { value: i, textContent: n })));
      bsel.value = l.blend_mode || 0;
      bsel.onchange = () => { pushUndo(); l.blend_mode = +bsel.value; requestDraw(); };
      p.append(row('Fusión', bsel));
      p.append(section('Ajustes de color'));
      const adj = l.web_adjust || {};
      const av = (k, d) => evalChannel(adj[k], lf) ?? d;
      p.append(slider('Brillo', av('brightness', 1), 0, 3, 0.01, (v) => setAdjust(l, 'brightness', lf, v)));
      p.append(slider('Contraste', av('contrast', 1), 0, 3, 0.01, (v) => setAdjust(l, 'contrast', lf, v)));
      p.append(slider('Saturación', av('saturate', 1), 0, 3, 0.01, (v) => setAdjust(l, 'saturate', lf, v)));
      p.append(slider('Tono °', av('hue', 0), -180, 180, 1, (v) => setAdjust(l, 'hue', lf, v)));
      p.append(slider('B/N', av('grayscale', 0), 0, 1, 0.01, (v) => setAdjust(l, 'grayscale', lf, v)));
      p.append(slider('Sepia', av('sepia', 0), 0, 1, 0.01, (v) => setAdjust(l, 'sepia', lf, v)));
      p.append(slider('Invertir', av('invert', 0), 0, 1, 0.01, (v) => setAdjust(l, 'invert', lf, v)));
      p.append(el('div', { className: 'btnrow', style: 'padding:4px 10px' },
        el('button', { textContent: 'Restablecer color', onclick: () => { pushUndo(); delete l.web_adjust; afterEdit(); updateProps(); } })));
    }
    if (l.skeleton) {
      p.append(el('div', { className: 'muted', style: 'padding:4px 10px', textContent: `${l.skeleton.bones.length} huesos · ${(l.actions || []).length} acciones` }));
    }
  }
  const sb = currentBone();
  if (sb) {
    const { bone } = sb;
    p.append(section('🦴 Hueso'));
    p.append(text('Nombre', bone.name, (v) => { bone.name = v; }));
    p.append(text('Padre', String(bone.parent)));
    p.append(num('Largo', bone.length, (v) => { bone.length = v; }));
    p.append(num('Ángulo °', (evalChannel(bone.anim_angle, f) || 0) * 180 / Math.PI, (v) => setKey(bone.anim_angle, f, v * Math.PI / 180)));
    p.append(num('Fuerza', bone.strength ?? 1, (v) => { bone.strength = v; }));
  }
}

function updateDocProps() {
  const p = $('docProps'); p.innerHTML = '';
  if (!S.doc) return;
  const pd = S.doc.project_data;
  const res = el('select', {}, ...[['Personalizado', 0, 0], ['Horizontal HD 1280×720', 1280, 720], ['Horizontal Full HD 1920×1080', 1920, 1080], ['Horizontal 4K 3840×2160', 3840, 2160], ['Corto vertical 1080×1920', 1080, 1920], ['Corto vertical HD 720×1280', 720, 1280], ['Cuadrado 1080×1080', 1080, 1080]]
    .map(([n, w, h]) => el('option', { value: `${w}x${h}`, textContent: n })));
  res.value = `${pd.width}x${pd.height}`; if (!res.value) res.value = '0x0';
  res.onchange = () => { const [w, h] = res.value.split('x').map(Number); if (w) { pushUndo(); pd.width = w; pd.height = h; S.viewZoom = 1; S.panX = S.panY = 0; refreshAll(); } };
  p.append(row('Formato', res));
  p.append(num('Ancho', pd.width, (v) => { pd.width = v | 0; }, 1));
  p.append(num('Alto', pd.height, (v) => { pd.height = v | 0; }, 1));
  p.append(num('FPS', pd.fps, (v) => { pd.fps = v; }));
  p.append(num('Frame inicial', pd.start_frame, (v) => { pd.start_frame = v | 0; }, 1));
  p.append(num('Frame final', pd.end_frame, (v) => { pd.end_frame = v | 0; }, 1));
  const bc = pd.back_color;
  const bg = el('input', { type: 'color', value: colorToHex({ r: bc.r / 255, g: bc.g / 255, b: bc.b / 255 }) });
  bg.onfocus = pushUndo;
  bg.oninput = () => { const c = hexToColor(bg.value); pd.back_color = { r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255), a: 255 }; requestDraw(); };
  p.append(row('Fondo', bg));
  p.append(el('div', { className: 'muted', style: 'padding:0 10px', textContent: `Formato v${S.doc.version} · ${S.doc.created_date || ''}` }));
}

// ======================= Línea de tiempo =======================
let LABEL = 130; const ROW = 22;
function selectedKeyOwner() {
  const sb = currentBone();
  if (sb) return sb.bone;
  if (S.selLayer?.mesh && S.selPoints.size) return [...S.selPoints].map((i) => S.selLayer.mesh.points[i]);
  return S.selLayer;
}
const keyOffset = () => (currentBone() ? 0 : S.selLayer?.timing_offset || 0);

function updateTimeline() {
  if (!S.doc) return;
  const pd = S.doc.project_data;
  const sl = $('frameSlider'); sl.max = pd.end_frame; sl.value = S.frame;
  $('frameNum').value = S.frame;
  const r = keysCanvas.getBoundingClientRect();
  keysCanvas.width = r.width * DPR(); keysCanvas.height = r.height * DPR();
  const W = keysCanvas.width, H = keysCanvas.height, d = DPR();
  kg.clearRect(0, 0, W, H);
  kg.fillStyle = 'rgba(5,5,16,0.55)'; kg.fillRect(0, 0, W, H);
  const fx = (f) => 8 * d + (W - 16 * d) * f / Math.max(1, pd.end_frame);
  kg.fillStyle = '#5d6290'; kg.font = `${10 * d}px ui-monospace, monospace`;
  const step = Math.max(1, Math.ceil(pd.end_frame / 24 / 6) * 6);
  for (let f = 0; f <= pd.end_frame; f += step) {
    kg.fillRect(fx(f), 0, 1, H * 0.3);
    kg.fillText(f, fx(f) + 2, H * 0.3 + 9 * d);
  }
  const owner = selectedKeyOwner();
  if (owner) {
    const off = keyOffset();
    kg.fillStyle = '#facc15'; kg.shadowColor = 'rgba(250,204,21,.7)'; kg.shadowBlur = 6 * d;
    for (const k of collectKeys(owner)) {
      const x = fx(k + off), y = H * 0.75;
      kg.beginPath(); kg.moveTo(x, y - 5 * d); kg.lineTo(x + 4 * d, y); kg.lineTo(x, y + 5 * d); kg.lineTo(x - 4 * d, y); kg.fill();
    }
  }
  updateInterpSelect();
  drawTracks();
}

function trackRows() { return S.doc ? [...S.doc.layers].reverse() : []; }
function trackX(f) {
  const W = tracksCanvas.width, d = DPR();
  return LABEL * d + 8 * d + (W - LABEL * d - 16 * d) * f / Math.max(1, S.doc.project_data.end_frame);
}
function trackFrame(x) {
  const W = tracksCanvas.width, d = DPR();
  return (x - LABEL * d - 8 * d) / (W - LABEL * d - 16 * d) * Math.max(1, S.doc.project_data.end_frame);
}
const TRACK_COLORS = { MeshLayer: ['#22d3ee', '#3b82f6'], GroupLayer: ['#6d5bd0', '#8b5cf6'], BoneLayer: ['#f59e0b', '#facc15'], ImageLayer: ['#10b981', '#4ade80'], video: ['#8b5cf6', '#ec4899'], AudioLayer: ['#ec4899', '#fb923c'], SwitchLayer: ['#6366f1', '#a78bfa'] };

function drawTracks() {
  LABEL = document.querySelector('.labelCol')?.offsetWidth || 130;
  if (!S.doc) { tg.clearRect(0, 0, tracksCanvas.width, tracksCanvas.height); return; }
  const rows = trackRows();
  const d = DPR();
  const cssW = tracksCanvas.parentElement.clientWidth;
  tracksCanvas.style.height = rows.length * ROW + 'px';
  tracksCanvas.width = cssW * d; tracksCanvas.height = Math.max(1, rows.length * ROW * d);
  const W = tracksCanvas.width;
  tg.clearRect(0, 0, W, tracksCanvas.height);
  const [st, en] = range();
  tg.font = `${11 * d}px system-ui, sans-serif`; tg.textBaseline = 'middle';
  rows.forEach((l, i) => {
    const y = i * ROW * d, h = ROW * d;
    if (l === S.selLayer) { tg.fillStyle = 'rgba(139,92,246,0.14)'; tg.fillRect(0, y, W, h); }
    tg.fillStyle = 'rgba(150,130,255,0.07)'; tg.fillRect(0, y + h - d, W, d);
    const tc = TRACK_COLORS[isVideoLayer(l) ? 'video' : l.type] || ['#555', '#777'];
    tg.fillStyle = tc[1]; tg.beginPath(); tg.arc(10 * d, y + h / 2, 3.5 * d, 0, 7); tg.fill();
    tg.fillStyle = l.visible === false ? '#5d6290' : '#d9dcf5';
    tg.fillText(l.name.slice(0, 17), 20 * d, y + h / 2);
    const r = clipRange(l, st, en);
    if (!r) return;
    const x0 = trackX(r[0]), x1 = trackX(r[1] + 1);
    const isVid = l.type === 'ImageLayer' && isVideoPath(l.image_path);
    const cc = TRACK_COLORS[isVid ? 'video' : l.type] || ['#555', '#777'];
    const gr = tg.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, cc[0]); gr.addColorStop(1, cc[1]);
    tg.fillStyle = gr;
    tg.globalAlpha = l.visible === false ? 0.3 : (l === S.selLayer ? 0.95 : 0.7);
    roundRect(tg, x0, y + 3 * d, Math.max(2, x1 - x0), h - 6 * d, 4 * d); tg.fill();
    // Forma de onda
    if (l.type === 'AudioLayer') {
      const e = media.get(l.audio_path);
      if (e?.peaks && e.buffer) {
        tg.fillStyle = 'rgba(255,255,255,0.55)';
        const mid = y + h / 2, amp = (h - 8 * d) / 2;
        for (let x = Math.max(x0, LABEL * d); x < x1; x += d) {
          const t = clipTime(l, trackFrame(x), fps());
          const k = Math.floor(t / e.buffer.duration * e.peaks.length);
          const a = e.peaks[k] || 0;
          tg.fillRect(x, mid - a * amp, d, a * amp * 2 || d);
        }
      }
    }
    // Opacidad (fundidos) como línea
    const alpha = l.layer_effects?.alpha;
    if (alpha && alpha.when.length > 1) {
      tg.strokeStyle = 'rgba(255,255,255,0.8)'; tg.lineWidth = d; tg.beginPath();
      for (let f = r[0]; f <= r[1] + 1; f += Math.max(1, Math.floor((r[1] - r[0]) / 200))) {
        const a = evalChannel(alpha, f - (l.timing_offset || 0)) ?? 1;
        const px = trackX(f), py = y + h - 4 * d - a * (h - 8 * d);
        f === r[0] ? tg.moveTo(px, py) : tg.lineTo(px, py);
      }
      tg.stroke();
    }
    tg.globalAlpha = 1;
    tg.fillStyle = 'rgba(255,255,255,0.9)';
    tg.fillRect(x0, y + 3 * d, 2 * d, h - 6 * d); tg.fillRect(x1 - 2 * d, y + 3 * d, 2 * d, h - 6 * d);
  });
  // cabezal
  tg.fillStyle = '#ffffff'; tg.shadowColor = '#ec4899'; tg.shadowBlur = 8 * d;
  tg.fillRect(trackX(S.frame), 0, 2 * d, tracksCanvas.height);
  tg.shadowBlur = 0; tg.fillStyle = 'rgba(150,130,255,0.12)'; tg.fillRect(LABEL * d - d, 0, d, tracksCanvas.height);
}
function roundRect(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

let trackDrag = null;
tracksCanvas.addEventListener('pointerdown', (e) => {
  if (!S.doc) return;
  const d = DPR(), rc = tracksCanvas.getBoundingClientRect();
  const x = (e.clientX - rc.left) * d, y = (e.clientY - rc.top) * d;
  const l = trackRows()[Math.floor(y / (ROW * d))];
  if (x < LABEL * d) { if (l) selectLayer(l); return; }
  tracksCanvas.setPointerCapture(e.pointerId);
  const fr = trackFrame(x);
  const r = l && clipRange(l, ...range());
  if (l && r) {
    const x0 = trackX(r[0]), x1 = trackX(r[1] + 1);
    if (x >= x0 - 6 * d && x <= x1 + 6 * d) {
      if (S.selLayer !== l) selectLayer(l);
      const mode = Math.abs(x - x0) < 7 * d ? 'in' : Math.abs(x - x1) < 7 * d ? 'out' : 'move';
      trackDrag = { l, mode, startF: fr, r, applied: 0, pushed: false };
      tracksCanvas.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';
      return;
    }
  }
  trackDrag = { mode: 'scrub' };
  setFrame(fr);
});
tracksCanvas.addEventListener('pointermove', (e) => {
  const d = DPR(), rc = tracksCanvas.getBoundingClientRect();
  const x = (e.clientX - rc.left) * d;
  if (!trackDrag) {
    const y = (e.clientY - rc.top) * d;
    const l = S.doc && trackRows()[Math.floor(y / (ROW * d))];
    const r = l && x > LABEL * d && clipRange(l, ...range());
    tracksCanvas.style.cursor = r && (Math.abs(x - trackX(r[0])) < 7 * d || Math.abs(x - trackX(r[1] + 1)) < 7 * d) ? 'ew-resize' : 'default';
    return;
  }
  const fr = trackFrame(x);
  if (trackDrag.mode === 'scrub') { setFrame(fr); return; }
  const t = trackDrag;
  const delta = Math.round(fr - t.startF);
  if (delta === t.applied) return;
  if (!t.pushed) { pushUndo(); t.pushed = true; }
  const [st, en] = range();
  if (t.mode === 'move') { moveClip(t.l, delta - t.applied); }
  else if (t.mode === 'in') setClipRange(t.l, Math.min(t.r[1], Math.max(0, t.r[0] + delta)), t.r[1], st, en);
  else setClipRange(t.l, t.r[0], Math.max(t.r[0], t.r[1] + delta), st, en);
  t.applied = delta;
  status(t.mode === 'move' ? `Mover clip ${delta > 0 ? '+' : ''}${delta} frames` : `Recortar ${t.mode === 'in' ? 'entrada' : 'salida'}`);
  requestDraw();
});
tracksCanvas.addEventListener('pointerup', () => {
  if (trackDrag?.pushed) { updateProps(); updateTimeline(); }
  trackDrag = null; tracksCanvas.style.cursor = 'default';
});

function splitSelected() {
  const l = S.selLayer;
  if (!l) { status('Selecciona un clip para cortar'); return; }
  pushUndo();
  const copy = splitClip(l, S.frame, ...range());
  if (!copy) { S.undo.pop(); status('El cabezal no está dentro del clip'); return; }
  const p = findParent(l); p.list.splice(p.list.indexOf(l) + 1, 0, copy);
  selectLayer(copy);
  status(`Clip cortado en el frame ${S.frame}`);
}

function channelsAtFrame(owner) {
  const out = [];
  const kf = S.frame - keyOffset();
  const walk = (o, dd = 0) => {
    if (!o || typeof o !== 'object' || dd > 10) return;
    if (Array.isArray(o.when) && Array.isArray(o.val)) { if (o.when.includes(kf)) out.push(o); return; }
    for (const k in o) if (k !== 'layers') walk(o[k], dd + 1);
  };
  walk(owner);
  return out;
}

function updateInterpSelect() {
  const sel = $('interpSelect');
  const chans = channelsAtFrame(selectedKeyOwner());
  sel.disabled = chans.length === 0;
  const kf = S.frame - keyOffset();
  const cur = chans[0] ? chans[0].interp[chans[0].when.indexOf(kf)]?.im : undefined;
  if (cur === undefined) sel.selectedIndex = 0; else sel.value = cur;
}

function setFrame(f) {
  if (!S.doc) return;
  S.frame = Math.max(0, Math.min(S.doc.project_data.end_frame, Math.round(f)));
  $('frameSlider').value = S.frame; $('frameNum').value = S.frame;
  updateInterpSelect(); draw(); drawTracks();
  if (!S.playing) updateProps();
}

// ======================= Reproducción =======================
let playT0 = 0, playF0 = 0, playTimer = null;
function tick() {
  if (!S.playing) return;
  const pd = S.doc.project_data;
  let f = playF0 + Math.floor((performance.now() - playT0) / 1000 * pd.fps);
  if (f > pd.end_frame) {
    if ($('optLoop').checked) { playF0 = pd.start_frame; playT0 = performance.now(); f = playF0; startAudio(f); }
    else { setFrame(pd.end_frame); stopPlayback(); return; }
  }
  if (f !== S.frame) setFrame(f);
  playTimer = setTimeout(tick, 1000 / pd.fps / 2);
}
function togglePlay() {
  if (!S.doc) return;
  if (S.playing) { stopPlayback(); return; }
  S.playing = true;
  $('btnPlay').classList.add('playing');
  const pd = S.doc.project_data;
  if (S.frame >= pd.end_frame || S.frame < pd.start_frame) S.frame = pd.start_frame;
  playF0 = S.frame; playT0 = performance.now();
  startAudio(S.frame);
  tick();
}
function stopPlayback() {
  if (S.exporting) S.exporting = false;
  if (!S.playing) return;
  S.playing = false; clearTimeout(playTimer);
  $('btnPlay').classList.remove('playing');
  stopAudio(); syncMedia(false); updateProps(); draw();
}

// ======================= Deshacer =======================
function pushUndo() {
  if (!S.doc) return;
  S.undo.push(JSON.stringify(S.doc)); if (S.undo.length > 60) S.undo.shift();
  S.redo = [];
}
function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(S.doc));
  const selUuid = S.selLayer?.uuid;
  S.doc = JSON.parse(from.pop());
  S.selLayer = selUuid ? findLayerByUuid(selUuid) : null;
  S.selPoints.clear();
  refreshAll();
}

// ======================= Herramientas de lienzo =======================
function currentBone() {
  if (!S.selBone || !S.doc) return null;
  const layer = findLayerByUuid(S.selBone.layer);
  const bone = layer?.skeleton?.bones[S.selBone.index];
  return bone ? { layer, bone, index: S.selBone.index } : null;
}

const evPos = (e) => {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * DPR(), (e.clientY - r.top) * DPR()];
};

function screenToWorld([sx, sy], z = 0) {
  const view = viewRect(); const { cam, scale } = S.info;
  const persp = cam.z / Math.max(0.05, cam.z - z);
  let dx = (sx - view.ox - view.w / 2) / scale / persp, dy = -(sy - view.oy - view.h / 2) / scale / persp;
  if (cam.roll) { const c = Math.cos(cam.roll), s = Math.sin(cam.roll); [dx, dy] = [dx * c - dy * s, dx * s + dy * c]; }
  return [cam.x + dx, cam.y + dy];
}
// pantalla -> espacio local de una matriz (capa)
function screenToLocal(p, M, z) { return apply(inv(M), ...screenToWorld(p, z)); }

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
}

function pickBone(p) {
  let best = null, bd = 10 * DPR();
  for (const b of S.info?.bones || []) {
    (b.screen || []).forEach(([a, c], i) => {
      if (b.sk.bones[i].hidden) return;
      const d = segDist(p, a, c);
      if (d < bd) { bd = d; best = { layer: b.layer.uuid, index: i }; }
    });
  }
  return best;
}

function beginPointsTransform(mode, p, li) {
  const lf = S.frame - (S.selLayer.timing_offset || 0);
  const init = new Map();
  for (const i of S.selPoints) init.set(i, { local: evalChannel(S.selLayer.mesh.points[i].position, lf), screen: li.P[i] });
  const b = selBBox() || { cx: p[0], cy: p[1] };
  S.drag.pts = { mode, init, c: [b.cx, b.cy], lf, li };
}

function applyPointsTransform(p, e) {
  const { mode, init, c, lf, li } = S.drag.pts;
  const s0 = S.drag.start;
  const Minv = inv(li.M);
  let kx = 1, ky = 1, ang = 0;
  if (mode === 'scale') {
    kx = Math.abs(s0[0] - c[0]) > 2 ? (p[0] - c[0]) / (s0[0] - c[0]) : 1;
    ky = Math.abs(s0[1] - c[1]) > 2 ? (p[1] - c[1]) / (s0[1] - c[1]) : 1;
    if (e.shiftKey) { const k = Math.max(Math.abs(kx), Math.abs(ky)); kx = Math.sign(kx || 1) * k; ky = Math.sign(ky || 1) * k; }
  } else if (mode === 'rotate') {
    ang = Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(s0[1] - c[1], s0[0] - c[0]);
    if (e.shiftKey) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
  }
  for (const [i, { local, screen }] of init) {
    let tx, ty;
    if (mode === 'move') { tx = screen[0] + p[0] - s0[0]; ty = screen[1] + p[1] - s0[1]; }
    else if (mode === 'scale') { tx = c[0] + (screen[0] - c[0]) * kx; ty = c[1] + (screen[1] - c[1]) * ky; }
    else { const dx = screen[0] - c[0], dy = screen[1] - c[1]; tx = c[0] + dx * Math.cos(ang) - dy * Math.sin(ang); ty = c[1] + dx * Math.sin(ang) + dy * Math.cos(ang); }
    const w0 = screenToWorld(screen, li.z), w1 = screenToWorld([tx, ty], li.z);
    const dxw = w1[0] - w0[0], dyw = w1[1] - w0[1];
    setKey(S.selLayer.mesh.points[i].position, lf, { x: local.x + Minv[0] * dxw + Minv[2] * dyw, y: local.y + Minv[1] * dxw + Minv[3] * dyw });
  }
}

canvas.addEventListener('pointerdown', (e) => {
  if (!S.doc || !S.info || S.playing) return;
  canvas.setPointerCapture(e.pointerId);
  const p = evPos(e);
  const tool = e.button === 1 || S.spaceDown ? 'pan' : S.tool;
  S.drag = { start: p, last: p, tool, pushed: false };
  const dpr = DPR();

  if (tool === 'points') {
    const li = S.selLayer && S.info.layers.get(S.selLayer.uuid);
    if (!li?.P) { S.drag.tool = 'none'; status('Selecciona una capa vectorial para editar puntos'); return; }
    const b = selBBox();
    if (b) {
      const h = bboxHandles(b);
      if (Math.hypot(p[0] - h.rot[0], p[1] - h.rot[1]) < 9 * dpr) { beginPointsTransform('rotate', p, li); return; }
      if (h.corners.some(([x, y]) => Math.abs(p[0] - x) < 7 * dpr && Math.abs(p[1] - y) < 7 * dpr)) { beginPointsTransform('scale', p, li); return; }
    }
    let best = -1, bd = 8 * dpr;
    li.P.forEach(([x, y], i) => { const d = Math.hypot(x - p[0], y - p[1]); if (d < bd) { bd = d; best = i; } });
    if (best < 0) {
      if (b && p[0] > b.x0 && p[0] < b.x1 && p[1] > b.y0 && p[1] < b.y1) { beginPointsTransform('move', p, li); return; }
      if (!e.shiftKey) S.selPoints.clear();
      S.drag.tool = 'marquee'; S.drag.box = [p[0], p[1], p[0], p[1]]; S.drag.add = e.shiftKey;
    } else {
      if (e.shiftKey) S.selPoints.has(best) ? S.selPoints.delete(best) : S.selPoints.add(best);
      else if (!S.selPoints.has(best)) { S.selPoints.clear(); S.selPoints.add(best); }
      beginPointsTransform('move', p, li);
    }
    updateProps(); updateTimeline(); draw();
  } else if (tool === 'layer') {
    const l = S.selLayer, li = l && S.info.layers.get(l.uuid);
    if (!li || !l.transforms) { S.drag.tool = 'none'; status('Selecciona una capa para transformarla'); return; }
    const o = l.origin || { x: 0, y: 0 };
    const w = apply(li.M, o.x, o.y);
    S.drag.pivot = S.info.toScreen(w[0], w[1], li.z);
    S.drag.li = li;
  } else if (tool === 'bone') {
    const hit = pickBone(p);
    S.selBone = hit ? { layer: hit.layer, index: hit.index } : null;
    if (hit) { const l = findLayerByUuid(hit.layer); if (S.selLayer !== l) { S.selLayer = l; buildLayerTree(); } }
    else S.drag.tool = 'none';
    updateProps(); updateTimeline(); draw();
  } else if (tool === 'addbone') {
    if (S.selLayer?.type !== 'BoneLayer') { status('Selecciona (o crea con 🦴) una capa de huesos primero'); S.drag.tool = 'none'; return; }
    S.drag.newBone = [p, p];
  } else if (tool === 'rect' || tool === 'ellipse') {
    S.drag.box = [p[0], p[1], p[0], p[1]];
  } else if (tool === 'pen') {
    if (!S.pen) S.pen = { pts: [], smooth: [] };
    const P = S.pen.pts;
    if (P.length >= 2 && Math.hypot(p[0] - P[0][0], p[1] - P[0][1]) < 9 * dpr) { finishPen(true); S.drag.tool = 'none'; return; }
    P.push(p); S.pen.smooth.push(0);
    S.drag.penIndex = P.length - 1;
  } else if (tool === 'pencil') {
    S.pencil = [p];
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = evPos(e);
  if (!S.drag) {
    if (S.pen) { S.pen.hover = p; draw(); }
    if (S.info && S.doc) { const w = screenToWorld(p); status(`x ${w[0].toFixed(3)}  y ${w[1].toFixed(3)}`); }
    return;
  }
  const d = S.drag;
  const dx = p[0] - d.last[0], dy = p[1] - d.last[1];
  if (d.tool === 'pan') { S.panX += dx; S.panY += dy; draw(); }
  else if (d.pts) {
    if (!d.pushed) { pushUndo(); d.pushed = true; }
    applyPointsTransform(p, e); draw();
  } else if (d.tool === 'layer') {
    const l = S.selLayer, t = l.transforms, lf = S.frame - (l.timing_offset || 0);
    if (!d.pushed) { pushUndo(); d.pushed = true; }
    if (e.shiftKey) {
      const a0 = Math.atan2(d.last[1] - d.pivot[1], d.last[0] - d.pivot[0]), a1 = Math.atan2(p[1] - d.pivot[1], p[0] - d.pivot[0]);
      let da = -(a1 - a0); if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
      setKey(t.rotation_z, lf, (evalChannel(t.rotation_z, lf) || 0) + da);
    } else if (e.altKey) {
      const k = Math.hypot(p[0] - d.pivot[0], p[1] - d.pivot[1]) / Math.max(1, Math.hypot(d.last[0] - d.pivot[0], d.last[1] - d.pivot[1]));
      const sc = evalChannel(t.scale, lf) || { x: 1, y: 1, z: 1 };
      setKey(t.scale, lf, { ...sc, x: sc.x * k, y: sc.y * k });
    } else {
      const li = d.li;
      const w0 = screenToWorld(d.last, li.z), w1 = screenToWorld(p, li.z);
      const Mi = inv(li.parentM);
      const tr = evalChannel(t.translation, lf) || { x: 0, y: 0, z: 0 };
      setKey(t.translation, lf, { ...tr, x: tr.x + Mi[0] * (w1[0] - w0[0]) + Mi[2] * (w1[1] - w0[1]), y: tr.y + Mi[1] * (w1[0] - w0[0]) + Mi[3] * (w1[1] - w0[1]) });
    }
    draw();
  } else if (d.tool === 'bone') {
    const sb = currentBone(); const entry = S.info.bones.find((b) => b.layer.uuid === S.selBone?.layer);
    if (sb && entry?.screen) {
      if (!d.pushed) { pushUndo(); d.pushed = true; }
      const base = entry.screen[sb.index][0];
      if (e.shiftKey) {
        const w0 = screenToWorld(d.last, entry.z), w1 = screenToWorld(p, entry.z);
        const parentM = sb.bone.parent >= 0 ? mul(entry.W, entry.sk.cur[sb.bone.parent]) : entry.W;
        const Mi = inv(parentM);
        const pos = evalChannel(sb.bone.anim_pos, S.frame);
        setKey(sb.bone.anim_pos, S.frame, { x: pos.x + Mi[0] * (w1[0] - w0[0]) + Mi[2] * (w1[1] - w0[1]), y: pos.y + Mi[1] * (w1[0] - w0[0]) + Mi[3] * (w1[1] - w0[1]) });
      } else {
        const a0 = Math.atan2(d.last[1] - base[1], d.last[0] - base[0]);
        const a1 = Math.atan2(p[1] - base[1], p[0] - base[0]);
        let da = -(a1 - a0);
        if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
        setKey(sb.bone.anim_angle, S.frame, (evalChannel(sb.bone.anim_angle, S.frame) || 0) + da);
      }
      draw();
    }
  } else if (d.newBone) { d.newBone[1] = p; draw(); }
  else if (d.box) { d.box[2] = p[0]; d.box[3] = p[1]; draw(); }
  else if (d.tool === 'pen' && S.pen && d.penIndex !== undefined) {
    const P = S.pen.pts[d.penIndex];
    if (Math.hypot(p[0] - P[0], p[1] - P[1]) > 5 * DPR()) S.pen.smooth[d.penIndex] = 0.3;
    S.pen.hover = p; draw();
  } else if (d.tool === 'pencil' && S.pencil) { S.pencil.push(p); draw(); }
  d.last = p;
});

canvas.addEventListener('pointerup', () => {
  const d = S.drag; S.drag = null;
  if (!d) return;
  if (d.newBone) createBoneFromDrag(d.newBone);
  else if (d.tool === 'marquee') {
    const li = S.info.layers.get(S.selLayer.uuid);
    const [x0, x1] = [Math.min(d.box[0], d.box[2]), Math.max(d.box[0], d.box[2])];
    const [y0, y1] = [Math.min(d.box[1], d.box[3]), Math.max(d.box[1], d.box[3])];
    li.P.forEach(([x, y], i) => { if (x >= x0 && x <= x1 && y >= y0 && y <= y1) S.selPoints.add(i); });
    updateProps(); updateTimeline();
  } else if (d.box) createShapeFromBox(d.tool, d.box);
  else if (d.tool === 'pencil' && S.pencil) finishPencil();
  else if (d.pushed) { updateTimeline(); updateProps(); }
  draw();
});
canvas.addEventListener('dblclick', () => { if (S.pen) finishPen(false); });

function strokeStyleOpts() {
  return { fill: $('fillColor').value, line: $('lineColor').value, width: (+$('strokePx').value || 0) / S.doc.project_data.height };
}

// Añade subrutas (en pantalla) a la capa vectorial seleccionada o a una capa nueva.
function commitScreenPath(screenPts, smooth, closed, name) {
  if (screenPts.length < 2) return;
  const sel = S.selLayer;
  const li = sel?.mesh && S.info.layers.get(sel.uuid);
  pushUndo();
  let layer, space;
  if (li) { layer = sel; space = { M: li.M, z: li.z }; }
  else {
    space = newLayerSpace();
    layer = makeShapeLayer('rect', 0, 0, 0.1, 0.1, '#000000', '#000000');
    layer.name = name; layer.mesh = emptyMesh();
    addLayerNoUndo(layer);
  }
  const pts = screenPts.map((p) => screenToLocal(p, space.M, space.z));
  if (li) {
    const lf = S.frame - (layer.timing_offset || 0);
    if (lf !== 0) status('Nota: los puntos nuevos se crean en la pose del frame 0');
  }
  addPathsToMesh(layer.mesh, [{ pts, smooth, closed }], strokeStyleOpts(), { fill: closed, outline: true });
  selectLayer(layer);
}

function finishPen(closed) {
  const pen = S.pen; S.pen = null;
  if (!pen || pen.pts.length < 2) { draw(); return; }
  commitScreenPath(pen.pts, pen.smooth, closed && pen.pts.length >= 3, 'Trazo');
}

function finishPencil() {
  const raw = S.pencil; S.pencil = null;
  if (!raw || raw.length < 3) return;
  const closed = raw.length > 8 && Math.hypot(raw[0][0] - raw.at(-1)[0], raw[0][1] - raw.at(-1)[1]) < 14 * DPR();
  let pts = simplify(raw, 2.5 * DPR());
  if (closed && pts.length > 3) pts.pop();
  commitScreenPath(pts, autoSmooth(pts, closed, 70), closed, 'Dibujo');
}

function deleteSelectedPoints() {
  const l = S.selLayer;
  if (!l?.mesh || !S.selPoints.size) return;
  pushUndo();
  deletePoints(l.mesh, S.selPoints);
  S.selPoints.clear();
  updateProps(); updateTimeline(); draw();
}

function createBoneFromDrag([a, b]) {
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 4) return;
  const bl = S.selLayer;
  const entry = S.info.bones.find((x) => x.layer === bl);
  const W = entry ? entry.W : (S.info.layers.get(bl.uuid)?.M || [1, 0, 0, 1, 0, 0]);
  const parent = S.selBone && S.selBone.layer === bl.uuid ? S.selBone.index : -1;
  const rest = boneMatrices(bl.skeleton, 0);
  const toLocal = inv(parent >= 0 ? mul(W, rest[parent]) : W);
  const pa = apply(toLocal, ...screenToWorld(a)), pb = apply(toLocal, ...screenToWorld(b));
  pushUndo();
  const bone = makeBone(`B${bl.skeleton.bones.length + 1}`, parent, pa[0], pa[1],
    Math.atan2(pb[1] - pa[1], pb[0] - pa[0]), Math.hypot(pb[0] - pa[0], pb[1] - pa[1]));
  bl.skeleton.bones.push(bone);
  S.selBone = { layer: bl.uuid, index: bl.skeleton.bones.length - 1 };
  updateProps();
}

function createShapeFromBox(kind, box) {
  if (Math.abs(box[2] - box[0]) < 4 || Math.abs(box[3] - box[1]) < 4) return;
  const space = newLayerSpace();
  const a = screenToLocal([box[0], box[1]], space.M, space.z), b = screenToLocal([box[2], box[3]], space.M, space.z);
  const layer = makeShapeLayer(kind, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, $('fillColor').value, $('lineColor').value);
  layer.mesh.shapes[0].style.line_width = strokeStyleOpts().width;
  insertLayer(layer);
}

canvas.addEventListener('wheel', (e) => {
  if (!S.doc) return;
  e.preventDefault();
  const f = Math.exp(-e.deltaY * 0.0015);
  const p = evPos(e);
  const cx = canvas.width / 2 + S.panX, cy = canvas.height / 2 + S.panY;
  S.panX += (p[0] - cx) * (1 - f); S.panY += (p[1] - cy) * (1 - f);
  S.viewZoom *= f; draw();
}, { passive: false });

// ======================= UI =======================
function status(t) { $('status').textContent = t; }

function setTool(t) {
  if (S.pen && t !== 'pen') finishPen(false);
  S.tool = t;
  document.querySelectorAll('#toolbox [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  canvas.style.cursor = { pan: 'grab', rect: 'crosshair', ellipse: 'crosshair', addbone: 'crosshair', pen: 'crosshair', pencil: 'crosshair', layer: 'move' }[t] || 'default';
  draw();
}
document.querySelectorAll('#toolbox [data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

$('fileInput').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await loadFromBuffer(await f.arrayBuffer(), f.name); status(`Abierto ${f.name}`); }
  catch (err) { alert(err.message); }
  e.target.value = '';
};
$('importInput').onchange = async (e) => { await importFiles(e.target.files); e.target.value = ''; };
// ---------- Formato del proyecto: horizontal, corto vertical o cuadrado ----------
const FORMATS = { h: [1920, 1080, 'Horizontal 16:9'], v: [1080, 1920, 'Corto vertical 9:16'], s: [1080, 1080, 'Cuadrado 1:1'] };
const FMT_KEY = 'mohoWeb.format';
const lastFormat = () => (FORMATS[localStorage.getItem(FMT_KEY)] ? localStorage.getItem(FMT_KEY) : 'h');
const formatOf = (pd) => Object.keys(FORMATS).find((k) => FORMATS[k][0] === pd.width && FORMATS[k][1] === pd.height)
  || (pd.width > pd.height ? 'h' : pd.width < pd.height ? 'v' : 's');

function newProject(fmt, fps = 24) {
  const [w, h] = FORMATS[fmt];
  localStorage.setItem(FMT_KEY, fmt);
  setDoc(newDocument(w, h, 120, fps), 'Sin título.moho');
  status(`Proyecto nuevo · ${FORMATS[fmt][2]}`);
}

function pickFormat() {
  const m = $('fmtModal');
  m.hidden = false;
  m.querySelectorAll('.fmtCards [data-fmt]').forEach((b) => b.classList.toggle('active', b.dataset.fmt === lastFormat()));
  m.querySelector(`.fmtCards [data-fmt="${lastFormat()}"]`)?.focus();
}
$('fmtModal').addEventListener('click', (e) => {
  const b = e.target.closest('.fmtCards [data-fmt]');
  if (b) { $('fmtModal').hidden = true; newProject(b.dataset.fmt, Math.max(1, +$('fmtFps').value || 24)); return; }
  if (e.target.id === 'fmtCancel' || e.target === $('fmtModal')) $('fmtModal').hidden = true;
});

// Cambia el formato del proyecto abierto (el contenido queda centrado; la altura visible no cambia).
function setFormat(fmt) {
  if (!S.doc) { newProject(fmt); return; }
  const pd = S.doc.project_data;
  const [w, h] = FORMATS[fmt];
  if (pd.width === w && pd.height === h) return;
  pushUndo();
  pd.width = w; pd.height = h;
  localStorage.setItem(FMT_KEY, fmt);
  S.viewZoom = 1; S.panX = S.panY = 0;
  refreshAll();
  status(`Formato: ${FORMATS[fmt][2]} · ${w}×${h}`);
}
$('fmtSwitch').addEventListener('click', (e) => { const b = e.target.closest('[data-fmt]'); if (b) setFormat(b.dataset.fmt); });
function updateFormatSwitch() {
  const sw = $('fmtSwitch');
  const exact = S.doc && Object.keys(FORMATS).find((k) => FORMATS[k][0] === S.doc.project_data.width && FORMATS[k][1] === S.doc.project_data.height);
  const cur = S.doc ? formatOf(S.doc.project_data) : lastFormat();
  sw.classList.toggle('custom', !!S.doc && !exact);
  sw.querySelectorAll('[data-fmt]').forEach((b) => b.classList.toggle('active', b.dataset.fmt === cur));
}
updateFormatSwitch();

$('btnNew').onclick = pickFormat;
$('btnSave').onclick = saveMoho;
$('btnPng').onclick = async () => { if (S.doc) download(await renderToBlob(S.doc.project_data.width), S.fileName.replace(/\.moho$/, `_${S.frame}.png`)); };
$('btnSvg').onclick = () => { if (S.doc) download(new Blob([frameToSvg(S.doc, S.frame, media)], { type: 'image/svg+xml' }), S.fileName.replace(/\.moho$/, `_${S.frame}.svg`)); };
$('btnVideo').onclick = exportVideo;
$('btnPlay').onclick = togglePlay;
$('btnPrev').onclick = () => setFrame(S.frame - 1);
$('btnNext').onclick = () => setFrame(S.frame + 1);
$('btnStart').onclick = () => setFrame(0);
$('btnEnd').onclick = () => S.doc && setFrame(S.doc.project_data.end_frame);
$('btnSplit').onclick = splitSelected;
$('frameSlider').oninput = (e) => setFrame(+e.target.value);
$('frameNum').onchange = (e) => setFrame(+e.target.value);
['optBones', 'optPoints', 'optImages', 'optFlexi', 'optOnion'].forEach((id) => ($(id).onchange = () => draw()));

const isel = $('interpSelect');
isel.innerHTML = '<option value="" disabled>Interpolación</option>' +
  Object.entries(INTERP).map(([k, v]) => `<option value="${v}">${k.toLowerCase().replace('_', ' ')}</option>`).join('');
isel.selectedIndex = 0; isel.disabled = true;
isel.onchange = () => {
  pushUndo();
  const kf = S.frame - keyOffset();
  for (const ch of channelsAtFrame(selectedKeyOwner())) {
    const ip = ch.interp[ch.when.indexOf(kf)];
    ip.im = +isel.value; delete ip.b;
    if (ip.im === INTERP.CYCLE && !(ip.v1 > 0)) ip.v1 = Math.max(1, kf - 1);
  }
  draw();
};
$('btnDelKey').onclick = () => {
  const kf = S.frame - keyOffset();
  if (kf === 0) { status('El frame 0 es la pose de reposo; no se borra'); return; }
  pushUndo();
  for (const ch of channelsAtFrame(selectedKeyOwner())) deleteKey(ch, kf);
  updateTimeline(); draw();
};

$('btnAddGroup').onclick = () => S.doc && insertLayer(makeGroupLayer());
$('btnAddBoneLayer').onclick = () => S.doc && insertLayer(makeBoneLayer());
$('btnDupLayer').onclick = () => {
  if (!S.selLayer) return;
  const c = duplicateLayer(S.selLayer);
  pushUndo(); const p = findParent(S.selLayer); p.list.splice(p.list.indexOf(S.selLayer) + 1, 0, c); selectLayer(c);
};
$('btnUpLayer').onclick = () => moveLayer(1);
$('btnDownLayer').onclick = () => moveLayer(-1);
$('btnDelLayer').onclick = deleteLayer;
function deleteLayer() {
  if (!S.selLayer) return;
  pushUndo();
  const p = findParent(S.selLayer); p.list.splice(p.list.indexOf(S.selLayer), 1);
  S.selLayer = null; S.selBone = null; refreshAll();
}

window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if ((tag === 'INPUT' && !['range', 'checkbox', 'color'].includes(e.target.type)) || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'n') { e.preventDefault(); $('btnNew').click(); }
  else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? restore(S.redo, S.undo) : restore(S.undo, S.redo); }
  else if (mod && k === 'y') { e.preventDefault(); restore(S.redo, S.undo); }
  else if (mod && k === 's') { e.preventDefault(); saveMoho(); }
  else if (mod && k === 'd') { e.preventDefault(); $('btnDupLayer').click(); }
  else if (mod && k === 'b') { e.preventDefault(); splitSelected(); }
  else if (mod && k === 'c' && S.selLayer) { S.clipboard = JSON.stringify(S.selLayer); status('Capa copiada'); }
  else if (mod && k === 'v' && S.clipboard && S.doc) { insertLayer(duplicateLayer(JSON.parse(S.clipboard))); }
  else if (mod && k === 'a' && S.selLayer?.mesh) { e.preventDefault(); S.selLayer.mesh.points.forEach((_, i) => S.selPoints.add(i)); updateProps(); draw(); }
  else if (e.key === 'Escape' && !$('fmtModal').hidden) { $('fmtModal').hidden = true; }
  else if (e.key === 'Escape') { if (S.exporting) S.exporting = false; S.pen = null; S.pencil = null; S.selPoints.clear(); draw(); updateProps(); }
  else if (e.key === 'Enter') { if (S.pen) finishPen(false); else togglePlay(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { if (S.selPoints.size) deleteSelectedPoints(); }
  else if (e.key === 'ArrowLeft') setFrame(S.frame - 1);
  else if (e.key === 'ArrowRight') setFrame(S.frame + 1);
  else if (e.key === ' ') { S.spaceDown = true; e.preventDefault(); }
  else if (!mod) {
    const t = { t: 'points', m: 'layer', p: 'pen', n: 'pencil', z: 'bone', a: 'addbone', r: 'rect', e: 'ellipse', h: 'pan' }[k];
    if (t) setTool(t);
    else if (k === 'g') ai.toggle();
    else if (k === 'i') research.toggle();
    else if (k === 'u') $('btnUtm').click();
    else if (k === '0') { S.viewZoom = 1; S.panX = S.panY = 0; draw(); }
  }
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') S.spaceDown = false; });

// Arrastrar y soltar: .moho, imágenes, video, audio, SVG
const stage = $('stage');
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', async (e) => {
  e.preventDefault(); stage.classList.remove('dragover');
  if (e.dataTransfer.files.length) await importFiles(e.dataTransfer.files);
});

// Ejemplos de Moho (si la app se sirve desde la carpeta de Moho).
fetch('samples.json').then((r) => r.ok ? r.json() : []).then((list) => {
  const sel = $('sampleSelect');
  for (const s of list) sel.append(el('option', { value: s.path, textContent: s.name }));
  if (!list.length) sel.style.display = 'none';
}).catch(() => ($('sampleSelect').style.display = 'none'));
$('sampleSelect').onchange = async (e) => {
  const path = e.target.value; if (!path) return;
  status('Cargando ejemplo…');
  try {
    const r = await fetch(path); if (!r.ok) throw new Error(`No se pudo leer ${path}`);
    await loadFromBuffer(await r.arrayBuffer(), decodeURIComponent(path.split('/').pop()), new URL(path, location.href).href);
    status(`Ejemplo: ${e.target.selectedOptions[0].textContent}`);
  } catch (err) { alert(err.message); }
  e.target.value = '';
};

// ======================= Panel de IA =======================
function describeLayers() {
  if (!S.doc || !S.info) return [];
  const pd = S.doc.project_data, view = viewRect();
  const toDoc = ([sx, sy]) => [(sx - view.ox) / view.w * pd.width, (sy - view.oy) / view.h * pd.height];
  const out = [];
  const walk = (layers, parent) => {
    for (const l of layers) {
      const li = S.info.layers.get(l.uuid);
      let bbox = null;
      if (li?.P?.length) {
        const pts = li.P.map(toDoc);
        bbox = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
      }
      if (l.type !== 'AudioLayer') out.push({ name: l.name, type: l.type, bbox, parent: parent?.name });
      if (l.layers) walk(l.layers, l);
    }
  };
  walk(S.doc.layers, null);
  // completar cajas de grupos con las de sus hijos
  for (const d of out) if (!d.bbox) {
    const kids = out.filter((k) => k.parent === d.name && k.bbox);
    if (kids.length) d.bbox = [Math.min(...kids.map((k) => k.bbox[0])), Math.min(...kids.map((k) => k.bbox[1])), Math.max(...kids.map((k) => k.bbox[2])), Math.max(...kids.map((k) => k.bbox[3]))];
  }
  return out.slice(0, 200);
}

const ai = initAI({
  getDoc: () => S.doc,
  ensureDoc,
  pushUndo,
  addLayer: (l) => addLayerNoUndo(l),
  refresh: () => { refreshAll(); },
  importFiles: (files) => importFiles(files),
  status,
  snapshot: (w) => (S.doc ? renderOffscreen(w).toDataURL('image/png') : null),
  describeLayers,
  findLayerByName: (name) => (S.doc ? allLayers(S.doc.layers).find((l) => l.name === name) : null),
  selectedVideoFile: async () => {
    const l = S.selLayer;
    if (!l || !isVideoLayer(l)) return null;
    const bytes = S.extraFiles.get(l.image_path);
    if (bytes) return new File([bytes], l.image_path.split('/').pop(), { type: 'video/' + (l.image_path.split('.').pop().toLowerCase() === 'mov' ? 'quicktime' : l.image_path.split('.').pop().toLowerCase()) });
    const e = media.get(l.image_path);
    if (e?.url) { const b = await (await fetch(e.url)).blob(); return new File([b], l.image_path.split('/').pop(), { type: b.type }); }
    return null;
  },
  fitFormatTo: (w, h) => setFormat(w > h * 1.05 ? 'h' : h > w * 1.05 ? 'v' : 's'),
  importAudio: (file, startFrame) => importAudioOnly(file, startFrame),
  docPxToLayerLocal: (layer, x, y) => {
    const pd = S.doc.project_data, cam = S.info.cam;
    const wx = cam.x + (x - pd.width / 2) / (pd.height / 2) * cam.halfH;
    const wy = cam.y - (y - pd.height / 2) / (pd.height / 2) * cam.halfH;
    const li = S.info.layers.get(layer.uuid);
    return li ? apply(inv(li.M), wx, wy) : [wx, wy];
  },
});
$('btnAI').onclick = () => { research.close(); utm.close(); ai.toggle(); };

const research = initResearch({
  openAI: ({ tab, prompt }) => { research.close(); ensureDoc(); ai.openWith({ tab, prompt }); },
});
$('btnResearch').onclick = () => { ai.close(); utm.close(); research.toggle(); };
const utm = initUtm({});
$('btnUtm').onclick = () => { ai.close(); research.close(); utm.toggle({ title: S.doc ? S.fileName.replace(/\.moho$/, '') : '' }); };

// Sesión: la app solo se muestra con un usuario válido.
requireUser().then((user) => {
  if (!user) return;
  document.body.classList.remove('auth-pending');
  if (user.offline) { status(user.offline); alert(`El servidor no puede conectar con MariaDB: ${user.offline}`); return; }
  initAccount(user);
});

// Pantalla de bienvenida
$('dropHint').addEventListener('click', (e) => {
  const c = e.target.closest('[data-act]'); if (!c) return;
  if (c.dataset.act === 'new') $('btnNew').click();
  else if (c.dataset.act === 'ai') { ensureDoc(); ai.open(); }
  else if (c.dataset.act === 'research') research.open();
  else if (c.dataset.act === 'utm') $('btnUtm').click();
  else if (c.dataset.act === 'open') $('fileInput').click();
});
document.querySelector('.welcome .samples').style.display = 'none';
fetch('samples.json').then((r) => (r.ok ? r.json() : [])).then((list) => {
  if (list.length) document.querySelector('.welcome .samples').style.display = '';
  const seen = new Set();
  for (const s of list) {
    if (seen.has(s.name.toLowerCase()) || seen.size >= 8) continue;
    seen.add(s.name.toLowerCase());
    const b = el('button', { textContent: s.name.replace(/_/g, ' ') });
    b.onclick = async () => {
      try { const r = await fetch(s.path); await loadFromBuffer(await r.arrayBuffer(), decodeURIComponent(s.path.split('/').pop()), new URL(s.path, location.href).href); }
      catch (err) { alert(err.message); }
    };
    $('welcomeSamples').append(b);
  }
}).catch(() => {});

// Zoom y deshacer
const zoomBy = (f) => { if (!S.doc) return; S.viewZoom = Math.max(0.1, Math.min(20, S.viewZoom * f)); draw(); };
$('btnZoomIn').onclick = () => zoomBy(1.25);
$('btnZoomOut').onclick = () => zoomBy(0.8);
$('btnZoomFit').onclick = () => { S.viewZoom = 1; S.panX = S.panY = 0; draw(); };
$('btnUndo').onclick = () => restore(S.undo, S.redo);
// Pantallas estrechas: capas y propiedades como paneles flotantes
$('btnTogLayers').onclick = () => { document.body.classList.toggle('show-layers'); document.body.classList.remove('show-props'); };
$('btnTogProps').onclick = () => { document.body.classList.toggle('show-props'); document.body.classList.remove('show-layers'); };
$('btnRedo').onclick = () => restore(S.redo, S.undo);
hydrateIcons();

new ResizeObserver(() => { draw(); updateTimeline(); }).observe(stage);
setTool('points');
window.mohoApp = S; // acceso para depuración desde la consola
window.mohoMedia = media;
draw();
