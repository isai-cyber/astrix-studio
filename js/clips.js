// Edición tipo video: cada capa es un "clip".
// - Rango visible = canal nativo de Moho layer_effects.visibility (en tiempo de la capa).
// - Mover el clip = timing_offset (desfase nativo de Moho), que desplaza contenido y visibilidad juntos.
import { evalChannel, makeChannel, setKey } from './anim.js';
import { makeEffects, uuid } from './doc.js';

export function ensureEffects(layer) {
  if (!layer.layer_effects) layer.layer_effects = makeEffects();
  const fx = layer.layer_effects;
  const def = makeEffects();
  for (const k of ['visibility', 'alpha', 'blur']) if (!fx[k]) fx[k] = def[k];
  return fx;
}

// Rango [in, out] en frames del documento, o null si nunca es visible.
export function clipRange(layer, start, end) {
  const off = layer.timing_offset || 0;
  const ch = layer.layer_effects?.visibility;
  if (!ch || (ch.when.length <= 1 && ch.val[0] !== false)) return [start, end];
  let a = null, b = null;
  for (let f = start; f <= end; f++) {
    if (evalChannel(ch, f - off) !== false) { if (a === null) a = f; b = f; }
  }
  return a === null ? null : [a, b];
}

// Fija el rango visible (frames del documento).
export function setClipRange(layer, a, b, start, end) {
  const fx = ensureEffects(layer);
  const off = layer.timing_offset || 0;
  const ch = fx.visibility;
  const la = a - off, lb = b - off;
  const fromStart = la <= 0 || a <= start;
  ch.when = [0]; ch.val = [fromStart];
  ch.interp = [{ im: 3, v1: 0.1, v2: 0.5, in: 1, h: 0, s: false, t: 0 }];
  if (!fromStart) setKey(ch, la, true);
  if (b < end && lb + 1 > 0) setKey(ch, lb + 1, false);
}

export function moveClip(layer, delta) {
  layer.timing_offset = (layer.timing_offset || 0) + delta;
}

const cloneWithNewIds = (l) => {
  const c = JSON.parse(JSON.stringify(l));
  const walk = (x) => { x.uuid = uuid(); (x.layers || []).forEach(walk); };
  walk(c);
  return c;
};

// Corta el clip en el frame dado: devuelve la segunda mitad (nueva capa).
export function splitClip(layer, frame, start, end) {
  const r = clipRange(layer, start, end);
  if (!r || frame <= r[0] || frame > r[1]) return null;
  const copy = cloneWithNewIds(layer);
  copy.name = layer.name.replace(/( \(\d+\))?$/, '') + ' (2)';
  setClipRange(layer, r[0], frame - 1, start, end);
  setClipRange(copy, frame, r[1], start, end);
  return copy;
}

export function duplicateLayer(layer) {
  const c = cloneWithNewIds(layer);
  c.name = layer.name + ' copia';
  return c;
}

// Fundidos con keys de opacidad (canal nativo layer_effects.alpha).
export function fade(layer, kind, frames, start, end) {
  const fx = ensureEffects(layer);
  const r = clipRange(layer, start, end) || [start, end];
  const off = layer.timing_offset || 0;
  const ch = fx.alpha;
  if (kind === 'in') {
    setKey(ch, Math.max(0, r[0] - off), 0);
    setKey(ch, r[0] - off + frames, 1);
  } else {
    setKey(ch, r[1] - off - frames, 1);
    setKey(ch, r[1] - off, 0);
  }
}

export function setAdjust(layer, key, frame, value) {
  if (!layer.web_adjust) layer.web_adjust = {};
  const def = { brightness: 1, contrast: 1, saturate: 1, hue: 0, grayscale: 0, sepia: 0, invert: 0 }[key];
  if (!layer.web_adjust[key]) layer.web_adjust[key] = makeChannel('Val', def);
  setKey(layer.web_adjust[key], frame, value);
}

// Recorre el documento.
export function allLayers(layers, out = []) {
  for (const l of layers || []) { out.push(l); if (l.layers) allLayers(l.layers, out); }
  return out;
}
