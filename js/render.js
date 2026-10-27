// Motor de render: reconstrucción del pipeline de Moho (capas -> huesos -> malla -> curvas -> formas).
import { evalChannel } from './anim.js';

// ---------- Matrices afines 2D [a b c d e f] (como canvas) ----------
export const I = () => [1, 0, 0, 1, 0, 0];
export function mul(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}
export function inv(M) {
  const det = M[0] * M[3] - M[1] * M[2] || 1e-12;
  return [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det,
    (M[2] * M[5] - M[3] * M[4]) / det, (M[1] * M[4] - M[0] * M[5]) / det];
}
export const apply = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
const T = (x, y) => [1, 0, 0, 1, x, y];
const R = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; };
const S = (x, y) => [x, 0, 0, y, 0, 0];
const det = (M) => Math.abs(M[0] * M[3] - M[1] * M[2]);

// ---------- Cámara ----------
// Moho guarda la cámara en z = 3.732051 (= cot 15°) con zoom 2: FOV vertical = 60°/zoom,
// así que el alto visible va de y=-1 a y=+1 en unidades del documento.
export function cameraAt(doc, frame) {
  const av = doc.animated_values || {};
  const tr = evalChannel(av.camera_track, frame) || { x: 0, y: 0, z: 3.732051 };
  const zoom = evalChannel(av.camera_zoom, frame) || 2;
  const roll = evalChannel(av.camera_roll, frame) || 0;
  const halfH = tr.z * Math.tan((Math.PI / 6) / zoom);
  return { x: tr.x, y: tr.y, z: tr.z, zoom, roll, halfH };
}

// ---------- Transformación de capa ----------
export function layerLocal(layer, frame) {
  const t = layer.transforms || {};
  const tr = evalChannel(t.translation, frame) || { x: 0, y: 0, z: 0 };
  const sc = evalChannel(t.scale, frame) || { x: 1, y: 1, z: 1 };
  const rz = evalChannel(t.rotation_z, frame) || 0;
  const fh = evalChannel(t.flip_h, frame) ? -1 : 1;
  const fv = evalChannel(t.flip_v, frame) ? -1 : 1;
  const o = layer.origin || { x: 0, y: 0 };
  const M = mul(mul(mul(mul(T(tr.x, tr.y), T(o.x, o.y)), R(rz)), S(sc.x * fh, sc.y * fv)), T(-o.x, -o.y));
  return { M, z: tr.z || 0 };
}

// ---------- Esqueleto ----------
// Cada hueso vive en el marco local del padre: pos -> rotación (rad) -> escala. El largo va sobre +X.
export function boneMatrices(skel, frame) {
  const bones = skel.bones || [];
  const out = new Array(bones.length);
  const visiting = new Set();
  const calc = (i) => {
    if (out[i]) return out[i];
    const b = bones[i];
    const pos = evalChannel(b.anim_pos, frame) || { x: 0, y: 0 };
    const ang = evalChannel(b.anim_angle, frame) || 0;
    const sc = evalChannel(b.anim_scale, frame) ?? 1;
    let local = mul(mul(T(pos.x, pos.y), R(ang)), S(sc, sc));
    let M = local;
    if (b.parent >= 0 && b.parent < bones.length && !visiting.has(b.parent)) {
      visiting.add(i);
      M = mul(calc(b.parent), local);
      visiting.delete(i);
    }
    out[i] = M;
    return M;
  };
  for (let i = 0; i < bones.length; i++) calc(i);
  return out;
}

function buildSkeleton(layer, frame) {
  const skel = layer.skeleton;
  const rest = boneMatrices(skel, 0);
  const cur = frame === 0 ? rest : boneMatrices(skel, frame);
  const D = cur.map((m, i) => mul(m, inv(rest[i])));
  const segs = rest.map((m, i) => {
    const b = skel.bones[i];
    const [x0, y0] = apply(m, 0, 0);
    const [x1, y1] = apply(m, b.length, 0);
    return { x0, y0, x1, y1, len: b.length, strength: b.strength ?? 1 };
  });
  return { layer, bones: skel.bones, rest, cur, D, segs };
}

function distToSeg(px, py, s) {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
  const l2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((px - s.x0) * dx + (py - s.y0) * dy) / l2));
  const qx = s.x0 + dx * t - px, qy = s.y0 + dy * t - py;
  return Math.sqrt(qx * qx + qy * qy);
}

// Flexi-binding (aproximación): peso ~ fuerza / distancia^4 al segmento del hueso en reposo.
function flexiDeform(sk, subset, x, y) {
  let sx = 0, sy = 0, sw = 0;
  const idx = subset || sk.bones.map((_, i) => i);
  for (const i of idx) {
    const s = sk.segs[i];
    if (!s) continue;
    const d = distToSeg(x, y, s) + 0.02 * Math.max(s.len, 0.01);
    const w = Math.max(s.strength, 0.01) / (d * d * d * d);
    const [nx, ny] = apply(sk.D[i], x, y);
    sx += nx * w; sy += ny * w; sw += w;
  }
  return sw > 0 ? [sx / sw, sy / sw] : [x, y];
}

// ---------- Curvas: puntos -> segmentos Bézier ----------
// Inferencia: el manejador de cada punto sigue la dirección (siguiente - anterior), escalado por
// "smoothness" (0 = esquina/peaked, ~0.3 = suave), weight_in/out y girado por offset_in/out.
function curveSegments(curve, P, frame) {
  const pts = curve.points;
  const n = pts.length;
  const closed = curve.closed;
  const hIn = new Array(n), hOut = new Array(n);
  for (let j = 0; j < n; j++) {
    const cp = pts[j];
    const p = P[cp.point];
    const prev = P[pts[closed ? (j - 1 + n) % n : Math.max(0, j - 1)].point];
    const next = P[pts[closed ? (j + 1) % n : Math.min(n - 1, j + 1)].point];
    const sm = evalChannel(cp.smoothness, frame) ?? 0.3;
    const wi = evalChannel(cp.weight_in, frame) ?? 1, wo = evalChannel(cp.weight_out, frame) ?? 1;
    const oi = evalChannel(cp.offset_in, frame) ?? 0, oo = evalChannel(cp.offset_out, frame) ?? 0;
    const tx = next[0] - prev[0], ty = next[1] - prev[1];
    const dIn = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    const dOut = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const sum = dIn + dOut || 1;
    const ko = sm * wo * (dOut / sum), ki = sm * wi * (dIn / sum);
    // y de pantalla está invertida -> el signo del offset se invierte
    const ro = rot(tx, ty, -oo), ri = rot(tx, ty, -oi);
    hOut[j] = [p[0] + ro[0] * ko, p[1] + ro[1] * ko];
    hIn[j] = [p[0] - ri[0] * ki, p[1] - ri[1] * ki];
  }
  const segs = [];
  const count = closed ? n : n - 1;
  for (let s = 0; s < count; s++) {
    const a = s, b = (s + 1) % n;
    segs.push({
      ia: pts[a].point, ib: pts[b].point,
      p0: P[pts[a].point], c0: hOut[a], c1: hIn[b], p1: P[pts[b].point],
      on: pts[a].segments_on !== false,
    });
  }
  return segs;
}
const rot = (x, y, a) => { const c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; };

function colorCss(c, alphaMul = 1) {
  if (!c) return 'transparent';
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${(c.a ?? 1) * alphaMul})`;
}

function resolveStyle(shape, doc, frame) {
  const st = shape.style || {};
  const lib = doc.styles || [];
  // Moho ≤ 13 referencia estilos por nombre; Moho 13.5+ por uuid.
  const inherit = [
    [shape.inherited_style_uuid, shape.inherited_style_name],
    [shape.inherited_style2_uuid, shape.inherited_style2_name],
  ].map(([id, nm]) => (id && lib.find((s) => s.uuid === id)) || (nm && lib.find((s) => s.name === nm)))
    .filter(Boolean);
  const pick = (def, key) => {
    if (st[def]) return st[key];
    for (const s of inherit) if (s[def]) return s[key];
    return st[key];
  };
  return {
    fill: evalChannel(pick('define_fill_color', 'fill_color'), frame),
    line: evalChannel(pick('define_line_col', 'line_color'), frame),
    width: pick('define_line_width', 'line_width') ?? 0.005556,
    caps: st.line_caps,
  };
}

// ---------- Recorrido de capas ----------
// ctx = { W: matriz espacio-del-esqueleto -> mundo, R: capa -> espacio-del-esqueleto,
//         sk: esqueleto activo, bound: capa atada a un hueso, z }
export function renderDoc(g, doc, frame, view, opts = {}) {
  const cam = cameraAt(doc, frame);
  const pd = doc.project_data;
  const scale = (view.h / 2) / cam.halfH;
  const toScreen = (x, y, z) => {
    const persp = cam.z / Math.max(0.05, cam.z - z);
    let dx = (x - cam.x) * persp, dy = (y - cam.y) * persp;
    if (cam.roll) [dx, dy] = rot(dx, dy, -cam.roll);
    return [view.ox + view.w / 2 + dx * scale, view.oy + view.h / 2 - dy * scale];
  };
  const info = { layers: new Map(), bones: [], scale, cam, toScreen };
  // Matriz mundo -> pantalla para una profundidad z (para dibujar imágenes/video con setTransform).
  const viewMatrix = (z) => {
    const persp = cam.z / Math.max(0.05, cam.z - z);
    const k = scale * persp;
    return mul(mul(mul([1, 0, 0, 1, view.ox + view.w / 2, view.oy + view.h / 2], [k, 0, 0, -k, 0, 0]), R(-cam.roll || 0)), [1, 0, 0, 1, -cam.x, -cam.y]);
  };
  const pxScale = view.h / (pd.height || 720);

  const visit = (layer, ctx) => {
    if (opts.hidden?.has(layer.uuid)) return;
    if (layer.visible === false && !opts.showHidden) return;
    const lf = frame - (layer.timing_offset || 0); // desfase de tiempo de la capa
    const fx = layer.layer_effects || {};
    if (fx.visibility && evalChannel(fx.visibility, lf) === false) return;
    const alpha = ctx.alpha * (evalChannel(fx.alpha, lf) ?? 1);
    if (alpha <= 0.001) return;
    let filter = ctx.filter;
    const blur = evalChannel(fx.blur, lf) || 0;
    if (blur > 0) filter += ` blur(${(blur * pxScale).toFixed(2)}px)`;
    filter += adjustFilter(layer.web_adjust, lf);
    const blend = BLEND[layer.blend_mode] || ctx.blend;

    const { M: L, z } = layerLocal(layer, lf);
    let R2 = mul(ctx.R, L);
    let bound = ctx.bound;
    if (ctx.sk && layer.parent_bone >= 0 && ctx.sk.D[layer.parent_bone]) {
      R2 = mul(ctx.sk.D[layer.parent_bone], R2);
      bound = true;
    }
    const c = { ...ctx, R: R2, bound, z: ctx.z + z, alpha, filter, blend };
    const type = layer.type;
    info.layers.set(layer.uuid, { layer, M: mul(ctx.W, R2), z: c.z, P: null, parentM: mul(ctx.W, ctx.R) });

    if (type === 'BoneLayer' && layer.skeleton) {
      const sk = buildSkeleton(layer, lf);
      const W = mul(ctx.W, R2);
      for (const ch of layer.layers || []) visit(ch, { ...c, W, R: I(), sk, bound: false });
      info.bones.push({ layer, sk, W, z: c.z });
      return;
    }
    if (type === 'SwitchLayer') {
      const sel = evalChannel(layer.switch_keys, lf);
      const kids = layer.layers || [];
      const k = kids.find((l) => l.name === sel) || kids[kids.length - 1];
      if (k) visit(k, c);
      return;
    }
    // Cada capa dibuja con su propio estado (opacidad, filtros, modo de fusión).
    g.save();
    g.globalAlpha = alpha;
    g.filter = filter.trim() || 'none';
    g.globalCompositeOperation = blend;
    if (layer.mesh) drawMesh(g, doc, layer, c, lf, toScreen, scale, info, opts);
    else if (type === 'ImageLayer') drawImageLayer(g, layer, c, viewMatrix, opts);
    g.restore();
    if (layer.layers) for (const ch of layer.layers) visit(ch, c);
  };

  // Fondo del documento
  const bc = pd.back_color || { r: 234, g: 234, b: 234, a: 255 };
  if (!opts.noBackground) {
    g.fillStyle = `rgb(${bc.r},${bc.g},${bc.b})`;
    g.fillRect(view.ox, view.oy, view.w, view.h);
  }
  // Orden: la lista JSON va de abajo hacia arriba (el primer elemento se dibuja primero).
  for (const l of doc.layers || []) visit(l, { W: I(), R: I(), sk: null, bound: false, z: 0, alpha: opts.alpha ?? 1, filter: '', blend: 'source-over' });
  if (opts.showBones) drawBones(g, info, opts);
  return info;
}

function drawMesh(g, doc, layer, ctx, frame, toScreen, scale, info, opts) {
  const mesh = layer.mesh;
  const sk = ctx.sk;
  const subset = layer.flexi_bone_subset
    ? layer.flexi_bone_subset.split('|').map(Number).filter((n) => !isNaN(n)) : null;
  const P = mesh.points.map((pt) => {
    const v = evalChannel(pt.position, frame) || { x: 0, y: 0 };
    let [x, y] = apply(ctx.R, v.x, v.y);
    if (sk && !ctx.bound) {
      if (pt.parent >= 0 && sk.D[pt.parent]) [x, y] = apply(sk.D[pt.parent], x, y);
      else if (opts.flexi !== false) [x, y] = flexiDeform(sk, subset, x, y);
    }
    [x, y] = apply(ctx.W, x, y);
    return toScreen(x, y, ctx.z);
  });
  const lin = mul(ctx.W, ctx.R);
  const lwScale = 2 * scale * Math.sqrt(det(lin));
  Object.assign(info.layers.get(layer.uuid) || {}, { P });

  const curveSegs = mesh.curves.map((c) => curveSegments(c, P, frame));
  for (const shape of mesh.shapes || []) {
    const st = resolveStyle(shape, doc, frame);
    const e = shape.edges;
    if (!e || !e.curve) continue;
    g.beginPath();
    let last = -1, first = -1;
    for (let k = 0; k < e.curve.length; k++) {
      const seg = curveSegs[e.curve[k]]?.[e.segment[k]];
      if (!seg) continue;
      let fwd = true;
      if (last >= 0) fwd = seg.ia === last ? true : seg.ib === last ? false : !e.flag[k];
      else if (k + 1 < e.curve.length) {
        const nx = curveSegs[e.curve[k + 1]]?.[e.segment[k + 1]];
        if (nx) fwd = !(seg.ia === nx.ia || seg.ia === nx.ib);
      }
      const [s0, c0, c1, s1, ia, ib] = fwd
        ? [seg.p0, seg.c0, seg.c1, seg.p1, seg.ia, seg.ib]
        : [seg.p1, seg.c1, seg.c0, seg.p0, seg.ib, seg.ia];
      if (last !== ia) {
        if (last >= 0 && last === first) g.closePath();
        g.moveTo(s0[0], s0[1]);
        first = ia;
      }
      g.bezierCurveTo(c0[0], c0[1], c1[0], c1[1], s1[0], s1[1]);
      last = ib;
    }
    if (last === first) g.closePath();
    if (shape.has_fill && st.fill) { g.fillStyle = colorCss(st.fill); g.fill('evenodd'); }
    if (shape.has_outline && st.line) {
      g.strokeStyle = colorCss(st.line);
      g.lineWidth = Math.max(0.5, st.width * lwScale);
      g.lineCap = g.lineJoin = st.caps === 0 ? 'butt' : 'round';
      g.stroke();
    }
  }
  if (opts.selected === layer.uuid && opts.showPoints) {
    g.save();
    g.strokeStyle = 'rgba(167,139,250,0.7)'; g.lineWidth = 1;
    for (const segs of curveSegs) {
      g.beginPath();
      for (const s of segs) { g.moveTo(s.p0[0], s.p0[1]); g.bezierCurveTo(s.c0[0], s.c0[1], s.c1[0], s.c1[1], s.p1[0], s.p1[1]); }
      g.stroke();
    }
    P.forEach(([x, y], i) => {
      g.fillStyle = opts.selPoints?.has(i) ? '#ec4899' : '#22d3ee';
      g.fillRect(x - 3, y - 3, 6, 6);
    });
    g.restore();
  }
}

// Modos de fusión de Moho (BM_*; el orden numérico es inferido de las cadenas del ejecutable).
const BLEND = {
  1: 'multiply', 2: 'screen', 3: 'overlay', 4: 'lighter', 5: 'difference', 6: 'hue', 7: 'saturation',
  8: 'color', 9: 'luminosity', 10: 'soft-light', 11: 'color-dodge', 12: 'lighter', 13: 'color-burn',
};
export const BLEND_NAMES = ['Normal', 'Multiplicar', 'Trama', 'Superponer', 'Añadir', 'Diferencia', 'Tono',
  'Saturación', 'Color', 'Luminosidad', 'Luz suave', 'Sobreexponer color', 'Sobreexposición lineal', 'Subexponer color'];

// Ajustes de color (extensión web, se guarda en layer.web_adjust como canales animables).
function adjustFilter(adj, f) {
  if (!adj) return '';
  let s = '';
  const v = (k, d) => evalChannel(adj[k], f) ?? d;
  const b = v('brightness', 1), c = v('contrast', 1), sa = v('saturate', 1), h = v('hue', 0), gr = v('grayscale', 0), se = v('sepia', 0), iv = v('invert', 0);
  if (b !== 1) s += ` brightness(${b})`;
  if (c !== 1) s += ` contrast(${c})`;
  if (sa !== 1) s += ` saturate(${sa})`;
  if (h) s += ` hue-rotate(${h}deg)`;
  if (gr) s += ` grayscale(${gr})`;
  if (se) s += ` sepia(${se})`;
  if (iv) s += ` invert(${iv})`;
  return s;
}

function drawImageLayer(g, layer, ctx, viewMatrix, opts) {
  const w = layer.width || 1, h = layer.height || 1;
  const M = mul(viewMatrix(ctx.z), mul(ctx.W, ctx.R));
  const e = opts.media?.get(layer.image_path);
  const el = e?.status === 'ready' ? e.el : null;
  if (el) {
    const iw = el.videoWidth || el.naturalWidth, ih = el.videoHeight || el.naturalHeight;
    g.setTransform(...mul(M, [w / iw, 0, 0, -h / ih, -w / 2, h / 2]));
    g.drawImage(el, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  if (!opts.showImages) return;
  const c = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => apply(M, x, y));
  g.setLineDash([6, 4]); g.strokeStyle = 'rgba(120,120,120,0.7)'; g.lineWidth = 1;
  g.beginPath(); c.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke();
  g.setLineDash([]);
  g.fillStyle = 'rgba(80,80,80,0.8)'; g.font = '11px sans-serif';
  const st = e?.status === 'loading' ? 'cargando…' : 'falta';
  g.fillText(`🖼 ${layer.image_path || layer.name} (${st})`, c[3][0] + 4, c[3][1] + 14);
}

function drawBones(g, info, opts) {
  g.save();
  for (const b of info.bones) {
    b.screen = b.sk.cur.map((m, i) => {
      const bone = b.sk.bones[i];
      const [x0, y0] = apply(mul(b.W, m), 0, 0);
      const [x1, y1] = apply(mul(b.W, m), bone.length, 0);
      return [info.toScreen(x0, y0, b.z), info.toScreen(x1, y1, b.z)];
    });
    b.screen.forEach(([a, c], i) => {
      const bone = b.sk.bones[i];
      if (bone.hidden) return;
      const sel = opts.selBone && opts.selBone.layer === b.layer.uuid && opts.selBone.index === i;
      const dx = c[0] - a[0], dy = c[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * Math.min(6, len * 0.15), ny = dx / len * Math.min(6, len * 0.15);
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(a[0] + dx * 0.2 + nx, a[1] + dy * 0.2 + ny);
      g.lineTo(c[0], c[1]);
      g.lineTo(a[0] + dx * 0.2 - nx, a[1] + dy * 0.2 - ny);
      g.closePath();
      g.fillStyle = sel ? 'rgba(236,72,153,0.85)' : 'rgba(167,139,250,0.45)';
      g.strokeStyle = sel ? '#fff' : 'rgba(10,10,30,0.8)';
      g.lineWidth = 1;
      g.fill(); g.stroke();
    });
  }
  g.restore();
}
