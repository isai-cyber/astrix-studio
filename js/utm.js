// Medición de videos orgánicos con enlaces UTM rastreables (/r/CODIGO) y tablero de resultados.
import { icon, hydrateIcons } from './icons.js';
import { api } from './account.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (n == null || isNaN(n) ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));
const pct = (x) => (x == null || isNaN(x) ? '–' : (x * 100).toFixed(2) + '%');
const tag = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_').replace(/[^\w\-.]/g, '');
const SOURCES = [['tiktok', 'TikTok'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['youtube', 'YouTube'], ['x', 'X / Twitter'], ['linkedin', 'LinkedIn'], ['pinterest', 'Pinterest'], ['threads', 'Threads'], ['whatsapp', 'WhatsApp'], ['email', 'Email']];
const SRC_COLOR = { tiktok: '#22d3ee', instagram: '#ec4899', facebook: '#3b82f6', youtube: '#ef4444', x: '#a3a3a3', linkedin: '#0ea5e9', pinterest: '#f43f5e', threads: '#c084fc', whatsapp: '#22c55e', email: '#facc15' };

export function initUtm(app) {
  const el = document.createElement('div');
  el.id = 'utmPanel';
  el.className = 'drawer wide';
  el.innerHTML = `
  <div class="aiHead"><b>Medir videos orgánicos (UTM)</b><span class="stat-line"><select id="utDays"><option value="7">7 días</option><option value="30" selected>30 días</option><option value="90">90 días</option><option value="365">1 año</option></select></span><button id="utClose">${icon('x', 16)}</button></div>
  <div class="aiBody">
    <details id="utNewBox" open><summary><b>Nuevo enlace para un video</b></summary>
      <form id="utForm" class="utmForm">
        <label class="full">Título del video<input id="utTitle" type="text" placeholder="Ej. Tutorial huesos — parte 1" required></label>
        <label class="full">URL de destino (tu web, tienda, landing…)<input id="utDest" type="url" placeholder="https://tusitio.com/oferta" required></label>
        <label>Plataforma (utm_source)<select id="utSource">${SOURCES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></label>
        <label>Medio (utm_medium)<input id="utMedium" type="text" value="organic_video"></label>
        <label>Campaña (utm_campaign)<input id="utCampaign" type="text" placeholder="lanzamiento_octubre" required></label>
        <label>Contenido (utm_content)<input id="utContent" type="text" placeholder="se completa con el título"></label>
        <label>Término (utm_term, opcional)<input id="utTerm" type="text"></label>
        <label>Fecha de publicación<input id="utDate" type="date"></label>
        <label class="full">URL de la publicación (opcional)<input id="utPost" type="url" placeholder="https://www.tiktok.com/@cuenta/video/…"></label>
        <label>Vistas del video (para CTR)<input id="utViews" type="number" min="0" placeholder="opcional"></label>
        <div class="full preview"><span class="muted small">Vista previa</span><code id="utPreview">—</code></div>
        <button class="primary full">${icon('plus', 14)} Crear enlace rastreable</button>
      </form>
      <div id="utCreated"></div>
    </details>
    <div class="rsSummary" id="utKpis"></div>
    <div class="utCharts"><div class="chartBox"><span class="muted small">Clics por día</span><canvas id="utChart" height="120"></canvas></div><div class="chartBox" id="utSources"></div></div>
    <div class="rsRow"><b>Enlaces</b><span class="grow"></span><button id="utCsv" class="small">${icon('download', 14)} CSV</button></div>
    <div id="utList"></div>
    <p class="muted small" id="utNote"></p>
  </div>`;
  document.body.appendChild(el);
  const $ = (id) => el.querySelector('#' + id);
  let links = [], stats = null, base = '';

  // Vista previa de la URL con UTM
  function preview() {
    const dest = $('utDest').value.trim();
    if (!/^https?:\/\//.test(dest)) { $('utPreview').textContent = '—'; return; }
    try {
      const u = new URL(dest);
      const p = { utm_source: $('utSource').value, utm_medium: tag($('utMedium').value) || 'organic_video', utm_campaign: tag($('utCampaign').value) || 'sin_campana', utm_content: tag($('utContent').value) || tag($('utTitle').value), utm_term: tag($('utTerm').value) };
      for (const [k, v] of Object.entries(p)) if (v) u.searchParams.set(k, v);
      $('utPreview').textContent = u.toString();
    } catch { $('utPreview').textContent = 'URL no válida'; }
  }
  el.querySelector('#utForm').addEventListener('input', preview);
  el.querySelectorAll('#utForm input, #utForm select').forEach((i) => i.addEventListener('keydown', (e) => e.stopPropagation()));

  $('utForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/utm', { method: 'POST', body: {
        title: $('utTitle').value, destination_url: $('utDest').value, utm_source: $('utSource').value, utm_medium: $('utMedium').value,
        utm_campaign: $('utCampaign').value, utm_content: $('utContent').value || tag($('utTitle').value), utm_term: $('utTerm').value,
        post_url: $('utPost').value, views: $('utViews').value, published_at: $('utDate').value,
      } });
      $('utCreated').innerHTML = `<div class="secret"><div>${icon('sparkles', 14)} <b>Enlace creado</b> — ponlo en la descripción, la bio o el comentario fijado del video.</div>
        <div class="row"><span class="muted">Enlace corto</span><code>${esc(r.short_url)}</code><button class="small" data-copy="${esc(r.short_url)}">Copiar</button></div>
        <div class="row"><span class="muted">URL con UTM</span><code class="wrap">${esc(r.full_url)}</code><button class="small" data-copy="${esc(r.full_url)}">Copiar</button></div></div>`;
      $('utTitle').value = ''; $('utContent').value = ''; $('utPost').value = ''; $('utViews').value = '';
      preview(); load();
    } catch (err) { alert(err.message); }
  };
  el.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { navigator.clipboard.writeText(c.dataset.copy); const t = c.textContent; c.textContent = '✓'; setTimeout(() => (c.textContent = t), 1200); }
  });

  async function load() {
    const days = $('utDays').value;
    try {
      [{ links }, stats, { publicBase: base }] = await Promise.all([api(`/api/utm?days=${days}`), api(`/api/utm/stats?days=${days}`), api('/api/status')]);
    } catch (e) { $('utList').innerHTML = `<div class="rsError">${esc(e.message)}</div>`; return; }
    render();
  }
  $('utDays').onchange = load;

  function render() {
    const clicks = links.reduce((a, l) => a + l.clicks_period, 0);
    const uniq = links.reduce((a, l) => a + l.unique_clicks, 0);
    const withViews = links.filter((l) => l.views);
    const ctr = withViews.length ? withViews.reduce((a, l) => a + l.clicks, 0) / withViews.reduce((a, l) => a + l.views, 0) : null;
    const best = [...links].sort((a, b) => b.clicks_period - a.clicks_period)[0];
    $('utKpis').innerHTML = `
      <div class="kpi"><b>${fmt(clicks)}</b><span>clics (${stats.days} d)</span></div>
      <div class="kpi"><b>${fmt(uniq)}</b><span>visitantes únicos (total)</span></div>
      <div class="kpi"><b>${pct(ctr)}</b><span>CTR (clics / vistas)</span></div>
      <div class="kpi"><b title="${esc(best?.title || '')}">${best && best.clicks_period ? esc(best.title.slice(0, 16)) : '–'}</b><span>mejor video</span></div>`;
    drawChart();
    const max = Math.max(1, ...stats.bySource.map((s) => s.clicks));
    $('utSources').innerHTML = `<span class="muted small">Por plataforma</span>${stats.bySource.map((s) => `
      <div class="bar"><span>${esc(s.source)}</span><i style="width:${(s.clicks / max) * 100}%;background:${SRC_COLOR[s.source] || '#8b5cf6'}"></i><b>${s.clicks}</b></div>`).join('') || '<p class="muted small">Sin datos aún</p>'}
      <span class="muted small" style="margin-top:6px">Dispositivo: ${stats.byDevice.filter((d) => d.device !== 'bot').map((d) => `${d.device} ${d.clicks}`).join(' · ') || '–'}${stats.byDevice.find((d) => d.device === 'bot') ? ` · bots excluidos ${stats.byDevice.find((d) => d.device === 'bot').clicks}` : ''}</span>`;
    $('utList').innerHTML = links.length ? `<table class="tbl"><thead><tr><th>Video</th><th>Fuente</th><th>Clics</th><th>Únicos</th><th>Vistas</th><th>CTR</th><th></th></tr></thead><tbody>
      ${links.map((l) => `<tr data-id="${l.id}">
        <td><b>${esc(l.title)}</b><br><span class="muted small">${esc(l.utm_campaign)}${l.published_at ? ' · ' + new Date(l.published_at).toLocaleDateString() : ''}${l.last_click ? ' · último clic ' + new Date(l.last_click).toLocaleString() : ''}</span>
          <div class="linkRow"><code>${esc(l.short_url)}</code><button class="small" data-copy="${esc(l.short_url)}">Copiar</button><button class="small" data-copy="${esc(l.full_url)}" title="Copiar URL larga con UTM">UTM</button>${l.post_url ? `<a href="${esc(l.post_url)}" target="_blank" rel="noopener noreferrer">ver video ↗</a>` : ''}</div></td>
        <td><span class="srcDot" style="background:${SRC_COLOR[l.utm_source] || '#8b5cf6'}"></span>${esc(l.utm_source)}</td>
        <td><b>${l.clicks}</b><br><span class="muted small">${l.clicks_period} en ${stats.days} d</span></td>
        <td>${l.unique_clicks}</td>
        <td><input type="number" min="0" class="viewsIn" value="${l.views ?? ''}" placeholder="–"></td>
        <td>${pct(l.ctr)}</td>
        <td><button class="small icon" data-archive title="Archivar">${icon('trash', 13)}</button></td>
      </tr>`).join('')}</tbody></table>` : '<p class="muted">Aún no hay enlaces. Crea uno para cada video que publiques.</p>';
    $('utList').querySelectorAll('tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      tr.querySelector('.viewsIn').onchange = async (e) => { try { await api(`/api/utm/${id}`, { method: 'PATCH', body: { views: e.target.value } }); load(); } catch (err) { alert(err.message); } };
      tr.querySelector('.viewsIn').onkeydown = (e) => e.stopPropagation();
      tr.querySelector('[data-archive]').onclick = async () => { if (!confirm('¿Archivar este enlace? Dejará de redirigir.')) return; try { await api(`/api/utm/${id}`, { method: 'PATCH', body: { archived: true } }); load(); } catch (err) { alert(err.message); } };
    });
    $('utNote').innerHTML = /127\.0\.0\.1|localhost/.test(base)
      ? `⚠ Los enlaces cortos apuntan a <code>${esc(base)}</code>: solo funcionan en este equipo. Para usarlos en redes, publica la app y define <code>PUBLIC_BASE_URL</code> en <code>server/.env</code>. Mientras tanto puedes usar la "URL con UTM" (Google Analytics u otra analítica de tu web la medirá).`
      : `Enlaces cortos en ${esc(base)}. Los clics de bots y vistas previas (WhatsApp, Facebook…) se excluyen. No se guardan direcciones IP.`;
  }

  function drawChart() {
    const c = $('utChart'), d = devicePixelRatio;
    const w = c.clientWidth || 400, h = 120;
    c.width = w * d; c.height = h * d;
    const g = c.getContext('2d'); g.scale(d, d); g.clearRect(0, 0, w, h);
    const days = stats.days, map = new Map(stats.byDay.map((r) => [new Date(r.day).toISOString().slice(0, 10), r.clicks]));
    const vals = Array.from({ length: days }, (_, i) => map.get(new Date(Date.now() - (days - 1 - i) * 864e5).toISOString().slice(0, 10)) || 0);
    const max = Math.max(1, ...vals), bw = w / days;
    const grad = g.createLinearGradient(0, 0, w, 0);
    ['#22d3ee', '#3b82f6', '#8b5cf6', '#ec4899', '#fb923c'].forEach((col, i) => grad.addColorStop(i / 4, col));
    g.fillStyle = grad;
    vals.forEach((v, i) => { const bh = (v / max) * (h - 18); g.fillRect(i * bw + bw * 0.15, h - 14 - bh, Math.max(1, bw * 0.7), Math.max(v ? 2 : 0, bh)); });
    g.fillStyle = '#5d6290'; g.font = '10px ui-monospace, monospace';
    g.fillText(`máx ${max}`, 2, 10); g.fillText(`hoy`, w - 22, h - 2); g.fillText(`-${days} d`, 2, h - 2);
  }

  $('utCsv').onclick = () => {
    const cols = ['title', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'clicks', 'unique_clicks', 'clicks_period', 'views', 'ctr', 'short_url', 'full_url', 'post_url', 'published_at', 'created_at'];
    const qv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...links.map((l) => cols.map((k) => qv(l[k])).join(','))].join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `utm_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  };

  $('utClose').onclick = () => el.classList.remove('open');
  hydrateIcons(el);
  return {
    open(prefill = {}) {
      el.classList.add('open');
      if (prefill.title && !$('utTitle').value) $('utTitle').value = prefill.title;
      $('utDate').value ||= new Date().toISOString().slice(0, 10);
      preview(); load();
    },
    close() { el.classList.remove('open'); },
    toggle(prefill) { el.classList.contains('open') ? this.close() : this.open(prefill); },
  };
}
