// Canales animados de Moho: { type, when:[frames], val:[valores], interp:[{im, v1, v2, ...}] }
// Los códigos "im" se dedujeron del orden de registro de las constantes Lua en Moho.exe
// (INTERP_SMOOTH .. INTERP_BOUNCE) y de su uso en los archivos de ejemplo.

export const INTERP = {
  SMOOTH: 0, LINEAR: 1, EASE: 2, STEP: 3, NOISY: 4, CYCLE: 5,
  POSE: 6, EASE_IN: 7, EASE_OUT: 8, BEZIER: 9, ELASTIC: 10, BOUNCE: 11,
};
export const INTERP_NAMES = Object.fromEntries(Object.entries(INTERP).map(([k, v]) => [v, k]));

export const DEFAULT_INTERP = () => ({ im: INTERP.LINEAR, v1: 0.1, v2: 0.5, in: 1, h: 0, s: false, t: 0 });

const isNum = (v) => typeof v === 'number';
const isObj = (v) => v && typeof v === 'object';

function lerp(a, b, t) {
  if (isNum(a)) return a + (b - a) * t;
  if (isObj(a)) {
    const o = {};
    for (const k in a) o[k] = isNum(a[k]) ? a[k] + (b[k] - a[k]) * t : a[k];
    return o;
  }
  return t < 1 ? a : b; // Bool / String: escalonado
}

function catmull(p0, p1, p2, p3, t) {
  if (isNum(p1)) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }
  if (isObj(p1)) {
    const o = {};
    for (const k in p1) o[k] = isNum(p1[k]) ? catmull(p0[k], p1[k], p2[k], p3[k], t) : p1[k];
    return o;
  }
  return t < 1 ? p1 : p2;
}

const easeInOut = (t) => t * t * (3 - 2 * t);
const elastic = (t) => (t === 0 || t === 1) ? t : Math.pow(2, -10 * t) * Math.sin((t - 0.075) * (2 * Math.PI) / 0.3) + 1;
function bounce(t) {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

export function evalChannel(ch, frame, depth = 0) {
  if (!ch || !ch.when || ch.when.length === 0) return undefined;
  const W = ch.when, V = ch.val, I = ch.interp || [];
  const n = W.length;
  if (n === 1 || frame <= W[0]) return V[0];
  let i = n - 1;
  if (frame < W[n - 1]) { i = 0; while (W[i + 1] <= frame) i++; }
  const ip = I[i] || DEFAULT_INTERP();
  // Ciclo: el keyframe vuelve "v1" frames atrás (modo relativo). Periodo = v1 + 1.
  if (ip.im === INTERP.CYCLE && frame > W[i] && depth < 4) {
    const back = ip.v1 > 0 ? ip.v1 + 1 : W[i] - W[0];
    const target = W[i] - back;
    if (back > 0) return evalChannel(ch, target + ((frame - W[i]) % back), depth + 1);
  }
  if (i === n - 1) return V[n - 1];
  const t = (frame - W[i]) / (W[i + 1] - W[i]);
  const a = V[i], b = V[i + 1];
  switch (ip.im) {
    case INTERP.STEP: return a;
    case INTERP.LINEAR: case INTERP.POSE: case INTERP.CYCLE: return lerp(a, b, t);
    case INTERP.NOISY: return lerp(a, b, t);
    case INTERP.EASE: return lerp(a, b, easeInOut(t));
    case INTERP.EASE_IN: return lerp(a, b, t * t);
    case INTERP.EASE_OUT: return lerp(a, b, 1 - (1 - t) * (1 - t));
    case INTERP.ELASTIC: return lerp(a, b, elastic(t));
    case INTERP.BOUNCE: return lerp(a, b, bounce(t));
    case INTERP.SMOOTH: case INTERP.BEZIER: default: {
      if (!isNum(a) && !isObj(a)) return a;
      const p0 = i > 0 ? V[i - 1] : a;
      const p3 = i + 2 < n ? V[i + 2] : b;
      return catmull(p0, a, b, p3, t);
    }
  }
}

// Inserta o reemplaza un keyframe.
export function setKey(ch, frame, value) {
  const i = ch.when.indexOf(frame);
  if (i >= 0) { ch.val[i] = value; return; }
  let j = 0;
  while (j < ch.when.length && ch.when[j] < frame) j++;
  const ref = ch.interp[Math.max(0, j - 1)];
  ch.when.splice(j, 0, frame);
  ch.val.splice(j, 0, value);
  ch.interp.splice(j, 0, ref ? { ...ref, b: undefined } : DEFAULT_INTERP());
}

export function deleteKey(ch, frame) {
  const i = ch.when.indexOf(frame);
  if (i > 0) { ch.when.splice(i, 1); ch.val.splice(i, 1); ch.interp.splice(i, 1); }
}

// Recorre un objeto y devuelve los frames de todos sus canales animados.
export function collectKeys(obj, out = new Set(), depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return out;
  if (Array.isArray(obj.when) && Array.isArray(obj.val)) {
    for (const w of obj.when) if (w > 0) out.add(w);
    return out;
  }
  for (const k in obj) {
    if (k === 'layers') continue;
    collectKeys(obj[k], out, depth + 1);
  }
  return out;
}

export function makeChannel(type, value) {
  return { type, ref: false, mute: false, when: [0], val: [value], interp: [DEFAULT_INTERP()] };
}
