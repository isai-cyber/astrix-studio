// Utilidades vectoriales tipo Illustrator sobre mallas de Moho.
import { makeChannel, evalChannel, setKey } from './anim.js';
import { uuid } from './doc.js';

export const hexToColor = (hex, a = 1) => {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a };
};
export const colorToHex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

function makePoint(x, y) {
  return {
    type: 'Point', position: makeChannel('Vec2', { x, y }), width: makeChannel('Val', 1),
    parent: -2, selected: false, colored: false, color: makeChannel('Color', { r: 1, g: 1, b: 1, a: 1 }),
    color_strength: makeChannel('Val', 1), curves: [],
  };
}

function makeCurvePoint(i, smooth) {
  return {
    point: i, segments_on: true, smoothness: makeChannel('Val', smooth),
    weight_in: makeChannel('Val', 1), weight_out: makeChannel('Val', 1),
    offset_in: makeChannel('Val', 0), offset_out: makeChannel('Val', 0),
  };
}

export function makeStyle({ fill = '#4f8fdc', fillAlpha = 1, line = '#1b2a3c', lineAlpha = 1, width = 0.005556 } = {}) {
  return {
    type: 'Style', name: '', uuid: uuid(),
    define_fill_color: true, fill_color: makeChannel('Color', hexToColor(fill, fillAlpha)),
    define_line_width: true, line_width: width,
    define_line_col: true, line_color: makeChannel('Color', hexToColor(line, lineAlpha)), line_caps: 1,
  };
}

export function emptyMesh() {
  return {
    type: 'Mesh', curve_interpretation: 1, next_shape_id: 0, anim_shape_order: false,
    shape_order: makeChannel('String', ''), points: [], curves: [], shapes: [], groups: [],
  };
}

// Añade a la malla una o varias subrutas (cada una: {pts:[[x,y]], smooth:[...], closed}).
// Todas las subrutas forman UNA forma (así los huecos de un trazado compuesto funcionan con evenodd).
export function addPathsToMesh(mesh, subpaths, styleOpts = {}, { fill = true, outline = true } = {}) {
  const edges = { curve: [], segment: [], flag: [] };
  for (const sp of subpaths) {
    if (sp.pts.length < 2) continue;
    const base = mesh.points.length;
    const ci = mesh.curves.length;
    sp.pts.forEach(([x, y]) => { const p = makePoint(x, y); p.curves.push({ curve: ci, curve_points: 0 }); mesh.points.push(p); });
    mesh.curves.push({
      type: 'Curve', num_points: sp.pts.length, closed: !!sp.closed,
      profile_layer_uuid: '', profile_curve_id: -1, profile_repeat: 16,
      points: sp.pts.map((_, i) => makeCurvePoint(base + i, sp.smooth?.[i] ?? 0.3)),
    });
    const nseg = sp.closed ? sp.pts.length : sp.pts.length - 1;
    for (let s = 0; s < nseg; s++) { edges.curve.push(ci); edges.segment.push(s); edges.flag.push(0); }
  }
  if (!edges.curve.length) return null;
  const allClosed = subpaths.every((s) => s.closed);
  const id = mesh.next_shape_id++;
  const shape = {
    type: 'Shape', name: `S${id + 1}`, id, selected: false,
    has_fill: fill && allClosed, has_outline: outline, fill_allowed: allClosed,
    edges, style: makeStyle(styleOpts), inherited_style_name: '', inherited_style2_name: '',
  };
  mesh.shapes.push(shape);
  mesh.shape_order.val[0] = mesh.shapes.map((s) => s.id).join('|');
  return shape;
}

// Douglas-Peucker
export function simplify(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Esquina si el giro es fuerte; suave si no.
export function autoSmooth(pts, closed, cornerDeg = 55) {
  const n = pts.length;
  return pts.map((p, i) => {
    if (!closed && (i === 0 || i === n - 1)) return 0;
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const a1 = Math.atan2(p[1] - a[1], p[0] - a[0]), a2 = Math.atan2(b[1] - p[1], b[0] - p[0]);
    let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d;
    return d * 180 / Math.PI > cornerDeg ? 0 : 0.3;
  });
}

// Borra puntos y reconstruye curvas/formas.
export function deletePoints(mesh, sel) {
  const remap = new Map();
  const newPoints = [];
  mesh.points.forEach((p, i) => { if (!sel.has(i)) { remap.set(i, newPoints.length); newPoints.push(p); } });
  const curveMap = new Map();
  const newCurves = [];
  mesh.curves.forEach((c, ci) => {
    const pts = c.points.filter((cp) => remap.has(cp.point)).map((cp) => ({ ...cp, point: remap.get(cp.point) }));
    if (pts.length >= 2) {
      curveMap.set(ci, newCurves.length);
      newCurves.push({ ...c, points: pts, num_points: pts.length, closed: c.closed && pts.length >= 3 });
    }
  });
  const newShapes = [];
  for (const sh of mesh.shapes) {
    const used = [...new Set(sh.edges.curve)];
    if (!used.every((c) => curveMap.has(c))) {
      const still = used.filter((c) => curveMap.has(c));
      if (!still.length) continue;
      used.length = 0; used.push(...still);
    }
    const edges = { curve: [], segment: [], flag: [] };
    for (const oc of used) {
      const nc = curveMap.get(oc), c = newCurves[nc];
      const nseg = c.closed ? c.points.length : c.points.length - 1;
      for (let s = 0; s < nseg; s++) { edges.curve.push(nc); edges.segment.push(s); edges.flag.push(0); }
    }
    const closed = used.every((c) => newCurves[curveMap.get(c)].closed);
    newShapes.push({ ...sh, edges, has_fill: sh.has_fill && closed });
  }
  newPoints.forEach((p) => (p.curves = []));
  newCurves.forEach((c, ci) => c.points.forEach((cp, k) => newPoints[cp.point]?.curves.push({ curve: ci, curve_points: k })));
  mesh.points = newPoints; mesh.curves = newCurves; mesh.shapes = newShapes;
}

// Transformación afín de puntos seleccionados (en espacio local), con keyframe en el frame actual.
export function transformPoints(mesh, sel, frame, fn) {
  for (const i of sel) {
    const ch = mesh.points[i].position;
    const v = evalChannel(ch, frame);
    const [x, y] = fn(v.x, v.y);
    setKey(ch, frame, { x, y });
  }
}

export function setSmoothness(mesh, sel, frame, value) {
  for (const c of mesh.curves) for (const cp of c.points) if (sel.has(cp.point)) setKey(cp.smoothness, frame, value);
}
