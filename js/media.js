// Gestor de medios: imágenes, video y audio referenciados por las capas
// (ImageLayer.image_path, AudioLayer.audio_path). Fuentes, en orden:
// 1) archivos dentro del .moho, 2) archivos añadidos por el usuario, 3) URL relativa al documento.

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i;
const AUDIO_EXT = /\.(wav|mp3|ogg|m4a|aac|flac)$/i;
export const isVideoPath = (p) => VIDEO_EXT.test(p || '');
export const isAudioPath = (p) => AUDIO_EXT.test(p || '');

const baseName = (p) => (p || '').split(/[\\/]/).pop().toLowerCase();

export class MediaStore {
  constructor(onChange) {
    this.onChange = onChange;
    this.files = new Map();   // nombre base -> Blob
    this.entries = new Map(); // ruta -> { status, el, buffer, peaks, url }
    this.baseUrl = null;
    this.audioCtx = null;
  }

  reset(baseUrl = null) {
    for (const e of this.entries.values()) {
      if (e.el && e.el.pause) e.el.pause();
      if (e.url) URL.revokeObjectURL(e.url);
    }
    this.files.clear(); this.entries.clear(); this.baseUrl = baseUrl;
  }

  addFile(name, blob) {
    this.files.set(baseName(name), blob);
    // reintentar rutas que fallaron antes
    for (const [p, e] of this.entries) if (e.status === 'missing' && baseName(p) === baseName(name)) this.entries.delete(p);
  }

  async blobFor(path) {
    const b = this.files.get(baseName(path));
    if (b) return b;
    if (this.baseUrl) {
      try {
        const url = new URL(path.replace(/\\/g, '/'), this.baseUrl);
        const r = await fetch(url);
        if (r.ok) return await r.blob();
      } catch { /* sin acceso */ }
    }
    return null;
  }

  get(path) {
    if (!path) return null;
    let e = this.entries.get(path);
    if (!e) {
      e = { status: 'loading' };
      this.entries.set(path, e);
      this.load(path, e);
    }
    return e;
  }

  async load(path, e) {
    const blob = await this.blobFor(path);
    if (!blob) { e.status = 'missing'; this.onChange?.('status'); return; }
    e.url = URL.createObjectURL(blob);
    if (isVideoPath(path) || blob.type.startsWith('video/')) {
      const v = document.createElement('video');
      v.src = e.url; v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.onloadeddata = () => { e.status = 'ready'; this.onChange?.('status'); };
      v.onseeked = () => this.onChange?.('frame');
      v.onerror = () => { e.status = 'error'; this.onChange?.('status'); };
      e.el = v; e.kind = 'video';
    } else if (isAudioPath(path) || blob.type.startsWith('audio/')) {
      e.kind = 'audio';
      try {
        const ctx = this.ctx();
        e.buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
        e.peaks = computePeaks(e.buffer, 2000);
        e.status = 'ready';
      } catch { e.status = 'error'; }
      this.onChange?.('status');
    } else {
      const img = new Image();
      img.onload = () => { e.status = 'ready'; this.onChange?.('status'); };
      img.onerror = () => { e.status = 'error'; this.onChange?.('status'); };
      img.src = e.url; e.el = img; e.kind = 'image';
    }
  }

  ctx() {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    return this.audioCtx;
  }
}

function computePeaks(buffer, n) {
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / n));
  const peaks = new Float32Array(Math.ceil(data.length / step));
  for (let i = 0, k = 0; i < data.length; i += step, k++) {
    let m = 0;
    for (let j = i; j < Math.min(i + step, data.length); j++) { const a = Math.abs(data[j]); if (a > m) m = a; }
    peaks[k] = m;
  }
  return peaks;
}

// Tiempo (s) dentro del clip para el frame del documento.
export function clipTime(layer, frame, fps) {
  const f = frame - (layer.timing_offset || 0) - 1;
  return Math.max(0, f / (layer.interpreted_fps > 0 ? layer.interpreted_fps : fps));
}
