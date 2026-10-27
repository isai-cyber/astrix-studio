// Importar SVG (Illustrator, Inkscape, Figma…) como capas vectoriales de Moho, y exportar frames a SVG.
import { addPathsToMesh, emptyMesh, simplify, autoSmooth } from './vector.js';
import { makeGroupLayer, makeShapeLayer } from './doc.js';
import { renderDoc } from './render.js';

const probe = document.createElement('canvas').getContext('2d');
function parseColor(str) {
  if (!str || str === 'none' || str === 'transparent') return null;
  probe.fillStyle = '#000'; probe.fillStyle = str;
  const v = probe.fillStyle;
  if (v.startsWith('#')) return { hex: v, a: 1 };
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(',').map(Number);
  return { hex: '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join(''), a };
}

function paintOf(el, prop, root) {
  const cs = getComputedStyle(el);
  let v = cs[prop];
  const ref = v && v.match(/url\(["']?#([^"')]+)/);
  if (ref) { // degradado: se usa el color del primer stop
    const grad = root.querySelector('#' + CSS.escape(ref[1]));
    const stop = grad?.querySelector('stop');
    v = stop ? (getComputedStyle(stop).stopColor || stop.getAttribute('stop-color')) : '#888';
  }
  return parseColor(v);
}

export function svgToLayers(text, docW, docH, name = 'SVG') {
  return svgImport(text, docW, docH, name).group;
}

// Importa un SVG. Los <g id="…"> se convierten en capas de grupo (con su pivote en el centro),
// así cada parte puede animarse. fit: 'fit' = encajar al 90% del cuadro; 'frame' = el viewBox ocupa el cuadro.
export function svgImport(text, docW, docH, name = 'SVG', fit = 'fit') {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (svg.nodeName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) throw new Error('No es un SVG válido');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;opacity:0;pointer-events:none';
  const node = document.importNode(svg, true);
  if (!node.getAttribute('width') && node.viewBox?.baseVal?.width) {
    node.setAttribute('width', node.viewBox.baseVal.width);
    node.setAttribute('height', node.viewBox.baseVal.height);
  }
  host.appendChild(node); document.body.appendChild(host);
  try {
    const box = node.getBoundingClientRect();
    const vw = box.width || 300, vh = box.height || 150;
    const aspect = docW / docH;
    const s = fit === 'frame' ? Math.min(2 * aspect / vw, 2 / vh) : Math.min((2 * aspect * 0.9) / vw, 1.8 / vh);
    const map = (x, y) => [(x - vw / 2) * s, -(y - vh / 2) * s];
    const group = makeGroupLayer(name.replace(/\.svg$/i, ''));
    const byId = new Map();
    let n = 0;
    const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line']);
    const walk = (container, target) => {
      for (const el of container.children) {
        const tag = el.tagName.toLowerCase();
        if (['defs', 'clippath', 'mask', 'symbol', 'pattern', 'style', 'title', 'desc', 'metadata'].includes(tag)) continue;
        if (tag === 'g' || tag === 'svg' || tag === 'a') {
          if (tag === 'g' && el.id) {
            const gl = makeGroupLayer(el.id);
            walk(el, gl);
            if (!gl.layers.length) continue;
            const r = el.getBoundingClientRect();
            const [ox, oy] = map((r.left + r.right) / 2 - box.left, (r.top + r.bottom) / 2 - box.top);
            gl.origin = { x: ox, y: oy };
            byId.set(el.id, gl);
            target.layers.push(gl);
          } else walk(el, target);
          continue;
        }
        if (!SHAPES.has(tag)) continue;
        const layer = shapeToLayer(el, tag, node, map, s, () => ++n);
        if (layer) { if (el.id) byId.set(el.id, layer); target.layers.push(layer); }
      }
    };
    walk(node, group);
    return { group, byId, map, s, vw, vh };
  } finally { host.remove(); }
}

function shapeToLayer(el, tag, root, map, s, counter) {
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return null;
  const fill = paintOf(el, 'fill', root), stroke = paintOf(el, 'stroke', root);
  if (!fill && !stroke) return null;
  const ctm = el.getCTM();
  const L = el.getTotalLength ? el.getTotalLength() : 0;
  if (!L) return null;
  const det = ctm ? Math.sqrt(Math.abs(ctm.a * ctm.d - ctm.b * ctm.c)) : 1;
  const steps = Math.max(24, Math.min(1500, Math.round(L * det / 1.5)));
  const stepLen = L / steps;
  const subs = []; let cur = [];
  let prev = null;
  for (let i = 0; i <= steps; i++) {
    const p = el.getPointAtLength(i * stepLen);
    const q = ctm ? new DOMPoint(p.x, p.y).matrixTransform(ctm) : p;
    if (prev && Math.hypot(q.x - prev.x, q.y - prev.y) > stepLen * det * 3) { subs.push(cur); cur = []; }
    cur.push([q.x, q.y]); prev = q;
  }
  subs.push(cur);
  const closedTag = ['rect', 'circle', 'ellipse', 'polygon'].includes(tag);
  const subpaths = [];
  for (const raw of subs) {
    if (raw.length < 2) continue;
    const first = raw[0], last = raw[raw.length - 1];
    const closed = closedTag || (tag === 'path' && Math.hypot(first[0] - last[0], first[1] - last[1]) < stepLen * det * 1.5);
    let pts = raw.map(([x, y]) => map(x, y));
    if (closed && pts.length > 2) pts.pop();
    pts = simplify(pts, 0.0025);
    if (pts.length < 2) continue;
    subpaths.push({ pts, closed, smooth: autoSmooth(pts, closed) });
  }
  if (!subpaths.length) return null;
  const mesh = emptyMesh();
  const sw = parseFloat(cs.strokeWidth) || 1;
  const op = parseFloat(cs.opacity) || 1;
  addPathsToMesh(mesh, subpaths, {
    fill: fill?.hex || '#ffffff', fillAlpha: (fill?.a ?? 1) * (parseFloat(cs.fillOpacity) || 1) * op,
    line: stroke?.hex || '#000000', lineAlpha: (stroke?.a ?? 1) * (parseFloat(cs.strokeOpacity) || 1) * op,
    width: Math.max(0.0005, (sw * det * s) / 2),
  }, { fill: !!fill, outline: !!stroke });
  return makeMeshLayerFrom(mesh, el.id || `${tag} ${counter()}`);
}

function makeMeshLayerFrom(mesh, name) {
  const l = makeShapeLayer('rect', 0, 0, 0.1, 0.1, '#000000', '#000000');
  l.name = name; l.mesh = mesh;
  return l;
}

// ---------- Exportar a SVG ----------
// Un "contexto 2D" que traduce las llamadas del motor de render a elementos SVG.
class SvgContext {
  constructor() {
    this.out = []; this.path = ''; this.m = [1, 0, 0, 1, 0, 0]; this.stack = [];
    Object.assign(this, { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1, filter: 'none', globalCompositeOperation: 'source-over', font: '10px sans-serif' });
  }
  t(x, y) { const m = this.m; return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  f(n) { return Math.round(n * 100) / 100; }
  save() { this.stack.push({ m: this.m, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, globalAlpha: this.globalAlpha, filter: this.filter, globalCompositeOperation: this.globalCompositeOperation, lineCap: this.lineCap, lineJoin: this.lineJoin }); }
  restore() { const s = this.stack.pop(); if (s) Object.assign(this, s); }
  setTransform(a, b, c, d, e, f) { this.m = [a, b, c, d, e, f]; }
  beginPath() { this.path = ''; }
  moveTo(x, y) { const [a, b] = this.t(x, y); this.path += `M${this.f(a)} ${this.f(b)}`; }
  lineTo(x, y) { const [a, b] = this.t(x, y); this.path += `L${this.f(a)} ${this.f(b)}`; }
  bezierCurveTo(x1, y1, x2, y2, x, y) {
    const p = [this.t(x1, y1), this.t(x2, y2), this.t(x, y)].flat().map((v) => this.f(v));
    this.path += `C${p.join(' ')}`;
  }
  closePath() { this.path += 'Z'; }
  rect(x, y, w, h) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath(); }
  ellipse() {} clip() {} setLineDash() {} fillText() {} strokeRect() {}
  common() {
    let a = '';
    if (this.globalAlpha < 1) a += ` opacity="${this.f(this.globalAlpha)}"`;
    if (this.filter && this.filter !== 'none') a += ` style="filter:${this.filter}"`;
    if (this.globalCompositeOperation !== 'source-over') a += ` style="mix-blend-mode:${this.globalCompositeOperation === 'lighter' ? 'plus-lighter' : this.globalCompositeOperation}"`;
    return a;
  }
  fill(rule) { this.out.push(`<path d="${this.path}" fill="${this.fillStyle}"${rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${this.common()}/>`); }
  stroke() { this.out.push(`<path d="${this.path}" fill="none" stroke="${this.strokeStyle}" stroke-width="${this.f(this.lineWidth)}" stroke-linecap="${this.lineCap}" stroke-linejoin="${this.lineJoin}"${this.common()}/>`); }
  fillRect(x, y, w, h) { this.beginPath(); this.rect(x, y, w, h); this.fill(); }
  drawImage(el) {
    const w = el.videoWidth || el.naturalWidth, h = el.videoHeight || el.naturalHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(el, 0, 0);
    const m = this.m.map((v) => this.f(v * 1000) / 1000);
    this.out.push(`<image width="${w}" height="${h}" transform="matrix(${m.join(' ')})" href="${c.toDataURL()}"${this.common()}/>`);
  }
}

export function frameToSvg(doc, frame, media) {
  const { width: W, height: H } = doc.project_data;
  const g = new SvgContext();
  renderDoc(g, doc, frame, { ox: 0, oy: 0, w: W, h: H }, { media, flexi: true });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${g.out.join('\n')}\n</svg>\n`;
}
