// Panel de investigación de contenido (Apify) + análisis con Claude -> ideas que se envían al panel de IA.
import { icon, hydrateIcons } from './icons.js';

const H = { 'content-type': 'application/json', 'x-moho-web': '1' };
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: H, body: JSON.stringify(body) } : { headers: { 'x-moho-web': '1' } });
  let j; try { j = await r.json(); } catch { j = { error: `Respuesta no válida (${r.status})` }; }
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

const PLAT = {
  tiktok: { name: 'TikTok', short: 'TT', hint: { search: 'tema, ej. "animación 2D"', hashtag: 'hashtag sin #', profile: '@usuario' } },
  instagram: { name: 'Reels', short: 'IG', hint: { search: 'palabra clave', hashtag: 'hashtag sin #', profile: 'usuario de Instagram' } },
  facebook_reels: { name: 'FB Reels', short: 'FB', hint: { profile: 'URL o nombre de la página' } },
  facebook_posts: { name: 'FB Posts', short: 'FB', hint: { profile: 'URL o nombre de la página' } },
  youtube: { name: 'YouTube', short: 'YT', hint: { search: 'búsqueda en YouTube', profile: '@canal o URL' } },
};
const MODES = { search: 'Buscar', hashtag: 'Hashtag', profile: 'Perfil / página' };

const fmt = (n) => (n == null || isNaN(n) ? '–' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));
const pct = (x) => (x == null || isNaN(x) ? '–' : (x * 100).toFixed(1) + '%');
const median = (a) => { const s = a.filter((x) => x != null && !isNaN(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : undefined; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const thumbUrl = (u) => (u ? `/api/apify/image?url=${encodeURIComponent(u)}` : '');

export function initResearch(app) {
  const el = document.createElement('div');
  el.id = 'researchPanel';
  el.className = 'drawer wide';
  el.innerHTML = `
  <div class="aiHead"><b>Investigación de contenido</b><span class="stat-line" id="rsStatus"></span><button id="rsClose" title="Cerrar">${icon('x', 16)}</button></div>
  <div class="aiBody">
    <div class="rsForm">
      <div class="platforms" id="rsPlatforms">${Object.entries(PLAT).map(([k, p]) => `<button data-p="${k}"><b>${p.short}</b>${p.name}</button>`).join('')}</div>
      <div class="chips" id="rsModes"></div>
      <div class="rsRow">
        <input type="text" id="rsQuery" placeholder="Busca un tema, hashtag o perfil…">
        <button id="rsGo" class="primary pill">${icon('zoomIn', 16)} Investigar</button>
      </div>
      <div class="rsRow">
        <label>Cantidad</label><input type="number" id="rsLimit" value="20" min="5" max="200" style="width:64px">
        <label>Periodo</label><select id="rsDays"><option value="0">Todo</option><option value="1">24 h</option><option value="7">7 días</option><option value="30" selected>30 días</option><option value="90">90 días</option></select>
        <label>Orden</label><select id="rsSort"><option value="relevance">Relevancia</option><option value="likes">Más likes</option><option value="views">Más vistas</option><option value="recent">Recientes</option></select>
        <label id="rsShortsWrap"><input type="checkbox" id="rsShorts" checked> Solo Shorts</label>
        <span class="grow"></span>
        <label title="Tope de gasto por búsqueda en Apify">Máx. $</label><input type="number" id="rsBudget" value="0.5" min="0.05" max="20" step="0.05" style="width:64px">
      </div>
    </div>
    <div id="rsProgress" class="muted small"></div>
    <div id="rsOut"></div>
  </div>`;
  document.body.appendChild(el);
  const $ = (id) => el.querySelector('#' + id);

  let platform = 'tiktok', mode = 'search', platInfo = null, posts = [], sel = new Set(), status = null, sortBy = 'views';

  function renderModes() {
    const modes = platInfo?.[platform]?.modes || Object.keys(PLAT[platform].hint);
    if (!modes.includes(mode)) mode = modes[0];
    $('rsModes').innerHTML = modes.map((m) => `<button data-m="${m}" class="${m === mode ? 'active' : ''}">${MODES[m]}</button>`).join('');
    $('rsQuery').placeholder = `${PLAT[platform].name}: ${PLAT[platform].hint[mode] || ''}`;
    $('rsShortsWrap').style.display = platform === 'youtube' ? '' : 'none';
    el.querySelectorAll('#rsPlatforms button').forEach((b) => b.classList.toggle('active', b.dataset.p === platform));
  }
  $('rsPlatforms').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { platform = b.dataset.p; renderModes(); } };
  $('rsModes').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) { mode = b.dataset.m; renderModes(); } };

  async function refreshStatus() {
    try {
      status = await api('/api/status');
      platInfo = platInfo || await api('/api/apify/platforms');
      $('rsStatus').textContent = `Apify ${status.apify?.available ? '✓' : '✗'} · Claude ${status.claudeCode.available || status.claudeApi.available ? '✓' : '✗'}`;
      $('rsStatus').title = status.apify?.available ? '' : status.apify?.reason || '';
    } catch {
      $('rsStatus').textContent = 'backend apagado';
      $('rsStatus').title = 'Inicia el servidor: node server/server.mjs';
    }
    renderModes();
  }

  const progress = (t) => ($('rsProgress').textContent = t);

  async function run() {
    const query = $('rsQuery').value.trim();
    if (!query) { progress('Escribe qué quieres investigar.'); return; }
    if (status && !status.apify?.available) { showError(status.apify.reason); return; }
    $('rsGo').disabled = true;
    const t0 = Date.now();
    try {
      const start = await api('/api/apify/run', {
        platform, mode, query, limit: +$('rsLimit').value, days: +$('rsDays').value,
        sort: $('rsSort').value, shorts: $('rsShorts').checked, budgetUsd: +$('rsBudget').value,
      });
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        const st = await api(`/api/apify/run?id=${encodeURIComponent(start.runId)}`);
        const secs = Math.round((Date.now() - t0) / 1000);
        progress(`${start.actor} · ${st.status} · ${secs} s${st.costUsd != null ? ` · $${(+st.costUsd).toFixed(3)}` : ''}`);
        if (st.items) {
          posts = st.items; sel.clear();
          save();
          render();
          progress(`${posts.length} publicaciones · ${secs} s${st.costUsd != null ? ` · costo Apify $${(+st.costUsd).toFixed(3)}` : ''}${st.errors?.length ? ' · avisos: ' + st.errors.join('; ') : ''}`);
          break;
        }
        if (st.error) throw new Error(st.error);
        if (['ABORTED', 'TIMED-OUT'].includes(st.status)) throw new Error(`La ejecución terminó como ${st.status} (¿se alcanzó el tope de gasto?)`);
        if (secs > 600) throw new Error('Apify tardó demasiado');
      }
    } catch (e) { progress(''); showError(e.message); }
    finally { $('rsGo').disabled = false; }
  }
  $('rsGo').onclick = run;
  $('rsQuery').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') run(); };

  function showError(msg) {
    const d = document.createElement('div'); d.className = 'rsError'; d.textContent = '⚠ ' + msg;
    $('rsOut').prepend(d);
  }

  function sorted() {
    const k = { views: (p) => p.views ?? -1, er: (p) => p.er ?? -1, likes: (p) => p.likes ?? -1, recent: (p) => Date.parse(p.date) || 0, shares: (p) => p.shares ?? -1 }[sortBy];
    return [...posts].sort((a, b) => k(b) - k(a));
  }

  function render() {
    if (!posts.length) { $('rsOut').innerHTML = '<p class="muted">Sin resultados todavía.</p>'; return; }
    const views = posts.map((p) => p.views);
    const durs = posts.map((p) => p.duration);
    $('rsOut').innerHTML = `
      <div class="rsSummary">
        <div class="kpi"><b>${posts.length}</b><span>publicaciones</span></div>
        <div class="kpi"><b>${fmt(median(views))}</b><span>vistas (mediana)</span></div>
        <div class="kpi"><b>${pct(median(posts.map((p) => p.er)))}</b><span>engagement (mediana)</span></div>
        <div class="kpi"><b>${median(durs) != null ? Math.round(median(durs)) + ' s' : '–'}</b><span>duración (mediana)</span></div>
      </div>
      <div class="rsRow" style="margin:10px 0">
        <label>Ordenar</label>
        <div class="chips" id="rsSortChips">${[['views', 'Vistas'], ['er', 'Engagement'], ['likes', 'Likes'], ['shares', 'Compartidos'], ['recent', 'Recientes']].map(([k, n]) => `<button data-s="${k}" class="${k === sortBy ? 'active' : ''}">${n}</button>`).join('')}</div>
        <span class="grow"></span>
        <span class="muted small" id="rsSelInfo"></span>
        <button id="rsCsv" class="small">${icon('download', 14)} CSV</button>
        <button id="rsAnalyze" class="primary small">${icon('sparkles', 14)} Analizar con Claude</button>
      </div>
      <div id="rsInsights"></div>
      <div class="rsGrid">${sorted().map((p, i) => `
        <div class="post ${sel.has(p.id) ? 'sel' : ''}" data-id="${esc(p.id)}">
          <div class="thumb" style="background-image:url('${thumbUrl(p.thumb)}')">
            <span class="plat">${PLAT[p.platform]?.short || ''}</span>
            ${p.er != null ? `<span class="er">${pct(p.er)}</span>` : ''}
            <span class="views">▶ ${fmt(p.views)}</span>
            <span class="rank">#${i + 1}</span>
          </div>
          <div class="meta">
            <div class="who">${esc(p.author || '')}${p.followers ? ` · ${fmt(p.followers)} seg.` : ''}</div>
            <div class="txt">${esc((p.text || '').slice(0, 140))}</div>
            <div class="nums"><span>♥ ${fmt(p.likes)}</span><span>💬 ${fmt(p.comments)}</span><span>↗ ${fmt(p.shares)}</span>${p.duration ? `<span>${Math.round(p.duration)} s</span>` : ''}</div>
            ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Ver original ↗</a>` : ''}
          </div>
        </div>`).join('')}</div>`;
    updateSelInfo();
    $('rsSortChips').onclick = (e) => { const b = e.target.closest('[data-s]'); if (b) { sortBy = b.dataset.s; render(); } };
    $('rsCsv').onclick = exportCsv;
    $('rsAnalyze').onclick = analyze;
    el.querySelectorAll('.post').forEach((d) => (d.onclick = (e) => {
      if (e.target.closest('a')) return;
      const id = d.dataset.id; sel.has(id) ? sel.delete(id) : sel.add(id);
      d.classList.toggle('sel'); updateSelInfo();
    }));
    if (lastInsights) renderInsights(lastInsights);
  }
  function updateSelInfo() { const n = $('rsSelInfo'); if (n) n.textContent = sel.size ? `${sel.size} seleccionadas para analizar` : 'Analiza el top 15 o selecciona publicaciones'; }

  function exportCsv() {
    const cols = ['platform', 'author', 'followers', 'views', 'likes', 'comments', 'shares', 'saves', 'er', 'duration', 'date', 'music', 'hashtags', 'url', 'text'];
    const q = (v) => `"${String(Array.isArray(v) ? v.join(' ') : v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...sorted().map((p) => cols.map((c) => q(p[c])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `investigacion_${platform}_${Date.now()}.csv`; a.click();
  }

  // ---------- Análisis con Claude ----------
  let lastInsights = null;
  async function analyze() {
    const pool = sel.size ? posts.filter((p) => sel.has(p.id)) : sorted().slice(0, 15);
    const provider = status?.claudeCode?.available ? 'claude-code' : 'claude-api';
    if (status && !status.claudeCode.available && !status.claudeApi.available) { showError(status.claudeCode.reason); return; }
    const btn = $('rsAnalyze'); btn.disabled = true;
    const t0 = Date.now();
    const timer = setInterval(() => progress(`Claude analizando ${pool.length} publicaciones… ${Math.round((Date.now() - t0) / 1000)} s`), 1000);
    const data = pool.map((p, i) => ({
      n: i + 1, plataforma: PLAT[p.platform]?.name, autor: p.author, seguidores: p.followers, vistas: p.views, likes: p.likes,
      comentarios: p.comments, compartidos: p.shares, guardados: p.saves, engagement: p.er != null ? +(p.er * 100).toFixed(2) : null,
      duracion_s: p.duration, fecha: p.date, musica: p.music, hashtags: p.hashtags, texto: (p.text || '').slice(0, 400),
    }));
    const system = `Eres estratega de contenido para redes sociales y director creativo de un estudio de animación 2D.
Analiza publicaciones reales con sus métricas y detecta qué funciona. Responde ÚNICAMENTE con JSON válido (sin markdown):
{"resumen": "2-3 frases", "patrones": {"ganchos": ["..."], "formatos": ["..."], "duracion": "...", "hashtags": ["..."], "musica_audio": ["..."], "llamadas_a_la_accion": ["..."]},
 "ideas": [{"titulo": "...", "concepto": "1-2 frases", "gancho": "primeros 2 segundos", "prompt_animacion": "descripción para generar una animación 2D vectorial (SVG + keyframes) que siga este patrón", "prompt_video": "prompt cinematográfico en inglés para un modelo texto-a-video"}]}
Da 5 ideas originales (no copies las publicaciones). Basa cada conclusión en las métricas; señala si la muestra es pequeña.`;
    try {
      const out = await api('/api/claude', { provider, system, prompt: `Publicaciones (JSON):\n${JSON.stringify(data)}`, images: [], effort: 'medium' });
      const t = out.text.replace(/```(?:json)?/g, '');
      lastInsights = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
      lastInsights._meta = `${out.provider}${out.costUsd ? ` · $${out.costUsd.toFixed(3)}` : ''} · ${Math.round((Date.now() - t0) / 1000)} s`;
      save();
      renderInsights(lastInsights);
      progress('Análisis listo');
    } catch (e) { progress(''); showError('Análisis: ' + e.message); }
    finally { clearInterval(timer); btn.disabled = false; }
  }

  function renderInsights(ins) {
    const box = $('rsInsights'); if (!box) return;
    const list = (a) => (Array.isArray(a) && a.length ? `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">–</p>');
    const p = ins.patrones || {};
    box.innerHTML = `<div class="insights">
      <h4>Resumen <span class="muted small">${esc(ins._meta || '')}</span></h4><p style="margin:0">${esc(ins.resumen || '')}</p>
      <h4>Ganchos que funcionan</h4>${list(p.ganchos)}
      <h4>Formatos</h4>${list(p.formatos)}
      <h4>Duración</h4><p style="margin:0">${esc(p.duracion || '–')}</p>
      <h4>Hashtags</h4><p style="margin:0">${esc((p.hashtags || []).join('  '))}</p>
      <h4>Audio / música</h4>${list(p.musica_audio)}
      <h4>Ideas para tu próximo contenido</h4>
      ${(ins.ideas || []).map((idea, i) => `<div class="idea"><p><b>${esc(idea.titulo)}</b> — ${esc(idea.concepto)}<br><span class="muted small">Gancho: ${esc(idea.gancho || '')}</span></p>
        <div class="btnrow"><button class="primary" data-anim="${i}">${icon('sparkles', 13)} Animar</button><button data-vid="${i}">${icon('film', 13)} Video</button></div></div>`).join('')}
    </div>`;
    box.querySelectorAll('[data-anim]').forEach((b) => (b.onclick = () => app.openAI({ tab: 'anim', prompt: ins.ideas[+b.dataset.anim].prompt_animacion })));
    box.querySelectorAll('[data-vid]').forEach((b) => (b.onclick = () => app.openAI({ tab: 'video', prompt: ins.ideas[+b.dataset.vid].prompt_video })));
  }

  // ---------- Persistencia ----------
  const KEY = 'mohoWeb.research';
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ posts, platform, lastInsights })); } catch { /* lleno */ } }
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s) { posts = s.posts || []; platform = s.platform || platform; lastInsights = s.lastInsights || null; }
  } catch { /* corrupto */ }

  $('rsClose').onclick = () => el.classList.remove('open');
  renderModes(); render();
  hydrateIcons(el);
  return {
    open() { el.classList.add('open'); refreshStatus(); setTimeout(() => $('rsQuery').focus(), 250); },
    close() { el.classList.remove('open'); },
    toggle() { el.classList.contains('open') ? this.close() : this.open(); },
  };
}
