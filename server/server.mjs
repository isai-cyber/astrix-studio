// Backend de Astrix Studio.
// Política de archivos: lo que el usuario sube (video, imagen, audio, proyectos) nunca se guarda en el servidor.
// Solo pasa en memoria (o en una carpeta temporal que se borra al terminar) hacia el proveedor de IA que lo procesa.
// - Sirve la app (y la carpeta de Moho, para los ejemplos) en http://127.0.0.1:8765
// - /api/claude: genera SVG / animaciones con Claude Code (CLI headless) o con la Claude API (SDK oficial)
// - /api/fal/*: proxy a la cola de fal.ai (Seedance, Flux, Recraft…) sin exponer FAL_KEY al navegador
//
// Claves: variables de entorno o un archivo server/.env (ver .env.example). Nunca se envían al navegador.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { migrate, bootstrapAdmin, sessionUser } from './db.mjs';
import { authRoutes, userRoutes, tenantRoutes, utmRoutes, utmRedirect, elevenRoutes, elevenAvailable, getCookie, can, publicBase } from './routes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(here, '..');               // la app (index.html, js/, assets/…)
// Instalación local de Moho (opcional): solo para servir /Resources/ con los ejemplos .moho
const MOHO_DIR = path.resolve(process.env.MOHO_DIR || path.join(APP_DIR, '..'));
const PORT = Number(process.env.PORT || 8765);
const HOST = '127.0.0.1';
const MAX_BODY = 40 * 1024 * 1024;

// ---------- .env ----------
try {
  for (const line of fs.readFileSync(path.join(here, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* sin .env */ }

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_MODEL = 'claude-opus-5-5';

// ---------- utilidades HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.moho': 'application/zip', '.md': 'text/markdown; charset=utf-8', '.ttf': 'font/ttf',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Petición demasiado grande'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// Las rutas /api solo aceptan peticiones de la propia app (evita que otra web use el backend local).
function apiAllowed(req) {
  if (req.headers['x-moho-web'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true;
  try { return process.env.PUBLIC_BASE_URL && new URL(process.env.PUBLIC_BASE_URL).origin === origin; } catch { return false; }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  // Compatibilidad con la ruta antigua /moho-web/...
  if (rel === '/moho-web' || rel.startsWith('/moho-web/')) { res.writeHead(301, { location: rel.slice('/moho-web'.length) || '/' }); res.end(); return; }
  const base = rel.startsWith('/Resources/') ? MOHO_DIR : APP_DIR;
  let file = path.resolve(base, '.' + rel);
  if (!file.startsWith(base + path.sep) && file !== base) { res.writeHead(403); res.end(); return; }
  // Nunca se sirven el código del servidor, dependencias, secretos ni metadatos de git
  const relApp = path.relative(APP_DIR, file).split(path.sep);
  if (base === APP_DIR && (['server', 'node_modules', '.git', 'scripts'].includes(relApp[0]) || relApp.some((p) => p.startsWith('.')))) { res.writeHead(404); res.end(); return; }
  try {
    let st = await fsp.stat(file);
    if (st.isDirectory()) { file = path.join(file, 'index.html'); st = await fsp.stat(file); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? +range[1] : 0, end = range[2] ? +range[2] : st.size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    }
  } catch { res.writeHead(404); res.end('No encontrado'); }
}

// ---------- Claude Code (CLI headless) ----------
function run(cmd, args, { cwd, timeoutMs = 600000, input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: process.env });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGTERM'); err += '\n[tiempo agotado]'; }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

async function claudeCodeStatus() {
  const r = await run(CLAUDE_BIN, ['auth', 'status'], { timeoutMs: 15000 });
  if (r.code === -1) return { available: false, reason: `No se encontró el CLI "${CLAUDE_BIN}"` };
  try {
    const s = JSON.parse(r.out);
    return s.loggedIn
      ? { available: true, authMethod: s.authMethod }
      : { available: false, reason: 'El CLI de Claude Code no tiene sesión. Ejecuta en una terminal: claude auth login' };
  } catch { return { available: false, reason: (r.err || r.out).trim().slice(0, 200) }; }
}

function dataUrlToFile(dataUrl, dir, name) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[m[1]] || '.png';
  const file = path.join(dir, name + ext);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

async function generateWithClaudeCode({ system, prompt, images = [], model, effort }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'moho-gen-'));
  try {
    const files = images.map((img, i) => dataUrlToFile(img, dir, `referencia_${i + 1}`)).filter(Boolean);
    let text = prompt;
    if (files.length) text += `\n\nImágenes de referencia (léelas con la herramienta Read antes de responder): ${files.map((f) => path.basename(f)).join(', ')}`;
    const args = ['-p', text, '--output-format', 'json', '--system-prompt', system,
      '--strict-mcp-config', '--no-session-persistence'];
    // Sin herramientas salvo Read (y solo si hay imágenes de referencia, dentro de la carpeta temporal).
    if (files.length) args.push('--tools', 'Read', '--allowedTools', 'Read');
    else args.push('--tools', '');
    if (model) args.push('--model', model);
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) args.push('--effort', effort);
    const r = await run(CLAUDE_BIN, args, { cwd: dir });
    let parsed;
    try { parsed = JSON.parse(r.out); } catch { throw new Error((r.err || r.out || 'Claude Code no respondió').slice(0, 500)); }
    if (parsed.is_error) throw new Error(parsed.result || 'Error de Claude Code');
    return { text: parsed.result, costUsd: parsed.total_cost_usd, provider: 'claude-code' };
  } finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

// ---------- Claude API (SDK oficial) ----------
let anthropic = null;
async function getAnthropic() {
  if (!anthropic) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    anthropic = { Anthropic, client: new Anthropic() };
  }
  return anthropic;
}

async function generateWithClaudeApi({ system, prompt, images = [], model, effort }) {
  const { Anthropic, client } = await getAnthropic();
  const content = [];
  for (const img of images) {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/s.exec(img || '');
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  content.push({ type: 'text', text: prompt });
  try {
    const stream = client.beta.messages.stream({
      model: model || DEFAULT_MODEL,
      max_tokens: 64000,
      output_config: { effort: effort || 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') {
      throw new Error(`Claude rechazó la petición${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ''}.`);
    }
    if (msg.stop_reason === 'max_tokens') throw new Error('La respuesta se cortó por longitud; pide algo más sencillo.');
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { text, provider: 'claude-api', model: msg.model, usage: msg.usage };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Claude API: credenciales no válidas o ausentes (ANTHROPIC_API_KEY).');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude API: límite de uso alcanzado, reintenta en un momento.');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude API ${e.status ?? ''}: ${e.message}`);
    throw e;
  }
}

// ---------- fal.ai ----------
const falJobs = new Map(); // request_id -> { status_url, response_url }
const falKey = () => process.env.FAL_KEY || process.env.FAL_API_KEY;

async function falFetch(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { authorization: `Key ${falKey()}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) throw Object.assign(new Error(body?.detail ? JSON.stringify(body.detail).slice(0, 400) : `fal.ai ${r.status}`), { status: r.status, body });
  return body;
}

const MEDIA_HOSTS = [/\.fal\.media$/, /^fal\.media$/, /\.fal\.run$/, /^storage\.googleapis\.com$/, /\.fal\.ai$/];


// ---------- Apify: investigación de contenido ----------
// Actores verificados en la API pública de Apify (esquemas de entrada leídos de su build por defecto).
const apifyToken = () => process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN;
const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const asUrl = (q, base) => (/^https?:\/\//.test(q) ? q : base + q.replace(/^@/, ''));

const PLATFORMS = {
  tiktok: {
    label: 'TikTok', modes: ['search', 'hashtag', 'profile'],
    build: ({ mode, query, limit, days, sort }) => {
      const base = { resultsPerPage: limit, shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadAvatars: false, shouldDownloadMusicCovers: false, shouldDownloadSlideshowImages: false };
      if (mode === 'hashtag') return ['clockworks/tiktok-scraper', { ...base, hashtags: [query.replace(/^#/, '')], ...(days ? { oldestPostDateUnified: daysAgo(days) } : {}) }];
      if (mode === 'profile') return ['clockworks/tiktok-scraper', { ...base, profiles: [query.replace(/^@/, '')], profileSorting: sort === 'recent' ? 'latest' : 'popular' }];
      const df = !days ? 'ALL_TIME' : days <= 1 ? 'PAST_24_HOURS' : days <= 7 ? 'PAST_WEEK' : days <= 31 ? 'PAST_MONTH' : 'LAST_3_MONTHS';
      return ['clockworks/tiktok-scraper', { ...base, searchQueries: [query], searchSection: '/video', videoSearchSorting: sort === 'recent' ? 'LATEST' : sort === 'likes' ? 'MOST_LIKED' : 'MOST_RELEVANT', videoSearchDateFilter: df }];
    },
  },
  instagram: {
    label: 'Instagram Reels', modes: ['search', 'hashtag', 'profile'],
    build: ({ mode, query, limit, days }) => {
      if (mode === 'profile') return ['apify/instagram-reel-scraper', { username: [query.replace(/^@/, '')], resultsLimit: limit, ...(days ? { onlyPostsNewerThan: daysAgo(days) } : {}) }];
      return ['apify/instagram-hashtag-scraper', { hashtags: [query.replace(/^#/, '')], resultsType: 'reels', resultsLimit: limit, keywordSearch: mode === 'search' }];
    },
  },
  facebook_reels: {
    label: 'Facebook Reels', modes: ['profile'],
    build: ({ query, limit, days }) => ['apify/facebook-reels-scraper', { startUrls: [{ url: asUrl(query, 'https://www.facebook.com/') }], resultsLimit: limit, ...(days ? { onlyPostsNewerThan: daysAgo(days) } : {}) }],
  },
  facebook_posts: {
    label: 'Facebook Posts', modes: ['profile'],
    build: ({ query, limit, days }) => ['apify/facebook-posts-scraper', { startUrls: [{ url: asUrl(query, 'https://www.facebook.com/') }], resultsLimit: limit, ...(days ? { onlyPostsNewerThan: daysAgo(days) } : {}) }],
  },
  youtube: {
    label: 'YouTube / Shorts', modes: ['search', 'profile'],
    build: ({ mode, query, limit, days, sort, shorts }) => {
      if (mode === 'profile') return ['streamers/youtube-scraper', { startUrls: [{ url: asUrl(query, 'https://www.youtube.com/@') }], maxResults: shorts ? 0 : limit, maxResultsShorts: shorts ? limit : 0 }];
      const dateFilter = !days ? undefined : days <= 1 ? 'today' : days <= 7 ? 'week' : days <= 31 ? 'month' : 'year';
      return ['streamers/youtube-scraper', { searchQueries: [query], maxResults: shorts ? 0 : limit, maxResultsShorts: shorts ? limit : 0, sortingOrder: sort === 'recent' ? 'date' : sort === 'views' ? 'views' : 'relevance', ...(dateFilter ? { dateFilter } : {}) }];
    },
  },
};

const apifyRuns = new Map(); // runId -> { platform, datasetId, limit }

async function apifyFetch(pathname, init = {}) {
  const r = await fetch(`https://api.apify.com/v2${pathname}`, { ...init, headers: { authorization: `Bearer ${apifyToken()}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw Object.assign(new Error(body?.error?.message || `Apify ${r.status}`), { status: r.status === 401 ? 400 : 502 });
  return body;
}

// Lectura tolerante de campos: cada actor nombra distinto las métricas.
function pick(o, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^[\d.,]+[kmb]?$/i.test(v.trim())
  ? parseFloat(v.replace(/,/g, '')) * ({ k: 1e3, m: 1e6, b: 1e9 }[v.trim().slice(-1).toLowerCase()] || 1) : undefined);
function durSecs(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d+(:\d+){1,2}$/.test(v)) return v.split(':').reduce((a, x) => a * 60 + +x, 0);
  return undefined;
}

function normalize(platform, it) {
  const hashtagsRaw = pick(it, ['hashtags']) || [];
  const post = {
    platform,
    id: String(pick(it, ['id', 'shortCode', 'postId', 'videoId']) ?? Math.random()),
    url: pick(it, ['webVideoUrl', 'url', 'postUrl', 'topLevelUrl', 'link']),
    text: pick(it, ['text', 'caption', 'title', 'description', 'message']) || '',
    author: pick(it, ['authorMeta.name', 'ownerUsername', 'channelName', 'pageName', 'user.name', 'author.name', 'ownerFullName']),
    followers: num(pick(it, ['authorMeta.fans', 'numberOfSubscribers', 'ownerFollowers', 'pageFollowers'])),
    thumb: pick(it, ['videoMeta.coverUrl', 'covers.0', 'displayUrl', 'thumbnailUrl', 'thumbnailImage', 'thumbnail', 'media.0.thumbnail', 'media.0.photo_image.uri', 'images.0']),
    views: num(pick(it, ['playCount', 'videoPlayCount', 'videoViewCount', 'viewCount', 'viewsCount', 'views', 'plays'])),
    likes: num(pick(it, ['diggCount', 'likesCount', 'likes', 'reactionsCount', 'likeCount'])),
    comments: num(pick(it, ['commentCount', 'commentsCount', 'comments'])),
    shares: num(pick(it, ['shareCount', 'sharesCount', 'shares'])),
    saves: num(pick(it, ['collectCount', 'savesCount'])),
    duration: durSecs(pick(it, ['videoMeta.duration', 'videoDuration', 'duration', 'lengthSeconds'])),
    date: pick(it, ['createTimeISO', 'timestamp', 'date', 'time', 'publishedAt', 'uploadDate']),
    music: pick(it, ['musicMeta.musicName', 'musicInfo.song_name', 'musicInfo.artist_name']),
    hashtags: (Array.isArray(hashtagsRaw) ? hashtagsRaw : []).map((h) => (typeof h === 'string' ? h : h?.name)).filter(Boolean).slice(0, 15),
  };
  if (typeof post.comments === 'object') post.comments = undefined;
  if (typeof post.thumb === 'object') post.thumb = post.thumb?.url || post.thumb?.uri;
  const eng = (post.likes || 0) + (post.comments || 0) + (post.shares || 0) + (post.saves || 0);
  post.engagement = eng;
  post.er = post.views ? eng / post.views : undefined;
  return post;
}

// Miniaturas: solo CDNs de redes sociales y Apify (evita bloqueos de hotlink y CORS).
const IMAGE_HOSTS = [/tiktokcdn(-\w+)?\.com$/, /tiktokv\.com$/, /cdninstagram\.com$/, /fbcdn\.net$/, /ytimg\.com$/, /ggpht\.com$/, /googleusercontent\.com$/, /apify\.com$/, /apifyusercontent\.com$/];

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/r/')) { try { return await utmRedirect(req, res, url); } catch (e) { console.error(e.message); res.writeHead(500); return res.end(); } }
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
  if (!apiAllowed(req)) return sendJson(res, 403, { error: 'Origen no permitido' });
  try {
    if (!dbReady) return sendJson(res, 503, { error: `Base de datos no disponible: ${dbError || 'iniciando…'}` });
    const user = await sessionUser(getCookie(req, 'ms_sess'));
    if (await authRoutes(req, res, url, user)) return;
    if (!user) return sendJson(res, 401, { error: 'Inicia sesión', login: true });
    if (user.must_change_password) return sendJson(res, 403, { error: 'Debes cambiar tu contraseña antes de continuar', mustChangePassword: true });
    // Rol de solo lectura: no puede lanzar generaciones de pago.
    if (req.method === 'POST' && /^\/api\/(claude|fal|apify)/.test(url.pathname) && !can(user, 'editor')) return sendJson(res, 403, { error: 'Tu rol es de solo lectura' });
    if (await userRoutes(req, res, url, user)) return;
    if (await tenantRoutes(req, res, url, user)) return;
    if (await utmRoutes(req, res, url, user)) return;
    if (await elevenRoutes(req, res, url, user)) return;
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const cc = await claudeCodeStatus();
      return sendJson(res, 200, {
        claudeCode: cc,
        claudeApi: { available: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), model: DEFAULT_MODEL,
          reason: 'Define ANTHROPIC_API_KEY en server/.env para usar la Claude API directamente' },
        fal: { available: !!falKey(), reason: 'Define FAL_KEY en server/.env para usar fal.ai (Seedance, Flux, Recraft…)' },
        apify: { available: !!apifyToken(), reason: 'Define APIFY_TOKEN en server/.env para investigar contenido (TikTok, Reels, Facebook, YouTube)' },
        eleven: { available: elevenAvailable(), reason: 'Define ELEVENLABS_API_KEY en server/.env para voces y efectos de sonido' },
        publicBase: publicBase(),
      });
    }
    if (url.pathname === '/api/claude' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body.prompt || !body.system) return sendJson(res, 400, { error: 'Faltan prompt/system' });
      const fn = body.provider === 'claude-api' ? generateWithClaudeApi : generateWithClaudeCode;
      const t0 = Date.now();
      const out = await fn(body);
      return sendJson(res, 200, { ...out, ms: Date.now() - t0 });
    }
    if (url.pathname === '/api/fal/submit' && req.method === 'POST') {
      if (!falKey()) return sendJson(res, 400, { error: 'Falta FAL_KEY (server/.env)' });
      const { model, input } = await readJson(req);
      if (!/^[\w.-]+(\/[\w.-]+)+$/.test(model || '')) return sendJson(res, 400, { error: 'ID de modelo no válido' });
      const r = await falFetch(`https://queue.fal.run/${model}`, { method: 'POST', body: JSON.stringify(input || {}) });
      falJobs.set(r.request_id, { status_url: r.status_url, response_url: r.response_url, model });
      return sendJson(res, 200, { request_id: r.request_id, queue_position: r.queue_position });
    }
    if (url.pathname === '/api/fal/status' && req.method === 'GET') {
      const job = falJobs.get(url.searchParams.get('id'));
      if (!job) return sendJson(res, 404, { error: 'Trabajo desconocido' });
      const s = await falFetch(job.status_url + '?logs=1');
      if (s.status === 'COMPLETED') {
        const result = await falFetch(job.response_url);
        return sendJson(res, 200, { status: 'COMPLETED', result });
      }
      return sendJson(res, 200, { status: s.status, queue_position: s.queue_position, logs: (s.logs || []).slice(-3).map((l) => l.message) });
    }
    if (url.pathname === '/api/fetch' && req.method === 'GET') {
      // Descarga un resultado de fal (evita problemas de CORS). Solo dominios de fal.
      const target = new URL(url.searchParams.get('url'));
      if (target.protocol !== 'https:' || !MEDIA_HOSTS.some((re) => re.test(target.hostname))) return sendJson(res, 400, { error: 'Dominio no permitido' });
      const r = await fetch(target);
      if (!r.ok) return sendJson(res, 502, { error: `Descarga falló (${r.status})` });
      res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (url.pathname === '/api/apify/platforms' && req.method === 'GET') {
      return sendJson(res, 200, Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [k, { label: v.label, modes: v.modes }])));
    }
    if (url.pathname === '/api/apify/run' && req.method === 'POST') {
      if (!apifyToken()) return sendJson(res, 400, { error: 'Falta APIFY_TOKEN (server/.env)' });
      const b = await readJson(req);
      const P = PLATFORMS[b.platform];
      if (!P) return sendJson(res, 400, { error: 'Plataforma no soportada' });
      const mode = P.modes.includes(b.mode) ? b.mode : P.modes[0];
      const query = String(b.query || '').trim().slice(0, 300);
      if (!query) return sendJson(res, 400, { error: 'Escribe una búsqueda, hashtag o perfil' });
      const limit = Math.max(1, Math.min(200, b.limit | 0 || 20));
      const budget = Math.max(0.05, Math.min(20, +b.budgetUsd || 0.5));
      const [actor, input] = P.build({ mode, query, limit, days: +b.days || 0, sort: b.sort, shorts: !!b.shorts });
      const qs = new URLSearchParams({ maxItems: String(limit), maxTotalChargeUsd: String(budget) });
      const r = await apifyFetch(`/acts/${actor.replace('/', '~')}/runs?${qs}`, { method: 'POST', body: JSON.stringify(input) });
      apifyRuns.set(r.data.id, { platform: b.platform, datasetId: r.data.defaultDatasetId, limit });
      return sendJson(res, 200, { runId: r.data.id, actor, input, status: r.data.status });
    }
    if (url.pathname === '/api/apify/run' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      const run = apifyRuns.get(id);
      if (!run) return sendJson(res, 404, { error: 'Ejecución desconocida' });
      const r = await apifyFetch(`/actor-runs/${encodeURIComponent(id)}`);
      const st = r.data.status;
      const out = { status: st, costUsd: r.data.usageTotalUsd, itemCount: r.data.stats?.resultCount ?? undefined };
      if (st === 'SUCCEEDED' || ((st === 'ABORTED' || st === 'TIMED-OUT') && url.searchParams.get('partial'))) {
        const items = await apifyFetch(`/datasets/${run.datasetId}/items?clean=true&format=json&limit=${run.limit}`);
        out.items = (Array.isArray(items) ? items : []).filter((it) => !it.error && !it.errorDescription).map((it) => normalize(run.platform, it));
        out.errors = (Array.isArray(items) ? items : []).filter((it) => it.error || it.errorDescription).slice(0, 3).map((it) => it.error || it.errorDescription);
      }
      if (st === 'FAILED') out.error = r.data.statusMessage || 'La ejecución de Apify falló';
      return sendJson(res, 200, out);
    }
    if (url.pathname === '/api/apify/image' && req.method === 'GET') {
      const target = new URL(url.searchParams.get('url'));
      if (target.protocol !== 'https:' || !IMAGE_HOSTS.some((re) => re.test(target.hostname))) return sendJson(res, 400, { error: 'Dominio no permitido' });
      const r = await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) { res.writeHead(r.status); res.end(); return; }
      res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'max-age=3600' });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    sendJson(res, 404, { error: 'Ruta desconocida' });
  } catch (e) {
    console.error(e);
    sendJson(res, e.status && e.status < 600 ? e.status : 500, { error: e.message || String(e) });
  }
});

let dbReady = false, dbError = '';
async function initDb() {
  try {
    await migrate();
    const file = await bootstrapAdmin(here);
    if (file) console.log(`Administrador inicial creado. Credenciales en: ${file}`);
    dbReady = true;
  } catch (e) { dbError = e.message; console.error('MariaDB:', e.message); setTimeout(initDb, 5000); }
}
// Restos de generaciones interrumpidas (por si el proceso se cortó a mitad)
for (const d of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('moho-gen-'))) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
initDb();

server.requestTimeout = 0; // las generaciones pueden tardar varios minutos
server.listen(PORT, process.env.HOST || HOST, () => {
  console.log(`Astrix Studio en http://${HOST}:${PORT}/`);
  console.log(`Claude Code: ${CLAUDE_BIN} · Claude API: ${process.env.ANTHROPIC_API_KEY ? 'clave definida' : 'sin clave'} · fal.ai: ${falKey() ? 'clave definida' : 'sin clave'} · Apify: ${apifyToken() ? 'token definido' : 'sin token'} · ElevenLabs: ${elevenAvailable() ? 'clave definida' : 'sin clave'}`);
});
